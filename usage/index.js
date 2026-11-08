'use strict';

const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const agentVersion = 'v1.10.2';
const agentSHA256 = {
  amd64: 'ce6e8c725fc250604f400a62130daf1417a31d680b00ef8026c0c4f824339224',
  arm64: 'dcddf396e74b4c3d73f5e34a215756e5d072ce2a4a2ca70bc52b6e11fd09acb6',
};
const agentBase = 'https://costgraph-agent-releases.s3.us-east-1.amazonaws.com';
const usagePrefix = 'costgraph-usage ';
const finalWaitMs = 10000;

const warn = (message) => console.log(`::warning title=CostGraph CI usage::${message}`);
const info = (message) => console.log(message);
const mask = (secret) => console.log(`::add-mask::${secret}`);

function saveState(name, value) {
  fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}\n`);
}

function apiURL() {
  return (process.env['INPUT_API-URL'] || 'https://api.costgraph.ai').replace(/\/+$/, '');
}

function canSudo() {
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

async function start() {
  saveState('isPost', 'true');
  if (process.platform !== 'linux') {
    info(`CostGraph CI usage runs on Linux runners only; skipped on ${process.platform}.`);
    return;
  }
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    warn("Add 'permissions: id-token: write' to this job so CostGraph CI usage can sign in with GitHub; usage is not measured.");
    return;
  }
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const expected = agentSHA256[arch];
  if (!expected) {
    info(`CostGraph CI usage has no agent for ${process.arch} runners; skipped.`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'costgraph-usage-'));
  const asset = `costgraph-agent_linux_${arch}.tar.gz`;
  const res = await fetch(`${agentBase}/${agentVersion}/${asset}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`could not download ${asset} (${res.status})`);
  const archive = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
  fs.writeFileSync(path.join(dir, asset), archive);
  const untar = spawnSync('tar', ['-xzf', asset, 'costgraph-agent'], { cwd: dir, stdio: 'inherit' });
  if (untar.status !== 0) throw new Error(`could not unpack ${asset}`);

  const agent = path.join(dir, 'costgraph-agent');
  const probe = spawnSync(agent, ['ci', '-h'], { stdio: 'ignore', timeout: 10000 });
  if (probe.status !== 0) {
    warn(`The usage agent cannot run on this runner or container (${probe.error ? probe.error.code : `exit ${probe.status ?? probe.signal}`}), so usage is not measured.`);
    return;
  }

  const output = path.join(dir, 'usage.json');
  const args = [agent, 'ci', '--output', output, '--source', 'action',
    '--run-id', process.env.GITHUB_RUN_ID || '0', '--run-attempt', process.env.GITHUB_RUN_ATTEMPT || '0'];
  const privileged = canSudo();
  const log = fs.openSync(path.join(dir, 'agent.log'), 'a');
  const child = privileged
    ? spawn('sudo', ['-n', ...args], { detached: true, stdio: ['ignore', log, log] })
    : spawn(args[0], args.slice(1), { detached: true, stdio: ['ignore', log, log] });
  child.on('error', (err) => warn(`The usage agent did not start (${err.code}); usage is not measured.`));
  child.unref();
  if (!child.pid) return;
  saveState('pid', child.pid);
  saveState('dir', dir);
  saveState('privileged', privileged);
  info(`CostGraph CI usage is measuring this job${privileged ? '' : ' without sudo, so network destinations are not captured'}.`);
}

function stop(pid, privileged) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (err.code === 'ESRCH') return;
    if (!privileged) throw err;
    spawnSync('sudo', ['-n', 'kill', '-TERM', String(pid)], { stdio: 'ignore', timeout: 5000 });
  }
}

function readUsage(file) {
  try {
    const line = fs.readFileSync(file, 'utf8').trim().split('\n').pop();
    return line.startsWith(usagePrefix) ? line.slice(usagePrefix.length) : line;
  } catch {
    return '';
  }
}

async function finalUsage(file) {
  const deadline = Date.now() + finalWaitMs;
  let usage = readUsage(file);
  while (!usage.includes('"final":true') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    usage = readUsage(file);
  }
  return usage;
}

async function signIn(api) {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken } = process.env;
  const oidc = await fetch(`${url}&audience=${encodeURIComponent(api)}`, {
    headers: { Authorization: `bearer ${requestToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!oidc.ok) throw new Error(`GitHub did not issue a sign-in token (${oidc.status})`);
  const { value } = await oidc.json();
  mask(value);
  const res = await fetch(`${api}/api/v1/ci/github-actions/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: value }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `CostGraph did not accept this workflow's GitHub sign-in (${res.status})`);
  mask(body.data.token);
  return body.data.token;
}

async function finish() {
  const { STATE_pid: pid, STATE_dir: dir, STATE_privileged: privileged } = process.env;
  if (!pid) return;
  stop(Number(pid), privileged === 'true');
  const usage = await finalUsage(path.join(dir, 'usage.json'));
  if (!usage) {
    warn('The usage agent wrote no reading for this job, so nothing was sent.');
    return;
  }
  const api = apiURL();
  const token = await signIn(api);
  const res = await fetch(`${api}/api/v1/tenant/ci/autopilot/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': token },
    body: usage,
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `CostGraph answered ${res.status}`);
  const kept = body.data && body.data.stored;
  info(kept ? 'CostGraph stored the usage of this job.' : 'CostGraph already has a newer or measured-by-runner reading for this job.');
}

(process.env.STATE_isPost ? finish : start)().catch((err) => warn(`${err.message.replace(/\.$/, '')}. The job is not affected.`));
