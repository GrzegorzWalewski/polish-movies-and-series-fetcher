import { CloudflareBlockedError } from '../types.js';
import {
  configured,
  getSolvedContext,
  storeSolvedContext,
  buildSolvedContext,
  solveForHost,
} from './flaresolverr.js';

export interface FetchOptions {
  headers?: Record<string, string>;
  /** value of a Cookie header, e.g. "cf_clearance=...; PHPSESSID=..." */
  cookie?: string;
  timeoutMs?: number;
  retries?: number;
  /** base URL for detecting Cloudflare in error messages */
  site?: string;
  /** shown in the CloudflareBlockedError message (e.g. env var name with the cookie) */
  cookieHint?: string;
  method?: string;
  body?: string;
  /** statuses to accept as success (vider.info serves valid pages with 404) */
  allowStatuses?: number[];
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
 * True when the provider supplies its own credentials/identity (Cookie or an
 * explicit User-Agent). Those take precedence over FlareSolverr — mixing UAs
 * breaks cf_clearance binding, so such callers never get solved contexts.
 */
export function providerOwnsIdentity(opts: FetchOptions): boolean {
  return Boolean(
    opts.cookie || opts.headers?.Cookie || opts.headers?.['User-Agent']
  );
}

/** Ask FlareSolverr to solve, cache the context, return the HTML as Response */
async function solveAndRespond(url: string, host: string): Promise<Response> {
  const solution = await solveForHost(url);
  const ctx = buildSolvedContext(solution, host);
  if (ctx) storeSolvedContext(host, ctx);
  return new Response(solution.html, {
    status: solution.status,
    headers: { 'content-type': 'text/html' },
  });
}

/**
 * fetch wrapper: browser UA, timeout, retry with backoff.
 * Throws CloudflareBlockedError when response is a CF challenge page.
 * When FLARESOLVERR_URL is set, a challenge on a plain GET triggers one
 * FlareSolverr solve whose response is returned directly.
 */
export async function fetchPage(
  url: string,
  opts: FetchOptions = {}
): Promise<Response> {
  const { headers = {}, cookie, timeoutMs = 15000, retries = 1, site, cookieHint } = opts;

  const host = new URL(url).host;
  const method = (opts.method ?? 'GET').toUpperCase();
  const eligible = !providerOwnsIdentity(opts) && method === 'GET';
  let solveErrorNote: string | undefined;
  let solveAttempted = false;
  const cfError = () =>
    new CloudflareBlockedError(site ?? host, cookieHint, solveErrorNote);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const ctx = eligible ? getSolvedContext(host) : null;
      const res = await fetch(url, {
        headers: {
          'User-Agent': DEFAULT_UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
          ...(ctx && { Cookie: ctx.cookieHeader, 'User-Agent': ctx.userAgent }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });

      if (res.ok || opts.allowStatuses?.includes(res.status)) {
        const body = await res.text();
        if (isCloudflareChallenge(body)) {
          if (!eligible || !configured() || solveAttempted) throw cfError();
          solveAttempted = true;
          try {
            return await solveAndRespond(url, host);
          } catch (err) {
            solveErrorNote =
              err instanceof Error ? err.message : String(err);
            throw cfError();
          }
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
          if (!eligible || !configured() || solveAttempted) throw cfError();
          solveAttempted = true;
          try {
            return await solveAndRespond(url, host);
          } catch (err) {
            solveErrorNote =
              err instanceof Error ? err.message : String(err);
            throw cfError();
          }
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
