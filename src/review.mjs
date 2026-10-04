const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const rate = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const arch = value => ({ amd64: 'x86_64', x86_64: 'x86_64', arm64: 'arm64', aarch64: 'arm64' })[value?.toLowerCase()];

// AWS marks omitted optional/computed fields as unknown on creates. Consult the
// configuration so omitted defaults do not look like unresolved explicit inputs.
function withConfiguredDefaults(plan) {
  const configured = new Map();
  function walk(module, prefix = '') {
    for (const resource of module?.resources ?? []) configured.set(prefix + resource.address, resource.expressions ?? {});
    for (const [name, call] of Object.entries(module?.module_calls ?? {})) walk(call.module, `${prefix}module.${name}.`);
  }
  walk(plan.configuration?.root_module);
  return { ...plan, resource_changes: plan.resource_changes?.map(resource => {
    const address = resource.address.replace(/\[(?:\d+|"(?:\\.|[^"\\])*")\]/g, '');
    const expressions = configured.get(address);
    if (resource.type !== 'aws_instance' || !expressions || resource.change.after_unknown === true) return resource;
    const unknown = { ...resource.change.after_unknown };
    for (const field of ['instance_market_options', 'tenancy', 'host_id', 'cpu_options']) {
      if (!(field in expressions)) delete unknown[field];
    }
    return { ...resource, change: { ...resource.change, after_unknown: unknown } };
  }) };
}

export function comparePlans(base, proposed) {
  function resources(plan) {
    if (!String(plan.format_version ?? '').startsWith('1.') || !plan.planned_values || plan.errored) {
      throw new Error('Both comparison inputs must be successful Terraform JSON plans');
    }
    plan = withConfiguredDefaults(plan);
    const found = new Map();
    const unknowns = new Map((plan.resource_changes ?? []).map(r => [r.address, r.change.after_unknown]));
    function walk(module) {
      for (const resource of module?.resources ?? []) {
        if (resource.mode === 'managed') found.set(resource.address, { ...resource, unknown: unknowns.get(resource.address) ?? {} });
      }
      for (const child of module?.child_modules ?? []) walk(child);
    }
    walk(plan.planned_values.root_module);
    return found;
  }
  const before = resources(base), after = resources(proposed);
  const changes = [];
  for (const address of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(address), b = after.get(address);
    if (a && b && JSON.stringify(a.values) === JSON.stringify(b.values) && JSON.stringify(a.unknown) === JSON.stringify(b.unknown)) continue;
    changes.push({ address, type: (b ?? a).type, mode: 'managed', change: {
      actions: !a ? ['create'] : !b ? ['delete'] : ['update'],
      before: a?.values ?? null, after: b?.values ?? null,
      before_unknown: a?.unknown ?? {}, after_unknown: b?.unknown ?? {},
    } });
  }
  return { format_version: '1.2', planned_values: proposed.planned_values, resource_changes: changes,
    complete: base.complete !== false && proposed.complete !== false && !base.deferred_changes?.length && !proposed.deferred_changes?.length };
}

function instance(values, unknown, options) {
  if (!values || unknown === true || unknown?.instance_type || !values.instance_type) {
    throw new Error('Instance type is unknown until apply');
  }
  if (unknown?.instance_market_options || unknown?.tenancy || unknown?.host_id) {
    throw new Error('Purchase type or tenancy is unknown until apply');
  }
  if ((values.tenancy && values.tenancy !== 'default') || values.host_id) {
    throw new Error('Dedicated tenancy and hosts are not supported');
  }
  if (unknown?.region || unknown?.availability_zone) {
    // An explicitly configured fallback can resolve an unknown subnet-derived zone.
    if (!options.region && !values.region) throw new Error('Region is unknown; set aws-region');
  }
  const zone = typeof values.availability_zone === 'string' ? values.availability_zone : '';
  const region = values.region || values.arn?.split(':')[3]
    || zone.match(/^([a-z]{2}(?:-[a-z]+)+-\d+)/)?.[1] || options.region;
  if (!region) throw new Error('Region is missing; set aws-region');
  const spot = values.instance_market_options?.[0]?.market_type === 'spot';
  if (spot && (!zone || unknown?.availability_zone)) throw new Error('Spot pricing requires a known availability zone');
  return {
    provider: 'AWS', service: 'AmazonEC2', region,
    availability_zone: zone,
    instance_type: values.instance_type,
    operating_system: options.os,
    usage_type: spot ? 'SPOT_PREEMPTIBLE' : 'ONDEMAND',
    // The HTTP handler requires a nonzero VM even for exact fixed-size lookups.
    // Resolution uses instance_type; sizing for recommendations comes from the returned catalog row.
    vm: { cpu_cores: 1, ram_gb: 1 },
    fallback_to_base_pricing: false,
  };
}

function validatePrice(price, requested) {
  if (!price || !rate(price.cost_per_hour) || !positive(price.cpu_cores) || !positive(price.ram_gb)) {
    throw new Error('Catalog price or instance capacity is missing');
  }
  for (const field of ['provider', 'region', 'service', 'instance_type', 'operating_system', 'usage_type']) {
    if (!same(price[field], requested[field])) throw new Error(`Catalog ${field} does not match the requested instance`);
  }
  if (requested.usage_type === 'SPOT_PREEMPTIBLE' && !same(price.availability_zone, requested.availability_zone)) {
    throw new Error('Catalog availability zone does not match the requested spot instance');
  }
  return price;
}

function compatible(candidate, current) {
  return candidate && rate(candidate.cost_per_hour) && candidate.cost_per_hour < current.cost_per_hour
    && candidate.instance_type && !same(candidate.instance_type, current.instance_type)
    && ['provider', 'region', 'service', 'operating_system', 'usage_type'].every(k => same(candidate[k], current[k]))
    && arch(current.architecture) && arch(candidate.architecture) === arch(current.architecture)
    && positive(candidate.cpu_cores) && candidate.cpu_cores >= current.cpu_cores
    && positive(candidate.ram_gb) && candidate.ram_gb >= current.ram_gb
    && candidate.gpu_count === 0
    && (current.usage_type.toUpperCase() !== 'SPOT_PREEMPTIBLE' || same(candidate.availability_zone, current.availability_zone));
}

export async function reviewPlan(plan, api, options) {
  if (!String(plan.format_version ?? '').startsWith('1.') || !plan.planned_values || plan.errored) {
    throw new Error('Expected a successful terraform show -json plan with format_version 1.x');
  }
  if (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes)) {
    throw new Error('Invalid Terraform resource_changes');
  }
  plan = withConfiguredDefaults(plan);
  const rows = [];
  const skipped = [];
  const warnings = [];
  if (plan.complete === false || plan.deferred_changes?.length) warnings.push('Terraform reports an incomplete or deferred plan.');
  for (const resource of plan.resource_changes ?? []) {
    if (resource.mode !== 'managed' || resource.change?.actions?.every(a => a === 'no-op' || a === 'read')) continue;
    if (!resource.change?.actions?.length) throw new Error('A resource change is missing its actions');
    if (resource.type !== 'aws_instance') {
      skipped.push({ address: resource.address, reason: `${resource.type} is outside EC2 instance coverage` });
      continue;
    }
    if (rows.length >= 100) {
      skipped.push({ address: resource.address, reason: '100-instance review limit reached' });
      continue;
    }
    const row = { address: resource.address, actions: resource.change.actions, notes: [] };
    for (const side of ['before', 'after']) {
      const values = resource.change[side];
      // Only explicit creation/deletion makes an absent side a known zero.
      const absent = side === 'before' ? row.actions.includes('create') : row.actions.includes('delete');
      if (values === null && absent) {
        row[side] = { monthly: 0, type: '—' };
        continue;
      }
      try {
        const requested = instance(values, resource.change[`${side}_unknown`] ?? {}, options);
        const price = validatePrice(await api('/pricing/compute', requested), requested);
        row[side] = { monthly: price.cost_per_hour * options.hours, type: requested.instance_type, requested, price };
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        row[side] = { monthly: null, type: values?.instance_type ?? '?' };
        row.notes.push(`${side}: ${error.message}`);
      }
    }
    row.delta = row.before.monthly !== null && row.after.monthly !== null
      ? row.after.monthly - row.before.monthly : null;
    const current = row.after.price;
    if (current && current.cost_per_hour > 0) {
      if (!arch(current.architecture) || current.gpu_count !== 0 || resource.change.after?.cpu_options?.length || resource.change.after_unknown?.cpu_options) {
        row.notes.push('Alternatives skipped: architecture, GPU, or custom CPU compatibility needs review');
      } else {
        const vm = { cpu_cores: current.cpu_cores, ram_gb: current.ram_gb };
        try {
          const results = await api('/recommendations/compute', {
            instance: { ...row.after.requested, vm }, usage: vm,
            predicates: {
              providers: [current.provider], regions: [current.region], services: [current.service],
              usage_types: [current.usage_type], operating_systems: [current.operating_system],
              ...(current.usage_type.toUpperCase() === 'SPOT_PREEMPTIBLE' ? { availability_zones: [current.availability_zone] } : {}),
            },
            include_metadata: false,
          });
          if (!Array.isArray(results)) throw new Error('Invalid recommendations response');
          const candidates = results.map(r => r.pricing).filter(p => compatible(p, current))
            .filter(p => (current.cost_per_hour - p.cost_per_hour) * options.hours >= options.minimumSavings)
            .sort((a, b) => a.cost_per_hour - b.cost_per_hour);
          if (candidates.length) {
            row.alternative = { type: candidates[0].instance_type, monthly: candidates[0].cost_per_hour * options.hours,
              savings: (current.cost_per_hour - candidates[0].cost_per_hour) * options.hours };
          } else {
            row.notes.push('No compatible cheaper candidate returned above the savings threshold');
          }
        } catch (error) {
          if (error.status === 401 || error.status === 403) throw error;
          row.notes.push(error.status === 404 ? 'No cheaper candidate returned' : `Alternatives unavailable: ${error.message}`);
        }
        if (!row.alternative && options.candidateTypes?.length) {
          const candidates = [];
          for (const type of new Set(options.candidateTypes)) {
            if (same(type, current.instance_type)) continue;
            try {
              const requested = { ...row.after.requested, instance_type: type };
              const candidate = validatePrice(await api('/pricing/compute', requested), requested);
              if (compatible(candidate, current) && (current.cost_per_hour - candidate.cost_per_hour) * options.hours >= options.minimumSavings) candidates.push(candidate);
            } catch (error) {
              if (error.status === 401 || error.status === 403) throw error;
              row.notes.push(`Candidate ${type}: ${error.message}`);
            }
          }
          candidates.sort((a, b) => a.cost_per_hour - b.cost_per_hour);
          if (candidates.length) row.alternative = { type: candidates[0].instance_type,
            monthly: candidates[0].cost_per_hour * options.hours,
            savings: (current.cost_per_hour - candidates[0].cost_per_hour) * options.hours };
          row.notes.push('Fallback: compared the explicitly configured candidate list using live pricing lookups; this is not an exhaustive catalog search');
        }
      }
    }
    rows.push(row);
  }
  const priced = rows.filter(row => row.delta !== null);
  const before = priced.reduce((sum, row) => sum + row.before.monthly, 0);
  const after = priced.reduce((sum, row) => sum + row.after.monthly, 0);
  return { rows, skipped, warnings, before, after, delta: after - before, pricedCount: priced.length,
    complete: !skipped.length && !warnings.length && priced.length === rows.length };
}

export function commentMarker(key) {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) throw new Error('comment-key must be 1–80 letters, digits, dots, underscores, or hyphens');
  return `<!-- costgraph-pricing:${key} -->`;
}

const escape = value => String(value).slice(0, 250).replace(/[&<>|`\r\n@]/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', '`': '&#96;', '\r': ' ', '\n': ' ', '@': '&#64;',
})[c]);
const money = value => value === null ? 'Unavailable' : `$${value.toFixed(2)}`;
const signed = value => value === null ? 'Unavailable' : `${value < 0 ? '−' : '+'}${money(Math.abs(value))}`;

export function renderReview(result, options) {
  const lines = [commentMarker(options.commentKey), '## CostGraph · PR cost impact', ''];
  if (!result.rows.length && !result.skipped.length) {
    lines.push('No changed managed resources to price.');
  } else if (result.pricedCount) {
    lines.push(`**${signed(result.delta)}/month** across ${result.pricedCount} fully priced changed EC2 instance(s).`, '',
      `${money(result.before)}/month before → ${money(result.after)}/month after.`);
  } else {
    lines.push('**Cost impact unavailable:** no changed EC2 instances could be fully priced.');
  }
  if (!result.complete) lines.push('', '**Partial estimate.** Unpriced and unsupported changes are excluded from the totals.');
  lines.push('', `USD estimates at ${options.hours} running hours/month; EC2 OS: ${escape(options.os)}.`,
    'Compute only. Excludes disks, network, taxes, discounts, commitments, and temporary replacement overlap.');
  if (options.comparison) lines.push('Comparison: base branch desired instances → PR branch desired instances. No infrastructure deployment required.');
  if (result.rows.length) {
    lines.push('', '| Resource | Instance change | Before / mo | After / mo | Change / mo |', '|---|---|---:|---:|---:|');
    for (const row of result.rows.slice(0, 40)) {
      lines.push(`| ${escape(row.address)} | ${escape(row.before.type)} → ${escape(row.after.type)} | ${money(row.before.monthly)} | ${money(row.after.monthly)} | ${signed(row.delta)} |`);
    }
    if (result.rows.length > 40) lines.push('', `${result.rows.length - 40} more EC2 changes included in totals; table limited to 40 rows.`);
  }
  const alternatives = result.rows.filter(row => row.alternative);
  if (alternatives.length) {
    lines.push('', '### Cheaper candidates', '', '| Resource | Proposed → Alternative | Alternative / mo | Potential saving / mo |', '|---|---|---:|---:|');
    for (const row of alternatives.slice(0, 25)) {
      lines.push(`| ${escape(row.address)} | ${escape(row.after.type)} → ${escape(row.alternative.type)} | ${money(row.alternative.monthly)} | ${money(row.alternative.savings)} |`);
    }
    lines.push('', 'Candidates preserve region, purchase type, OS, architecture, and at least the same vCPU/RAM. Check workload performance, AMI support, networking, and local storage before changing. Savings are relative to the proposed instance and are not applied to the PR total.');
  }
  const notes = [...result.warnings, ...result.skipped.map(s => `${s.address}: ${s.reason}`),
    ...result.rows.flatMap(r => r.notes.map(n => `${r.address}: ${n}`))];
  if (notes.length) {
    lines.push('', '<details><summary>Coverage and pricing notes</summary>', '', ...notes.slice(0, 40).map(n => `- ${escape(n)}`));
    if (notes.length > 40) lines.push(`- ${notes.length - 40} additional notes omitted.`);
    lines.push('', '</details>');
  }
  return lines.join('\n');
}
