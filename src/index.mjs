import { readFile, appendFile } from 'node:fs/promises';
import { pricingClient, upsertComment } from './api.mjs';
import { reviewPlan, renderReview, commentMarker, comparePlans } from './review.mjs';

const input = (key, fallback = '') => process.env[`INPUT_${key.toUpperCase().replaceAll(' ', '_')}`]?.trim() || fallback;
function numberInput(key, fallback, minimum, maximum) {
  const value = Number(input(key, fallback));
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}`);
  return value;
}

try {
  const apiKey = input('api-key');
  if (!apiKey) throw new Error('api-key is required; fork PRs do not receive repository secrets');
  const options = {
    region: input('aws-region'), os: input('operating-system', 'linux'),
    hours: numberInput('monthly-hours', '730', 1, 744),
    minimumSavings: numberInput('minimum-monthly-savings', '1', 0, Number.MAX_SAFE_INTEGER),
    commentKey: input('comment-key', 'default'),
    candidateTypes: input('candidate-instance-types').split(',').map(s => s.trim()).filter(Boolean),
  };
  if (options.candidateTypes.length > 12 || options.candidateTypes.some(s => !/^[a-z0-9-]+\.[a-z0-9]+$/.test(s))) {
    throw new Error('candidate-instance-types must contain at most 12 valid EC2 instance types');
  }
  const marker = commentMarker(options.commentKey);
  const comment = input('comment', 'true');
  if (!['true', 'false'].includes(comment)) throw new Error('comment must be true or false');
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  if (comment === 'true' && (!event.pull_request?.number || !input('github-token'))) {
    throw new Error('Commenting requires a pull_request event and a github-token; use comment: false for summary only');
  }
  let plan = JSON.parse(await readFile(input('plan-path'), 'utf8'));
  if (input('base-plan-path')) {
    plan = comparePlans(JSON.parse(await readFile(input('base-plan-path'), 'utf8')), plan);
    options.comparison = true;
  }
  const api = pricingClient({ url: input('api-url', 'https://pricing.baselinehq.cloud'), apiKey });
  const result = await reviewPlan(plan, api, options);
  const body = renderReview(result, options);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, [
      `before-monthly=${result.pricedCount ? result.before.toFixed(2) : ''}`,
      `after-monthly=${result.pricedCount ? result.after.toFixed(2) : ''}`,
      `monthly-delta=${result.pricedCount ? result.delta.toFixed(2) : ''}`,
      `complete=${result.complete}`, '',
    ].join('\n'));
  }
  if (comment === 'true') {
    await upsertComment({ apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
      repository: process.env.GITHUB_REPOSITORY, number: event.pull_request.number,
      token: input('github-token'), marker, body });
  }
  console.log(`CostGraph reviewed ${result.rows.length} EC2 changes; ${result.pricedCount} fully priced; complete=${result.complete}.`);
} catch (error) {
  let message = error.message;
  for (const secret of [input('api-key'), input('github-token')]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error(`::error::${message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
  process.exitCode = 1;
}
