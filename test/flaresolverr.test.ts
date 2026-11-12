import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  configured,
  parseSolveResponse,
  cookieHeaderValue,
  buildSolvedContext,
  getSolvedContext,
  storeSolvedContext,
  clearSolvedContextsForTests,
  type FlareSolution,
} from '../src/utils/flaresolverr.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('flaresolverr configured()', () => {
  const saved = process.env.FLARESOLVERR_URL;

  afterEach(() => {
    if (saved === undefined) delete process.env.FLARESOLVERR_URL;
    else process.env.FLARESOLVERR_URL = saved;
  });

  it('is false when unset', () => {
    delete process.env.FLARESOLVERR_URL;
    expect(configured()).toBe(false);
  });

  it('is true when set', () => {
    process.env.FLARESOLVERR_URL = 'http://localhost:8191';
    expect(configured()).toBe(true);
  });
});

describe('flaresolverr parseSolveResponse', () => {
  it('parses a real ok response fixture', () => {
    const sol = parseSolveResponse(JSON.parse(fixture('flaresolverr-solution.json')));
    expect(sol).not.toBeNull();
    expect(sol!.status).toBe(200);
    expect(sol!.html).toContain('real page');
    expect(sol!.userAgent).toContain('Chrome/124');
    expect(sol!.cookies).toHaveLength(3);
    expect(sol!.cookies[0].name).toBe('cf_clearance');
  });

  it('returns null on error status with message available for callers', () => {
    const err = JSON.parse(fixture('flaresolverr-error.json'));
    expect(parseSolveResponse(err)).toBeNull();
    expect((err as { message: string }).message).toContain(
      'Challenge is not detected'
    );
  });

  it('returns null on malformed input', () => {
    expect(parseSolveResponse(null)).toBeNull();
    expect(parseSolveResponse('nope')).toBeNull();
    expect(parseSolveResponse({})).toBeNull();
    expect(parseSolveResponse({ status: 'ok' })).toBeNull();
    expect(
      parseSolveResponse({ status: 'ok', solution: { response: '', userAgent: 'ua', cookies: [] } })
    ).toBeNull();
    expect(
      parseSolveResponse({ status: 'ok', solution: { response: '<html>', cookies: [] } })
    ).toBeNull();
    expect(
      parseSolveResponse({ status: 'ok', solution: { response: '<html>', userAgent: 'ua' } })
    ).toBeNull();
  });

  it('defaults solution.status to 200 and drops malformed cookies', () => {
    const sol = parseSolveResponse({
      status: 'ok',
      solution: {
        response: '<html></html>',
        cookies: [
          { name: 'a', value: '1', domain: '.x.pl' },
          'garbage',
          { value: 'no-name', domain: '.x.pl' },
        ],
        userAgent: 'ua',
      },
    });
    expect(sol!.status).toBe(200);
    expect(sol!.cookies).toHaveLength(1);
    expect(sol!.cookies[0].name).toBe('a');
  });
});

describe('flaresolverr cookieHeaderValue', () => {
  const cookies = parseSolveResponse(
    JSON.parse(fixture('flaresolverr-solution.json'))
  )!.cookies;

  it('joins all cookies when no domain filter', () => {
    const header = cookieHeaderValue(cookies);
    expect(header).toBe(
      'cf_clearance=abc123_clearance; unrelated=x; PHPSESSID=sess1'
    );
  });

  it('filters by host — leading-dot domain covers apex + subdomains', () => {
    expect(cookieHeaderValue(cookies, 'filman.cc')).toBe(
      'cf_clearance=abc123_clearance; PHPSESSID=sess1'
    );
    expect(cookieHeaderValue(cookies, 'www.filman.cc')).toBe(
      'cf_clearance=abc123_clearance; PHPSESSID=sess1'
    );
    expect(cookieHeaderValue(cookies, 'example.com')).toBe('unrelated=x');
  });

  it('returns null when nothing matches', () => {
    expect(cookieHeaderValue(cookies, 'other.pl')).toBeNull();
    expect(cookieHeaderValue([], 'filman.cc')).toBeNull();
    expect(cookieHeaderValue([{ name: 'a', value: '1' }], 'filman.cc')).toBeNull();
  });
});

describe('flaresolverr buildSolvedContext', () => {
  const solution = parseSolveResponse(
    JSON.parse(fixture('flaresolverr-solution.json'))
  )!;

  it('builds a context with host-matched cookie header', () => {
    const ctx = buildSolvedContext(solution, 'filman.cc');
    expect(ctx).not.toBeNull();
    expect(ctx!.cookieHeader).toBe(
      'cf_clearance=abc123_clearance; PHPSESSID=sess1'
    );
    expect(ctx!.userAgent).toContain('Chrome/124');
  });

  it('converts expires seconds to ms and ignores session cookies (-1)', () => {
    const ctx = buildSolvedContext(solution, 'filman.cc');
    expect(ctx!.expiresAt).toBe(1893456000 * 1000);
  });

  it('returns Infinity when only session cookies match', () => {
    const ctx = buildSolvedContext(
      {
        ...(solution as FlareSolution),
        cookies: [
          { name: 's', value: '1', domain: 'filman.cc', expires: -1 },
        ],
      },
      'filman.cc'
    );
    expect(ctx!.expiresAt).toBe(Infinity);
  });

  it('returns null when no cookie matches the host', () => {
    expect(buildSolvedContext(solution, 'zaluknij.cc')).toBeNull();
  });
});

describe('flaresolverr solved-context cache', () => {
  beforeEach(clearSolvedContextsForTests);
  afterEach(clearSolvedContextsForTests);

  const ctx = {
    userAgent: 'ua',
    cookieHeader: 'cf_clearance=x',
    expiresAt: Infinity,
  };

  it('stores and gets a context per host', () => {
    expect(getSolvedContext('filman.cc')).toBeNull();
    storeSolvedContext('filman.cc', ctx);
    expect(getSolvedContext('filman.cc')).toBe(ctx);
    expect(getSolvedContext('zaluknij.cc')).toBeNull();
  });

  it('expires stale contexts', () => {
    storeSolvedContext('filman.cc', { ...ctx, expiresAt: Date.now() - 1000 });
    expect(getSolvedContext('filman.cc')).toBeNull();
  });
});
