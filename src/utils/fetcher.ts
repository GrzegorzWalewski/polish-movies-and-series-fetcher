import { CloudflareBlockedError } from '../types.js';
import {
  configured,
  getSolvedContext,
  storeSolvedContext,
  buildSolvedContext,
  solveForHost,
  type SolvedContext,
} from './flaresolverr.js';

// Some target sites (telekino.top) announce AAAA records whose endpoints
// refuse connections, and node prefers IPv6 — pick IPv4 first everywhere.
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');

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
 * True when the provider pins its own identity via explicit headers
 * (Cookie header or User-Agent). cf_clearance is UA-bound, so such callers
 * never get solved-context injection or solving — their creds win untouched.
 * Note: opts.cookie (session cookies) does NOT count — it merges with the
 * FlareSolverr-solved cf_clearance instead.
 */
export function providerOwnsIdentity(opts: FetchOptions): boolean {
  return Boolean(opts.headers?.Cookie || opts.headers?.['User-Agent']);
}

/**
 * Merge two Cookie header values by name; later entries win (provider
 * session cookies override the solver's anonymous ones, e.g. PHPSESSID —
 * servers read the first occurrence of a duplicate name).
 * Pure — exported for tests.
 */
export function mergeCookieHeaders(
  solved?: string,
  own?: string
): string | undefined {
  const map = new Map<string, string>();
  for (const part of [solved, own].filter(Boolean).join('; ').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name) map.set(name, value);
  }
  if (map.size === 0) return undefined;
  return [...map].map(([n, v]) => `${n}=${v}`).join('; ');
}

/**
 * Build request headers, optionally merging a solved FlareSolverr context
 * (its UA + cf_clearance cookie) with the provider's own session cookies.
 * Pure — exported for tests.
 */
export function buildRequestHeaders(
  opts: FetchOptions,
  ctx?: SolvedContext | null
): Record<string, string> {
  const { headers = {}, cookie } = opts;
  const mergedCookie = mergeCookieHeaders(ctx?.cookieHeader, cookie);
  return {
    'User-Agent': ctx?.userAgent ?? DEFAULT_UA,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
    ...(mergedCookie ? { Cookie: mergedCookie } : {}),
    ...headers,
  };
}

/**
 * fetch wrapper: browser UA, timeout, retry with backoff.
 * Throws CloudflareBlockedError when response is a CF challenge page.
 * When FLARESOLVERR_URL is set, a challenge on a GET (without a
 * provider-pinned UA/Cookie header) triggers one FlareSolverr solve:
 *  - anonymous fetches: the solved HTML is returned directly
 *  - provider session cookies (opts.cookie): the request is re-fetched with
 *    the solved cf_clearance + UA merged with those cookies, so logged-in
 *    content comes back (the solver's own HTML is the anonymous session)
 */
export async function fetchPage(
  url: string,
  opts: FetchOptions = {}
): Promise<Response> {
  const { headers = {}, cookie, timeoutMs = 15000, retries = 1, site, cookieHint } = opts;

  const host = new URL(url).host;
  const method = (opts.method ?? 'GET').toUpperCase();
  const ownsIdentity = providerOwnsIdentity(opts);
  const canSolve = method === 'GET' && !ownsIdentity;
  let solveErrorNote: string | undefined;
  let solveAttempted = false;
  const cfError = () =>
    new CloudflareBlockedError(site ?? host, cookieHint, solveErrorNote);

  /** Solve the challenge; with provider cookies, re-fetch with merged creds */
  const solveFallback = async (): Promise<Response> => {
    if (!canSolve || !configured() || solveAttempted) throw cfError();
    solveAttempted = true;
    try {
      const solution = await solveForHost(url);
      const solvedCtx = buildSolvedContext(solution, host);
      if (solvedCtx) storeSolvedContext(host, solvedCtx);
      if (!cookie) {
        return new Response(solution.html, {
          status: solution.status,
          headers: { 'content-type': 'text/html' },
        });
      }
      // provider session cookies: re-fetch so they ride along with the
      // solved cf_clearance (solution.html is the anonymous session)
      const res = await fetch(url, {
        headers: buildRequestHeaders(opts, solvedCtx),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });
      if (res.ok || opts.allowStatuses?.includes(res.status)) {
        const body = await res.text();
        if (isCloudflareChallenge(body)) {
          throw new Error('challenge persists after solve');
        }
        return new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      throw new Error(`HTTP ${res.status} after solve`);
    } catch (err) {
      solveErrorNote = err instanceof Error ? err.message : String(err);
      throw cfError();
    }
  };

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const ctx = canSolve ? getSolvedContext(host) : null;
      const res = await fetch(url, {
        headers: buildRequestHeaders(opts, ctx),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
        ...(opts.method ? { method: opts.method } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
      });

      if (res.ok || opts.allowStatuses?.includes(res.status)) {
        const body = await res.text();
        if (isCloudflareChallenge(body)) {
          return await solveFallback();
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
          return await solveFallback();
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
