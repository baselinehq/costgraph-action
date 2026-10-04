import test from 'node:test';
import assert from 'node:assert/strict';
import { pricingClient, upsertComment } from '../src/api.mjs';

test('pricing uses the API key contract, disables redirects and caches identical requests', async () => {
  const calls = [];
  const client = pricingClient({ url: 'https://pricing.example.com', apiKey: 'test-key', fetchImpl: async (...args) => {
    calls.push(args);
    return Response.json({ cost_per_hour: 0.1 });
  } });
  await Promise.all([client('/pricing/compute', { instance_type: 'test' }), client('/pricing/compute', { instance_type: 'test' })]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://pricing.example.com/pricing/compute');
  assert.equal(calls[0][1].headers['X-API-Key'], 'test-key');
  assert.equal(calls[0][1].redirect, 'error');
});

test('API errors do not echo response bodies or leak request credentials', async () => {
  const client = pricingClient({ url: 'https://pricing.example.com', apiKey: 'secret',
    fetchImpl: async () => new Response('secret and other sensitive content', { status: 403 }) });
  await assert.rejects(client('/pricing/compute', {}), { message: 'CostGraph returned HTTP 403' });
  assert.throws(() => pricingClient({ url: 'http://pricing.example.com', apiKey: 'secret' }), /HTTPS/);
});

test('transient rate limits retry reads', async () => {
  let calls = 0;
  const client = pricingClient({ url: 'https://pricing.example.com', apiKey: 'key', fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429 }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await client('/pricing/compute', {}), { ok: true });
  assert.equal(calls, 2);
});

const config = { apiUrl: 'https://api.github.com', repository: 'test/repo', number: 42, token: 'test-token',
  marker: '<!-- costgraph-pricing:default -->', body: '<!-- costgraph-pricing:default -->\nReport' };

test('finds existing bot comments across pages and updates instead of spamming', async () => {
  const calls = [];
  await upsertComment({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, id) => ({ id, body: config.marker, user: { type: 'User' } })));
    if (new URL(url).searchParams.get('page') === '2') return Response.json([{ id: 123, body: config.marker, user: { type: 'Bot' } }]);
    return Response.json({ id: 123 });
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.method, 'PATCH');
  assert.match(calls[2].url, /issues\/comments\/123$/);
  assert.equal(JSON.parse(calls[2].init.body).body, config.body);
});

test('creates a comment when none exists, scoped by project marker', async () => {
  const calls = [];
  await upsertComment({ ...config, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return init.method === 'GET'
      ? Response.json([{ id: 123, body: '<!-- costgraph-pricing:another-project -->', user: { type: 'Bot' } }])
      : Response.json({ id: 456 });
  } });
  assert.equal(calls[1].init.method, 'POST');
  assert.match(calls[1].url, /issues\/42\/comments$/);
});
