import { CloudflareBlockedError } from '../types.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface FetchOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** base URL for detecting Cloudflare in error messages */
  site?: string;
}

/** True when an HTML body looks like a Cloudflare challenge page */
export function isCloudflareChallenge(html: string): boolean {
  const titleMatch = /<title>([^<]*)<\/title>/i.exec(html);
  const title = titleMatch?.[1]?.toLowerCase() ?? '';
  return (
    title.includes('just a moment') ||
    title.includes('checking your browser') ||
    title.includes('attention required') ||
    html.includes('cf_chl_opt') ||
    html.includes('challenge-error-text') ||
    html.includes('_cf_chl')
  );
}

/**
 * fetch wrapper: browser UA, timeout, retry with backoff.
 * Throws CloudflareBlockedError when response is a CF challenge page.
 */
export async function fetchPage(
  url: string,
  opts: FetchOptions = {}
): Promise<Response> {
  const { headers = {}, timeoutMs = 15000, retries = 1, site } = opts;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      if (res.ok) {
        const body = await res.text();
        if (isCloudflareChallenge(body)) {
          throw new CloudflareBlockedError(site ?? new URL(url).host);
        }
        // Re-wrap body so callers can still res.text()
        return new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }

      // Cloudflare often serves the challenge page with 403/503 status
      if (res.status === 403 || res.status === 503) {
        const body = await res.text();
        if (isCloudflareChallenge(body) || res.headers.get('server') === 'cloudflare') {
          throw new CloudflareBlockedError(site ?? new URL(url).host);
        }
      }
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      if (err instanceof CloudflareBlockedError) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url}`);
}
