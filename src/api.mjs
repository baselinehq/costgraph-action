export class ApiError extends Error {
  constructor(service, status) {
    super(`${service} returned HTTP ${status}`);
    this.status = status;
  }
}

export function pricingClient({ url, apiKey, fetchImpl = fetch }) {
  const base = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('api-url must be an HTTPS URL without credentials, query, or fragment');
  }
  const cache = new Map();
  async function request(path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${base.href.replace(/\/$/, '')}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error('CostGraph request failed or timed out');
      }
      if (response.ok) return response.json();
      if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      throw new ApiError('CostGraph', response.status);
    }
  }
  return (path, body) => {
    const key = JSON.stringify([path, body]);
    if (!cache.has(key)) cache.set(key, request(path, body));
    return cache.get(key);
  };
}

export async function upsertComment({ apiUrl, repository, number, token, marker, body, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error('A valid GitHub repository and PR number are required');
  }
  const base = new URL(apiUrl);
  if (base.protocol !== 'https:') throw new Error('GitHub API URL must use HTTPS');
  async function request(path, method = 'GET', payload) {
    const response = await fetchImpl(`${base.href.replace(/\/$/, '')}/repos/${repository}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new ApiError('GitHub', response.status);
    return response.json();
  }
  for (let page = 1; ; page++) {
    const comments = await request(`/issues/${number}/comments?per_page=100&page=${page}`);
    const existing = comments.find(c => c.user?.type === 'Bot' && c.body?.startsWith(marker));
    if (existing) return request(`/issues/comments/${existing.id}`, 'PATCH', { body });
    if (comments.length < 100) break;
  }
  return request(`/issues/${number}/comments`, 'POST', { body });
}
