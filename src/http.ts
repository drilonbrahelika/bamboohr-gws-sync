export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 500)}`);
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Observers of retries (the sync run logs them on its timeline). */
export const retryListeners = new Set<(info: { url: string; status: number; delayMs: number }) => void>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + JSON with timeouts and exponential backoff (honours Retry-After).
 * BambooHR signals rate limiting with 503, Google with 429/403 rateLimitExceeded.
 */
export async function request<T = unknown>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
  retries = 5,
): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Accept", "application/json");
  if (json !== undefined) headers.set("Content-Type", "application/json");

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let networkError: unknown;
    try {
      res = await fetch(url, {
        ...rest,
        headers,
        body: json !== undefined ? JSON.stringify(json) : rest.body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      networkError = err;
    }

    if (res?.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const body = res ? await res.text() : String(networkError);
    const rateLimited = res?.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body);
    const retryable = !res || RETRYABLE.has(res.status) || rateLimited;
    if (!retryable || attempt >= retries) {
      if (!res) throw networkError;
      throw new HttpError(res.status, body, url);
    }
    const retryAfter = Number(res?.headers.get("retry-after"));
    const delay = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500 + Math.random() * 250;
    const delayMs = Math.round(Math.min(delay, 60_000));
    for (const fn of retryListeners) fn({ url, status: res?.status ?? 0, delayMs });
    await sleep(delayMs);
  }
}

/** Run fn over items with at most `limit` in flight. Results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
