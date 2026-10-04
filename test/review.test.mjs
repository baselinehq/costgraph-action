import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPlan, renderReview, comparePlans } from '../src/review.mjs';
import { ApiError } from '../src/api.mjs';

const options = { region: 'us-east-1', os: 'linux', hours: 730, minimumSavings: 1, commentKey: 'default' };
const values = type => ({ instance_type: type, availability_zone: 'us-east-1a', tenancy: 'default' });
const change = (address, before, after, extra = {}) => ({ address, mode: 'managed', type: 'aws_instance',
  change: { actions: before === null ? ['create'] : after === null ? ['delete'] : ['update'],
    before: before === null ? null : values(before), after: after === null ? null : values(after), after_unknown: {}, ...extra } });
const plan = resources => ({ format_version: '1.2', planned_values: {}, resource_changes: resources });
const prices = { old: 0.1, proposed: 0.2, cheaper: 0.15 };
const price = (type, overrides = {}) => ({ provider: 'AWS', service: 'AmazonEC2', region: 'us-east-1',
  operating_system: 'Linux', usage_type: 'ONDEMAND', architecture: 'x86_64', gpu_count: 0,
  instance_type: type, cpu_cores: 4, ram_gb: 16, cost_per_hour: prices[type], ...overrides });
function api(calls = []) {
  return async (path, body) => {
    calls.push({ path, body });
    return path === '/pricing/compute' ? price(body.instance_type) : [{ pricing: price('cheaper') }];
  };
}

test('prices creates, deletes, replacements and expanded count instances without double counting', async () => {
  const result = await reviewPlan(plan([
    change('aws_instance.web[0]', null, 'proposed'),
    change('aws_instance.web[1]', null, 'proposed'),
    change('aws_instance.old', 'old', null),
    change('aws_instance.replaced', 'old', 'proposed', { actions: ['delete', 'create'] }),
    change('aws_instance.unchanged', 'old', 'old', { actions: ['no-op'] }),
  ]), api(), options);
  assert.equal(result.rows.length, 4);
  assert.equal(result.before, 146);
  assert.equal(result.after, 438);
  assert.equal(result.delta, 292);
  assert.equal(result.complete, true);
  assert.ok(Math.abs(result.rows[0].alternative.savings - 36.5) < 1e-8);
});

test('recommendations use catalog sizing and same-provider, region and purchase-type constraints', async () => {
  const calls = [];
  await reviewPlan(plan([change('aws_instance.web', 'old', 'proposed')]), api(calls), options);
  const request = calls.find(c => c.path === '/recommendations/compute').body;
  assert.deepEqual(request.usage, { cpu_cores: 4, ram_gb: 16 });
  assert.deepEqual(request.instance.vm, request.usage);
  assert.deepEqual(request.predicates.providers, ['AWS']);
  assert.deepEqual(request.predicates.regions, ['us-east-1']);
  assert.deepEqual(request.predicates.usage_types, ['ONDEMAND']);
});

test('never treats a missing price as zero or includes one side of an unpriced change in totals', async () => {
  const result = await reviewPlan(plan([
    change('aws_instance.partial', 'missing', 'proposed'),
    change('aws_instance.ok', null, 'proposed'),
  ]), async (path, body) => {
    if (body.instance_type === 'missing') throw new ApiError('CostGraph', 404);
    return api()(path, body);
  }, options);
  assert.equal(result.rows[0].before.monthly, null);
  assert.equal(result.rows[0].delta, null);
  assert.equal(result.before, 0);
  assert.equal(result.after, 146);
  assert.equal(result.pricedCount, 1);
  assert.equal(result.complete, false);
  assert.match(renderReview(result, options), /Partial estimate/);
  assert.match(renderReview(result, options), /Unavailable/);
});

test('unknown instance sizes, dedicated hosts, spot without zone and unsupported resources are explicit', async () => {
  const result = await reviewPlan(plan([
    change('aws_instance.unknown', null, 'proposed', { after_unknown: { instance_type: true } }),
    change('aws_instance.dedicated', null, 'proposed', { after: { ...values('proposed'), tenancy: 'dedicated' } }),
    change('aws_instance.spot', null, 'proposed', { after: { instance_type: 'proposed', instance_market_options: [{ market_type: 'spot' }] } }),
    { ...change('aws_autoscaling_group.fleet', null, 'proposed'), type: 'aws_autoscaling_group' },
  ]), api(), options);
  assert.equal(result.pricedCount, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(renderReview(result, options), /Cost impact unavailable/);
  assert.match(renderReview(result, options), /Spot pricing requires/);
  assert.equal(result.complete, false);
});

test('unknown purchase type is never priced as on-demand', async () => {
  const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed', {
    after_unknown: { instance_market_options: true },
  })]), api(), options);
  assert.equal(result.pricedCount, 0);
});

test('rejects wrong architecture, undersized, cross-region, spot, GPU and zero-information candidates', async () => {
  for (const overrides of [
    { architecture: 'arm64' }, { cpu_cores: 2 }, { ram_gb: 8 }, { region: 'eu-west-1' },
    { usage_type: 'SPOT_PREEMPTIBLE' }, { gpu_count: 1 }, { architecture: '' }, { cost_per_hour: null },
  ]) {
    const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async (path, body) =>
      path === '/pricing/compute' ? price(body.instance_type) : [{ pricing: price('cheaper', overrides) }], options);
    assert.equal(result.rows[0].alternative, undefined, JSON.stringify(overrides));
  }
});

test('accepts architecture aliases and calculates savings from rates with the configured hours', async () => {
  const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async path =>
    path === '/pricing/compute' ? price('proposed') : [{ pricing: price('cheaper', { architecture: 'amd64' }), savings: { amount_per_month: 99999 } }],
  { ...options, hours: 100 });
  assert.equal(result.after, 20);
  assert.ok(Math.abs(result.rows[0].alternative.savings - 5) < 1e-8);
});

test('rejects base fallback and mismatched catalog responses', async () => {
  for (const overrides of [{ provider: 'Base' }, { instance_type: 'other' }, { operating_system: 'Windows' }, { cost_per_hour: null }]) {
    const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async () => price('proposed', overrides), options);
    assert.equal(result.pricedCount, 0);
  }
});

test('auth failures fail the action, recommendation failures retain cost impact', async () => {
  await assert.rejects(reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async () => {
    throw new ApiError('CostGraph', 401);
  }, options), /401/);
  const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async path => {
    if (path === '/recommendations/compute') throw new ApiError('CostGraph', 503);
    return price('proposed');
  }, options);
  assert.equal(result.after, 146);
  assert.match(renderReview(result, options), /Alternatives unavailable/);
});

test('uses known resource region ahead of fallback, supports local zones and requires a region', async () => {
  const calls = [];
  await reviewPlan(plan([change('aws_instance.web', null, 'proposed', { after: { ...values('proposed'), availability_zone: 'us-east-1-bos-1a' } })]), api(calls), { ...options, region: 'eu-west-1' });
  assert.equal(calls[0].body.region, 'us-east-1');
  const missing = await reviewPlan(plan([change('aws_instance.web', null, 'proposed', { after: { instance_type: 'proposed' } })]), api(), { ...options, region: '' });
  assert.equal(missing.pricedCount, 0);
});

test('spot lookup and recommendations stay in the same availability zone', async () => {
  const calls = [];
  const spotPlan = plan([change('aws_instance.web', null, 'proposed', { after: { ...values('proposed'), instance_market_options: [{ market_type: 'spot' }] } })]);
  const result = await reviewPlan(spotPlan, async (path, body) => {
    calls.push(body);
    const fields = { usage_type: 'SPOT_PREEMPTIBLE', availability_zone: 'us-east-1a' };
    return path === '/pricing/compute' ? price('proposed', fields) : [{ pricing: price('cheaper', fields) }];
  }, options);
  assert.deepEqual(calls[1].predicates.availability_zones, ['us-east-1a']);
  assert.ok(result.rows[0].alternative);
});

test('rejects state JSON and errored plans; incomplete plans cannot report complete coverage', async () => {
  await assert.rejects(reviewPlan({ format_version: '1.0', values: {} }, api(), options), /Expected/);
  await assert.rejects(reviewPlan({ ...plan([]), errored: true }, api(), options), /Expected/);
  const result = await reviewPlan({ ...plan([]), complete: false }, api(), options);
  assert.equal(result.complete, false);
});

test('empty plans are handled and PR-controlled text cannot inject HTML or mentions', async () => {
  const empty = await reviewPlan(plan([]), api(), options);
  assert.match(renderReview(empty, options), /No changed managed resources/);
  const result = await reviewPlan(plan([change('aws_instance.<img>|@everyone', null, 'proposed')]), api(), options);
  const body = renderReview(result, options);
  assert.ok(!body.includes('<img>'));
  assert.ok(!body.includes('@everyone'));
  assert.ok(body.includes('&#124;'));
});

test('base-plan comparison prices changed desired inventory rather than treating both branches as new deployments', async () => {
  const desired = items => ({ format_version: '1.2', planned_values: { root_module: { child_modules: [{
    resources: items.map(([address, type]) => ({ address, mode: 'managed', type: 'aws_instance', values: values(type) })),
  }] } }, resource_changes: [] });
  const base = desired([['module.api.aws_instance.web[0]', 'old'], ['module.api.aws_instance.web[1]', 'old']]);
  const head = desired([['module.api.aws_instance.web[0]', 'proposed'], ['module.api.aws_instance.web[1]', 'proposed'], ['module.api.aws_instance.web[2]', 'proposed']]);
  const result = await reviewPlan(comparePlans(base, head), api(), options);
  assert.equal(result.before, 146);
  assert.equal(result.after, 438);
  assert.equal(result.delta, 292);
  assert.equal(result.complete, true);
  assert.equal(comparePlans(base, base).resource_changes.length, 0);
});

test('base-plan comparisons preserve unknown baseline values and report removals', async () => {
  const base = { format_version: '1.2', planned_values: { root_module: { resources: [
    { address: 'aws_instance.old', type: 'aws_instance', mode: 'managed', values: values('old') },
  ] } }, resource_changes: [change('aws_instance.old', null, 'old', { after_unknown: { instance_type: true } })] };
  const result = await reviewPlan(comparePlans(base, plan([])), api(), options);
  assert.equal(result.rows[0].after.monthly, 0);
  assert.equal(result.rows[0].before.monthly, null);
  assert.equal(result.complete, false);
});

test('explicit candidates are priced when recommendations fail and still enforce compatibility', async () => {
  const result = await reviewPlan(plan([change('aws_instance.web', null, 'proposed')]), async (path, body) => {
    if (path === '/recommendations/compute') throw new ApiError('CostGraph', 500);
    if (body.instance_type === 'arm') return price('arm', { architecture: 'arm64', cost_per_hour: 0.05 });
    return price(body.instance_type);
  }, { ...options, candidateTypes: ['cheaper', 'arm'] });
  assert.equal(result.rows[0].alternative.type, 'cheaper');
  assert.match(renderReview(result, options), /not an exhaustive catalog search/);
  assert.equal(result.after, 146);
});
