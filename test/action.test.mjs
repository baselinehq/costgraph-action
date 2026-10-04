import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('action entrypoint reads GitHub inputs, prices the plan, writes outputs and posts its report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'costgraph-action-test-'));
  try {
    const summary = join(directory, 'summary.md');
    const outputs = join(directory, 'outputs.txt');
    const comment = join(directory, 'comment.json');
    const event = join(directory, 'event.json');
    const mock = join(directory, 'mock.mjs');
    await writeFile(event, JSON.stringify({ pull_request: { number: 42 } }));
    await writeFile(mock, `
      import assert from 'node:assert/strict';
      import { writeFile } from 'node:fs/promises';
      globalThis.fetch = async (url, init) => {
        if (url.startsWith('https://pricing.example.com')) {
          assert.equal(init.headers['X-API-Key'], 'fixture-key');
          const body = JSON.parse(init.body);
          if (url.endsWith('/recommendations/compute')) return Response.json([]);
          return Response.json({ provider: 'AWS', service: 'AmazonEC2', region: 'us-east-1',
            operating_system: 'Linux', usage_type: 'ONDEMAND', architecture: 'x86_64', gpu_count: 0,
            cpu_cores: 4, ram_gb: 16, instance_type: body.instance_type,
            cost_per_hour: body.instance_type === 'm5.large' ? 0.1 : 0.2 });
        }
        assert.ok(url.startsWith('https://api.github.com/repos/test/repo/issues/42/comments'));
        assert.equal(init.headers.Authorization, 'Bearer fixture-token');
        if (init.method === 'GET') return Response.json([]);
        await writeFile(process.env.TEST_COMMENT_PATH, init.body);
        return Response.json({ id: 123 });
      };
    `);
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', mock,
      fileURLToPath(new URL('../src/index.mjs', import.meta.url))], {
      env: { ...process.env, 'INPUT_API-KEY': 'fixture-key', 'INPUT_GITHUB-TOKEN': 'fixture-token',
        'INPUT_API-URL': 'https://pricing.example.com',
        'INPUT_PLAN-PATH': fileURLToPath(new URL('../examples/plan.json', import.meta.url)),
        'INPUT_MONTHLY-HOURS': '100', 'INPUT_COMMENT': 'true', 'INPUT_COMMENT-KEY': 'integration',
        GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'test/repo', GITHUB_API_URL: 'https://api.github.com',
        GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: outputs, TEST_COMMENT_PATH: comment },
      timeout: 10_000,
    });
    assert.match(stdout, /1 fully priced/);
    assert.equal(await readFile(outputs, 'utf8'), 'before-monthly=10.00\nafter-monthly=20.00\nmonthly-delta=10.00\ncomplete=true\n');
    const body = JSON.parse(await readFile(comment, 'utf8')).body;
    assert.match(body, /\+\$10.00\/month/);
    assert.ok(body.startsWith('<!-- costgraph-pricing:integration -->'));
    assert.equal(await readFile(summary, 'utf8'), body + '\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
