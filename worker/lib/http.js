function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithPolicy(url, options = {}, policy = {}) {
  const retries = policy.retries ?? 2;
  const timeoutMs = policy.timeoutMs ?? 15000;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'User-Agent': 'job_hunter/1.0 personal-local-index',
          ...(options.headers || {})
        }
      });
      if (res.ok || ![429, 500, 502, 503, 504].includes(res.status) || attempt === retries) {
        return res;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 300 * (2 ** attempt));
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await delay(300 * (2 ** attempt));
    }
  }
  throw lastError || new Error('request failed');
}

module.exports = { fetchWithPolicy };
