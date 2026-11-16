/**
 * FlareSolverr integration — opt-in Cloudflare challenge auto-bypass.
 *
 * Set FLARESOLVERR_URL (e.g. http://localhost:8191) to enable. When fetchPage
 * hits a CF challenge it asks FlareSolverr (POST {URL}/v1, cmd=request.get)
 * to solve it in a headless browser; the returned cf_clearance cookie + the
 * solver's User-Agent are cached per host (they are IP+UA-bound) and reused
 * for subsequent fetches to that host.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FlareCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** unix seconds; -1 = session cookie */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface FlareSolution {
  url: string;
  status: number;
  html: string;
  userAgent: string;
  cookies: FlareCookie[];
}

/** Solved cf_clearance context, cached per host */
export interface SolvedContext {
  userAgent: string;
  cookieHeader: string;
  /** epoch ms, or Infinity for session cookies */
  expiresAt: number;
}

export function configured(): boolean {
  return Boolean(process.env.FLARESOLVERR_URL?.trim());
}

/** Pure: validate + normalize a FlareSolverr /v1 response body */
export function parseSolveResponse(json: unknown): FlareSolution | null {
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.status !== 'ok') return null;
  const sol = obj.solution;
  if (typeof sol !== 'object' || sol === null) return null;
  const s = sol as Record<string, unknown>;
  if (typeof s.response !== 'string' || !s.response) return null;
  if (typeof s.userAgent !== 'string') return null;
  if (!Array.isArray(s.cookies)) return null;
  const cookies: FlareCookie[] = [];
  for (const c of s.cookies) {
    if (typeof c !== 'object' || c === null) continue;
    const cc = c as Record<string, unknown>;
    if (typeof cc.name !== 'string' || typeof cc.value !== 'string') continue;
    cookies.push({
      name: cc.name,
      value: cc.value,
      ...(typeof cc.domain === 'string' ? { domain: cc.domain } : {}),
      ...(typeof cc.path === 'string' ? { path: cc.path } : {}),
      ...(typeof cc.expires === 'number' ? { expires: cc.expires } : {}),
      ...(typeof cc.httpOnly === 'boolean' ? { httpOnly: cc.httpOnly } : {}),
      ...(typeof cc.secure === 'boolean' ? { secure: cc.secure } : {}),
      ...(typeof cc.sameSite === 'string' ? { sameSite: cc.sameSite } : {}),
    });
  }
  return {
    url: typeof s.url === 'string' ? s.url : '',
    status: typeof s.status === 'number' ? s.status : 200,
    html: s.response,
    userAgent: s.userAgent,
    cookies,
  };
}

/**
 * Pure: build a Cookie header from FlareSolverr cookies.
 * Leading-dot domains ('.filman.cc') match the apex and all subdomains.
 */
export function cookieHeaderValue(
  cookies: FlareCookie[],
  domainFilter?: string
): string | null {
  const matched = domainFilter
    ? cookies.filter((c) => {
        if (!c.domain) return false;
        const cd = c.domain.replace(/^\./, '').toLowerCase();
        const host = domainFilter.toLowerCase();
        return host === cd || host.endsWith(`.${cd}`);
      })
    : cookies;
  if (matched.length === 0) return null;
  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Pure: solved context for a host, or null when no cookie matches it */
export function buildSolvedContext(
  solution: FlareSolution,
  host: string
): SolvedContext | null {
  const cookieHeader = cookieHeaderValue(solution.cookies, host);
  if (!cookieHeader) return null;
  const expirations = solution.cookies
    .filter((c) => cookieHeaderValue([c], host))
    .map((c) => c.expires ?? -1)
    .filter((e) => e > 0)
    .map((e) => e * 1000);
  return {
    userAgent: solution.userAgent,
    cookieHeader,
    expiresAt: expirations.length ? Math.min(...expirations) : Infinity,
  };
}

// ---------------------------------------------------------------------------
// Solve call + caches (process-lifetime, persisted to disk)

const inFlight = new Map<string, Promise<FlareSolution>>();
const solvedContexts = new Map<string, SolvedContext>();

/**
 * Global solve queue. FlareSolverr runs headless Chrome; solving multiple
 * hosts in parallel (providers sweep concurrently) starves weak CPUs and
 * every challenge JS times out inside FlareSolverr's own budget — observed
 * live: 3 simultaneous solves → all "Timeout after 60s", sequential → ok.
 * Settling the previous task first also means its cookies get cached before
 * the next solve starts.
 */
let lastSolve: Promise<unknown> = Promise.resolve();

/**
 * Solved contexts survive process restarts via a small JSON file next to
 * .env (override with FLARESOLVERR_CACHE_FILE; value "off" disables disk
 * I/O — used by tests). cf_clearance is IP+UA-bound, so a cache is only
 * valid for the same egress IP — the same box re-reading it after a restart
 * is exactly the intended reuse.
 */
const DEFAULT_CACHE_FILE = '.flaresolverr-cache.json';

function cachePath(): string | null {
  const env = process.env.FLARESOLVERR_CACHE_FILE?.trim();
  if (env === 'off') return null;
  return env || join(process.cwd(), DEFAULT_CACHE_FILE);
}

let cacheLoaded = false;

function loadContexts(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const path = cachePath();
  if (!path) return;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, SolvedContext>;
    for (const [host, ctx] of Object.entries(raw)) {
      if (
        ctx &&
        typeof ctx.userAgent === 'string' &&
        typeof ctx.cookieHeader === 'string' &&
        typeof ctx.expiresAt === 'number'
      ) {
        // -1 encodes a session cookie (Infinity doesn't survive JSON)
        solvedContexts.set(host, {
          userAgent: ctx.userAgent,
          cookieHeader: ctx.cookieHeader,
          expiresAt: ctx.expiresAt < 0 ? Infinity : ctx.expiresAt,
        });
      }
    }
  } catch {
    /* no cache file yet */
  }
}

function saveContexts(): void {
  const path = cachePath();
  if (!path) return;
  const obj: Record<string, unknown> = {};
  for (const [host, ctx] of solvedContexts) {
    obj[host] = {
      userAgent: ctx.userAgent,
      cookieHeader: ctx.cookieHeader,
      expiresAt: Number.isFinite(ctx.expiresAt) ? ctx.expiresAt : -1,
    };
  }
  try {
    writeFileSync(path, JSON.stringify(obj));
  } catch {
    /* best-effort */
  }
}

/**
 * Ask FlareSolverr to solve the challenge for `url`.
 * Deduplicated per target host (providers run in parallel).
 */
export async function solveForHost(
  url: string,
  timeoutMs = 65000
): Promise<FlareSolution> {
  const base = process.env.FLARESOLVERR_URL?.trim().replace(/\/+$/, '');
  if (!base) throw new Error('FLARESOLVERR_URL is not set');
  const host = new URL(url).host;

  const existing = inFlight.get(host);
  if (existing) return existing;

  const task = (async (): Promise<FlareSolution> => {
    try {
      // queued wait is NOT counted against timeoutMs — the abort budget
      // applies to the actual FlareSolverr call only (a provider-level
      // timeout may still cut us off, but the solve then finishes in the
      // background and its cookies are cached for subsequent requests)
      await lastSolve.catch(() => {});
      const res = await fetch(`${base}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(
          `FlareSolverr returned invalid JSON (HTTP ${res.status}) from ${base}/v1`
        );
      }
      const solution = parseSolveResponse(json);
      if (!solution) {
        const msg =
          typeof (json as Record<string, unknown>)?.message === 'string'
            ? (json as Record<string, unknown>).message
            : `HTTP ${res.status}`;
        throw new Error(`FlareSolverr could not solve ${host}: ${msg}`);
      }
      return solution;
    } finally {
      inFlight.delete(host);
    }
  })();

  inFlight.set(host, task);
  lastSolve = task.catch(() => {});
  return task;
}

export function getSolvedContext(host: string): SolvedContext | null {
  loadContexts();
  const ctx = solvedContexts.get(host);
  if (!ctx) return null;
  if (ctx.expiresAt !== Infinity && Date.now() >= ctx.expiresAt) {
    solvedContexts.delete(host);
    saveContexts();
    return null;
  }
  return ctx;
}

export function storeSolvedContext(host: string, ctx: SolvedContext): void {
  loadContexts();
  solvedContexts.set(host, ctx);
  saveContexts();
}

export function clearSolvedContextsForTests(): void {
  solvedContexts.clear();
  inFlight.clear();
}
