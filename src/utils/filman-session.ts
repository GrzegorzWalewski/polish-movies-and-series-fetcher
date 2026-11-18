/**
 * filman.cc auto-session — keeps a logged-in identity working indefinitely.
 *
 * filman requires a logged-in account, and its session is bound to:
 *  - the User-Agent header (app level — a UA mismatch means a login wall)
 *  - the IP (cf_clearance is IP-bound; expires after ~24h server-side)
 *  - the reCAPTCHA Enterprise-gated login form (cannot be auto-solved by
 *    FlareSolverr — solved here with 2Captcha, ~$0.003 per login)
 *
 * Architecture (all live-verified 2026-11-16):
 *  1. FlareSolverr solves the CF challenge (~14s), minting a clearance bound
 *     to the solver's own UA + our IP — consistent forever after.
 *  2. With that identity: GET /logowanie → _csrf + sitekey from #signin-form
 *     → 2Captcha token → POST → the server sets PHPSESSID + BKD_REMEMBER +
 *     user_id. ALL THREE login cookies must be kept (user_id is the auth
 *     marker — dropping it yields a login wall despite a 302 to /).
 *  3. The {ua, cookieHeader} pair is cached on disk (.filman-session.json,
 *     gitignored). Daily cf_clearance expiry is fixed by re-solving CF with
 *     FlareSolverr (free) and swapping only cf_clearance — same solver UA, so
 *     the login cookies stay valid. A full re-login (2Captcha) only happens
 *     when the session itself dies or the solver UA drifted.
 *
 * Env vars: FLARESOLVERR_URL + FILMAN_CC_LOGIN + FILMAN_CC_PASSWORD +
 * TWOCAPTCHA_API_KEY. The manual FILMAN_CC_COOKIE/FILMAN_CC_UA pair remains
 * as a fallback when auto mode is not fully configured.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { solveForHost, type FlareCookie } from './flaresolverr.js';
import { solveRecaptchaEnterprise } from './twocaptcha.js';

export const BASE_URL = 'https://filman.cc';
export const LOGIN_URL = `${BASE_URL}/logowanie`;
const STATE_FILE = '.filman-session.json';

export interface FilmanIdentity {
  cookie: string;
  ua: string;
}

interface FilmanSessionState {
  ua: string;
  cookieHeader: string;
  savedAt: string;
}

/** Thrown by the provider when filman serves the login page instead of content. */
export class FilmanLoginWallError extends Error {
  constructor() {
    super('filman.cc login wall (session expired or anonymous)');
  }
}

// ---------------------------------------------------------------------------
// Env configuration

const env = (key: string): string | undefined => process.env[key]?.trim() || undefined;

export function autoConfigured(): boolean {
  return Boolean(
    env('FLARESOLVERR_URL') &&
      env('FILMAN_CC_LOGIN') &&
      env('FILMAN_CC_PASSWORD') &&
      env('TWOCAPTCHA_API_KEY')
  );
}

export function manualIdentity(): FilmanIdentity | null {
  const cookie = env('FILMAN_CC_COOKIE');
  const ua = env('FILMAN_CC_UA');
  return cookie && ua ? { cookie, ua } : null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)

/** Merge Set-Cookie values into a Cookie header by name; attributes stripped. */
export function absorbCookies(jar: string, setCookies: string[]): string {
  let out = jar;
  for (const setc of setCookies ?? []) {
    const pair = setc.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    out = out
      .split('; ')
      .filter((p) => !p.startsWith(name + '='))
      .concat(pair)
      .join('; ');
  }
  return out;
}

/** True when a login response set the user_id auth marker (login succeeded). */
export function loginSucceeded(setCookies: string[]): boolean {
  return (setCookies ?? []).some((c) => c.startsWith('user_id='));
}

/**
 * Extract _csrf + sitekey from the login page. The page has two forms (the
 * header search form comes first) — pick the one containing _csrf.
 */
export function parseLoginForm(html: string): { csrf: string; sitekey: string } | null {
  const forms = html.match(/<form[\s\S]{0,2500}?<\/form>/g) ?? [];
  const form = forms.find((f) => f.includes('name="_csrf"'));
  if (!form) return null;
  const csrf = /name="_csrf" value="([^"]+)"/.exec(form)?.[1];
  const sitekey =
    /data-sitekey="([^"]+)"/.exec(form)?.[1] ?? /data-sitekey="([^"]+)"/.exec(html)?.[1];
  if (!csrf || !sitekey) return null;
  return { csrf, sitekey };
}

export function isLoginWall(html: string): boolean {
  return /<title>\s*Logowanie/i.test(html);
}

/** Swap cf_clearance in a cookie jar with a fresh value. */
export function replaceClearance(jar: string, clearance: string): string {
  return absorbCookies(jar, [`cf_clearance=${clearance}`]);
}

/** Pure: the cf_clearance value from a FlareSolverr cookie list (apex match). */
export function clearanceFromCookies(cookies: FlareCookie[], host = 'filman.cc'): string | null {
  for (const c of cookies) {
    if (c.name !== 'cf_clearance') continue;
    const cd = (c.domain ?? '').replace(/^\./, '').toLowerCase();
    if (!cd || host === cd || host.endsWith(`.${cd}`)) return c.value;
  }
  return null;
}

/** Pure: build a Cookie header from solver cookies, keeping every cookie. */
export function solverCookieHeader(cookies: FlareCookie[], host = 'filman.cc'): string {
  return cookies
    .filter((c) => {
      const cd = (c.domain ?? '').replace(/^\./, '').toLowerCase();
      return !cd || host === cd || host.endsWith(`.${cd}`);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

// ---------------------------------------------------------------------------
// State persistence (in-process memo + gitignored file next to .env)

let current: FilmanSessionState | null = null;

function statePath(): string {
  return process.env.FILMAN_SESSION_FILE?.trim() || join(process.cwd(), STATE_FILE);
}

export function loadSessionState(path = statePath()): FilmanSessionState | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (
      typeof raw?.ua === 'string' &&
      raw.ua &&
      typeof raw?.cookieHeader === 'string' &&
      raw.cookieHeader
    ) {
      return { ua: raw.ua, cookieHeader: raw.cookieHeader, savedAt: String(raw.savedAt ?? '') };
    }
  } catch {
    // no state file — normal before the first login
  }
  return null;
}

export function saveSessionState(state: FilmanSessionState, path = statePath()): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function resetSessionStateForTests(): void {
  current = null;
}

// ---------------------------------------------------------------------------
// Flows

/** FlareSolverr solve → { ua, full solver cookie header, cf_clearance value }. */
async function solveCf(url: string): Promise<{
  ua: string;
  jar: string;
  clearance: string;
}> {
  const solution = await solveForHost(url);
  const clearance = clearanceFromCookies(solution.cookies);
  if (!clearance) throw new Error('FlareSolverr solved but returned no cf_clearance cookie');
  return {
    ua: solution.userAgent,
    jar: solverCookieHeader(solution.cookies),
    clearance,
  };
}

/**
 * Full login: solve CF → GET login page → _csrf + sitekey → 2Captcha token →
 * POST → absorb ALL Set-Cookie (PHPSESSID + BKD_REMEMBER + user_id).
 */
async function loginFlow(): Promise<FilmanIdentity> {
  const login = env('FILMAN_CC_LOGIN')!;
  const password = env('FILMAN_CC_PASSWORD')!;
  const captchaKey = env('TWOCAPTCHA_API_KEY')!;

  const { ua, jar: solverJar } = await solveCf(LOGIN_URL);
  let jar = solverJar;

  const req = (method: 'GET' | 'POST', extra: Record<string, string> = {}) => ({
    method,
    headers: {
      Cookie: jar,
      'User-Agent': ua,
      Accept: 'text/html',
      Origin: BASE_URL,
      Referer: LOGIN_URL,
      ...extra,
    },
    redirect: 'manual' as const,
    signal: AbortSignal.timeout(15000),
  });

  const p1 = await fetch(LOGIN_URL, req('GET'));
  jar = absorbCookies(jar, p1.headers.getSetCookie());
  const form = parseLoginForm(await p1.text());
  if (!form) {
    throw new Error('filman auto-login: login form or _csrf not found on the login page');
  }

  const token = await solveRecaptchaEnterprise(captchaKey, form.sitekey, LOGIN_URL);

  const body = new URLSearchParams({
    _csrf: form.csrf,
    login,
    password,
    remember: 'on',
    submit: '',
    'g-recaptcha-response': token,
  });
  const p2 = await fetch(LOGIN_URL, {
    ...req('POST', { 'Content-Type': 'application/x-www-form-urlencoded' }),
    body: body.toString(),
  });
  const setCookies = p2.headers.getSetCookie();
  const location = p2.headers.get('location') ?? '';
  if (location.includes('/logowanie') || !loginSucceeded(setCookies)) {
    throw new Error(
      'filman auto-login rejected (captcha token invalid, CSRF mismatch, or wrong credentials)'
    );
  }
  jar = absorbCookies(jar, setCookies);

  const state: FilmanSessionState = { ua, cookieHeader: jar, savedAt: new Date().toISOString() };
  current = state;
  saveSessionState(state);
  return { cookie: jar, ua };
}

/**
 * CF clearance expired (~daily): re-solve with FlareSolverr and swap only
 * cf_clearance. The login cookies are UA-bound — if the solver UA drifted
 * (e.g. FlareSolverr image update), re-login instead.
 */
async function refreshClearanceFlow(state: FilmanSessionState): Promise<FilmanIdentity> {
  const { ua, clearance } = await solveCf(BASE_URL + '/');
  if (ua !== state.ua) return loginFlow();
  const updated: FilmanSessionState = {
    ua,
    cookieHeader: replaceClearance(state.cookieHeader, clearance),
    savedAt: new Date().toISOString(),
  };
  current = updated;
  saveSessionState(updated);
  return { cookie: updated.cookieHeader, ua };
}

function loadCurrent(): FilmanSessionState | null {
  return current ?? (current = loadSessionState());
}

// A CF re-solve (~75-80s on the server CPU) or a 2Captcha login (15-60s+)
// must run ONCE per process, not once per concurrent request — without the
// shared promise, every parallel filman request queued its own
// FlareSolverr/captcha flow and ALL of them blew the addon's provider
// timeout (repeated 60s healthz timeouts on back-to-back titles).
let recoveryInFlight: Promise<FilmanIdentity | null> | null = null;

function singleFlight(
  fn: () => Promise<FilmanIdentity | null>
): Promise<FilmanIdentity | null> {
  if (recoveryInFlight) return recoveryInFlight;
  recoveryInFlight = fn().finally(() => {
    recoveryInFlight = null;
  });
  return recoveryInFlight;
}

/**
 * Main entry: the identity to use for filman requests.
 * Precedence: auto mode (fully configured) > manual env pair. Null when
 * neither is available — the provider then falls back to anonymous fetching
 * (FlareSolverr may still solve CF, but content will hit the login wall).
 */
export async function filmanIdentity(): Promise<FilmanIdentity | null> {
  if (autoConfigured()) {
    const state = loadCurrent();
    if (state) return { cookie: state.cookieHeader, ua: state.ua };
    return singleFlight(loginFlow);
  }
  return manualIdentity();
}

/** Recovery hook: a request with the cached identity hit a CF challenge. */
export async function filmanOnChallenge(): Promise<FilmanIdentity | null> {
  if (!autoConfigured()) return null;
  const state = loadCurrent();
  if (!state) return singleFlight(loginFlow);
  return singleFlight(() => refreshClearanceFlow(state));
}

/** Recovery hook: a request with the cached identity hit the login wall. */
export async function filmanOnLoginWall(): Promise<FilmanIdentity | null> {
  if (!autoConfigured()) return null;
  return singleFlight(loginFlow);
}
