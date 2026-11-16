import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  absorbCookies,
  loginSucceeded,
  parseLoginForm,
  isLoginWall,
  replaceClearance,
  clearanceFromCookies,
  solverCookieHeader,
  autoConfigured,
  manualIdentity,
  loadSessionState,
  saveSessionState,
  type FlareCookie,
} from '../src/utils/filman-session.js';
import {
  buildCreateTaskBody,
  parseTaskResult,
} from '../src/utils/twocaptcha.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(join(fixturesDir, name), 'utf-8');

describe('filman-session absorbCookies', () => {
  it('replaces by name and preserves other cookies', () => {
    const jar = 'cf_clearance=OLD; PHPSESSID=aaa; user_id=1';
    const out = absorbCookies(jar, ['PHPSESSID=bbb; Path=/; HttpOnly', 'user_id=2; Path=/']);
    expect(out).toBe('cf_clearance=OLD; PHPSESSID=bbb; user_id=2');
  });

  it('adds new cookies', () => {
    const out = absorbCookies('cf_clearance=x', ['BKD_REMEMBER=abc; Path=/; HttpOnly; Secure']);
    expect(out).toBe('cf_clearance=x; BKD_REMEMBER=abc');
  });

  it('ignores malformed set-cookie values', () => {
    expect(absorbCookies('a=1', ['garbage', ';', ''])).toBe('a=1');
  });
});

describe('filman-session loginSucceeded', () => {
  it('detects the user_id marker', () => {
    expect(
      loginSucceeded(['PHPSESSID=abc; Path=/; HttpOnly', 'user_id=1690322; Path=/'])
    ).toBe(true);
  });

  it('is false without user_id (failed login sets nothing)', () => {
    expect(loginSucceeded([])).toBe(false);
    expect(loginSucceeded(['PHPSESSID=abc; Path=/'])).toBe(false);
  });
});

describe('filman-session parseLoginForm', () => {
  it('picks the signin form (not the header search form) and extracts csrf + sitekey', () => {
    const form = parseLoginForm(fixture('filman-login.html'));
    expect(form).not.toBeNull();
    expect(form!.csrf).toBe(
      'da73658ebc6b01aad9e4d02bdf335483f646a9de170b1be99614da32fd1e1d49'
    );
    expect(form!.sitekey).toBe('6LcQs24iAAAAALFibpEQwpQZiyhOCn-zdc-eFout');
  });

  it('returns null on pages without a login form', () => {
    expect(parseLoginForm(fixture('filman-search.html'))).toBeNull();
  });
});

describe('filman-session isLoginWall', () => {
  it('matches the login page title', () => {
    expect(isLoginWall('<html><head><title> Logowanie - filman.cc</title>')).toBe(true);
  });

  it('does not match a search page', () => {
    expect(isLoginWall(fixture('filman-search.html'))).toBe(false);
  });
});

describe('filman-session replaceClearance / solver cookies', () => {
  it('swaps only cf_clearance', () => {
    const jar =
      'cf_clearance=OLD; PHPSESSID=keep; BKD_REMEMBER=keep; user_id=keep';
    const out = replaceClearance(jar, 'NEW');
    expect(out).toBe('PHPSESSID=keep; BKD_REMEMBER=keep; user_id=keep; cf_clearance=NEW');
  });

  it('clearanceFromCookies matches apex domains', () => {
    const cookies: FlareCookie[] = [
      { name: 'PHPSESSID', value: 'zzz', domain: 'filman.cc' },
      { name: 'cf_clearance', value: 'tok', domain: '.filman.cc' },
    ];
    expect(clearanceFromCookies(cookies)).toBe('tok');
    expect(clearanceFromCookies([{ name: 'cf_clearance', value: 'v', domain: 'other.com' }])).toBeNull();
  });

  it('solverCookieHeader keeps all filman cookies (incl. anonymous PHPSESSID)', () => {
    const cookies: FlareCookie[] = [
      { name: 'PHPSESSID', value: 'anon', domain: 'filman.cc' },
      { name: 'cf_clearance', value: 'tok', domain: '.filman.cc' },
      { name: 'cf_chl', value: 'x', domain: 'challenge.cloudflare.com' },
    ];
    expect(solverCookieHeader(cookies)).toBe('PHPSESSID=anon; cf_clearance=tok');
  });
});

describe('filman-session state persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msf-filman-'));
  const path = join(dir, 'state.json');

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('roundtrips and rejects malformed files', () => {
    expect(loadSessionState(path)).toBeNull();
    saveSessionState(
      { ua: 'UA/1', cookieHeader: 'cf_clearance=x; PHPSESSID=y', savedAt: '2026-11-16' },
      path
    );
    expect(loadSessionState(path)).toEqual({
      ua: 'UA/1',
      cookieHeader: 'cf_clearance=x; PHPSESSID=y',
      savedAt: '2026-11-16',
    });
    saveSessionState({ ua: '', cookieHeader: '', savedAt: '' }, path);
    expect(loadSessionState(path)).toBeNull();
  });
});

describe('filman-session env configuration', () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [
    'FLARESOLVERR_URL',
    'FILMAN_CC_LOGIN',
    'FILMAN_CC_PASSWORD',
    'TWOCAPTCHA_API_KEY',
    'FILMAN_CC_COOKIE',
    'FILMAN_CC_UA',
  ];

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('autoConfigured requires all four vars', () => {
    for (const k of keys) saved[k] = process.env[k];
    keys.forEach((k) => delete process.env[k]);
    expect(autoConfigured()).toBe(false);
    process.env.FLARESOLVERR_URL = 'http://localhost:8191';
    expect(autoConfigured()).toBe(false);
    process.env.FILMAN_CC_LOGIN = 'user';
    expect(autoConfigured()).toBe(false);
    process.env.FILMAN_CC_PASSWORD = 'pass';
    expect(autoConfigured()).toBe(false);
    process.env.TWOCAPTCHA_API_KEY = 'key';
    expect(autoConfigured()).toBe(true);
  });

  it('manualIdentity needs both cookie and UA', () => {
    for (const k of keys) saved[k] = process.env[k];
    keys.forEach((k) => delete process.env[k]);
    expect(manualIdentity()).toBeNull();
    process.env.FILMAN_CC_COOKIE = 'cf_clearance=x';
    expect(manualIdentity()).toBeNull();
    process.env.FILMAN_CC_UA = 'Firefox/159';
    expect(manualIdentity()).toEqual({ cookie: 'cf_clearance=x', ua: 'Firefox/159' });
  });
});

describe('twocaptcha', () => {
  it('buildCreateTaskBody uses the proxyless enterprise task', () => {
    const body = buildCreateTaskBody('KEY', 'SITEKEY', 'https://filman.cc/logowanie');
    expect(body.clientKey).toBe('KEY');
    expect(body.task).toMatchObject({
      type: 'RecaptchaV2EnterpriseTaskProxyless',
      websiteURL: 'https://filman.cc/logowanie',
      websiteKey: 'SITEKEY',
    });
  });

  it('parseTaskResult handles ready / error / pending', () => {
    expect(parseTaskResult({ errorId: 0, status: 'ready', solution: { gRecaptchaResponse: 'tok' } })).toEqual({
      token: 'tok',
      error: null,
    });
    expect(parseTaskResult({ errorId: 1, errorCode: 'ERROR_BAD_PROXY' }).error).toContain(
      'ERROR_BAD_PROXY'
    );
    expect(parseTaskResult({ errorId: 0, status: 'processing' })).toEqual({
      token: null,
      error: null,
    });
    expect(parseTaskResult(null).error).toBeTruthy();
  });
});
