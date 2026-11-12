import { describe, it, expect } from 'vitest';

import {
  isCloudflareChallenge,
  providerOwnsIdentity,
  buildRequestHeaders,
  mergeCookieHeaders,
} from '../src/utils/fetcher.js';
import { CloudflareBlockedError } from '../src/types.js';

describe('providerOwnsIdentity', () => {
  it('is true when headers.Cookie is set', () => {
    expect(providerOwnsIdentity({ headers: { Cookie: 'a=b' } })).toBe(true);
  });

  it('is true when an explicit User-Agent header is set', () => {
    expect(
      providerOwnsIdentity({ headers: { 'User-Agent': 'PlayStation 4' } })
    ).toBe(true);
  });

  it('is false for opts.cookie — session cookies merge with solved contexts', () => {
    expect(providerOwnsIdentity({ cookie: 'PHPSESSID=x' })).toBe(false);
  });

  it('is false for plain fetches (no cookie, no UA override)', () => {
    expect(providerOwnsIdentity({})).toBe(false);
    expect(providerOwnsIdentity({ headers: { 'Accept-Language': 'pl' } })).toBe(
      false
    );
  });
});

describe('buildRequestHeaders', () => {
  const solvedCtx = {
    userAgent: 'Mozilla/5.0 (X11; Linux) Chrome/152.0.0.0',
    cookieHeader: 'cf_clearance=solved',
    expiresAt: Infinity,
  };

  it('uses default UA and no Cookie for plain fetches', () => {
    const h = buildRequestHeaders({});
    expect(h['User-Agent']).toContain('Chrome/124');
    expect(h.Cookie).toBeUndefined();
    expect(h.Accept).toContain('text/html');
  });

  it('injects solved context UA + cookie', () => {
    const h = buildRequestHeaders({}, solvedCtx);
    expect(h['User-Agent']).toContain('Chrome/152');
    expect(h.Cookie).toBe('cf_clearance=solved');
  });

  it('merges solved cf_clearance with provider session cookies', () => {
    const h = buildRequestHeaders(
      { cookie: 'PHPSESSID=s1; BKD_REMEMBER=r1' },
      solvedCtx
    );
    expect(h.Cookie).toBe('cf_clearance=solved; PHPSESSID=s1; BKD_REMEMBER=r1');
    expect(h['User-Agent']).toContain('Chrome/152');
  });

  it('provider cookies override same-named solver cookies (PHP reads first occurrence)', () => {
    const h = buildRequestHeaders(
      { cookie: 'PHPSESSID=user_session; user_id=42' },
      { ...solvedCtx, cookieHeader: 'cf_clearance=solved; PHPSESSID=anonymous_solver' }
    );
    expect(h.Cookie).toBe(
      'cf_clearance=solved; PHPSESSID=user_session; user_id=42'
    );
  });

  it('mergeCookieHeaders handles missing/empty parts and junk entries', () => {
    expect(mergeCookieHeaders(undefined, 'a=1')).toBe('a=1');
    expect(mergeCookieHeaders('a=1', undefined)).toBe('a=1');
    expect(mergeCookieHeaders(undefined, undefined)).toBeUndefined();
    expect(mergeCookieHeaders('junk', 'a=1')).toBe('a=1');
    expect(mergeCookieHeaders('a=1; b=2', 'b=3')).toBe('a=1; b=3');
  });

  it('sends provider cookies unchanged when no context', () => {
    const h = buildRequestHeaders({ cookie: 'PHPSESSID=s1' });
    expect(h.Cookie).toBe('PHPSESSID=s1');
    expect(h['User-Agent']).toContain('Chrome/124');
  });

  it('identity-pinning callers get no context (fetcher passes ctx=null)', () => {
    const h = buildRequestHeaders(
      {
        cookie: 'a=1',
        headers: { 'User-Agent': 'PlayStation 4', Referer: 'https://x.pl/' },
      }
    );
    expect(h['User-Agent']).toBe('PlayStation 4');
    expect(h.Cookie).toBe('a=1');
    expect(h.Referer).toBe('https://x.pl/');
  });
});

describe('isCloudflareChallenge (regression)', () => {
  it('detects known challenge markers', () => {
    expect(
      isCloudflareChallenge(
        '<html><title>Just a moment...</title></html>'
      )
    ).toBe(true);
    expect(
      isCloudflareChallenge(
        '<html><title>Attention Required! | Cloudflare</title></html>'
      )
    ).toBe(true);
    expect(isCloudflareChallenge('<script>var cf_chl_opt = {};</script>')).toBe(
      true
    );
  });

  it('does not flag normal pages', () => {
    expect(
      isCloudflareChallenge('<html><title>Filman</title><body>x</body></html>')
    ).toBe(false);
    expect(isCloudflareChallenge('')).toBe(false);
  });
});

describe('CloudflareBlockedError messages', () => {
  it('with cookieHint: unchanged message', () => {
    const err = new CloudflareBlockedError('filman.cc', 'FILMAN_CC_COOKIE=...');
    expect(err.message).toBe(
      'filman.cc is protected by Cloudflare — set FILMAN_CC_COOKIE=... to access it'
    );
  });

  it('with cookieHint + solve failure note', () => {
    const err = new CloudflareBlockedError(
      'cda-hd.cc',
      'CDA_HD_CC_COOKIE=...',
      'FlareSolverr returned invalid JSON (HTTP 502)'
    );
    expect(err.message).toBe(
      'cda-hd.cc is protected by Cloudflare — set CDA_HD_CC_COOKIE=... to access it — FlareSolverr solve failed: FlareSolverr returned invalid JSON (HTTP 502)'
    );
  });

  it('without cookieHint: mentions FLARESOLVERR_URL + manual cookies', () => {
    const err = new CloudflareBlockedError('zaluknij.cc');
    expect(err.message).toBe(
      'zaluknij.cc is protected by Cloudflare — set FLARESOLVERR_URL (e.g. http://localhost:8191) to auto-bypass, or copy cf_clearance cookies manually'
    );
  });

  it('without cookieHint + solve failure note', () => {
    const err = new CloudflareBlockedError(
      'zaluknij.cc',
      undefined,
      'FlareSolverr could not solve zaluknij.cc: Challenge is not detected!'
    );
    expect(err.message).toBe(
      'zaluknij.cc is protected by Cloudflare — set FLARESOLVERR_URL (e.g. http://localhost:8191) to auto-bypass, or copy cf_clearance cookies manually — FlareSolverr solve failed: FlareSolverr could not solve zaluknij.cc: Challenge is not detected!'
    );
  });
});
