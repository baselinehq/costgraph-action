import { readFile } from 'node:fs/promises';
import { reviewPlan, renderReview } from '../src/review.mjs';

const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8'));
const options = { region: 'us-east-1', os: 'linux', hours: 730, minimumSavings: 1, commentKey: 'demo' };
// Illustrative fixture prices only: this demo makes no network calls.
const rows = {
  'm5.large': { cpu_cores: 2, ram_gb: 8, cost_per_hour: 0.1 },
  'm5.xlarge': { cpu_cores: 4, ram_gb: 16, cost_per_hour: 0.2 },
  'm6a.xlarge': { cpu_cores: 4, ram_gb: 16, cost_per_hour: 0.15 },
};
const price = type => ({ provider: 'AWS', service: 'AmazonEC2', region: 'us-east-1', operating_system: 'Linux',
  usage_type: 'ONDEMAND', architecture: 'x86_64', gpu_count: 0, instance_type: type, ...rows[type] });
const api = async (path, body) => path === '/pricing/compute' ? price(body.instance_type) : [{ pricing: price('m6a.xlarge') }];
console.log('Demo only — illustrative prices.\n');
console.log(renderReview(await reviewPlan(plan, api, options), options));
