import { describe, it, expect } from 'vitest';

import {
  isCloudflareChallenge,
  providerOwnsIdentity,
} from '../src/utils/fetcher.js';
import { CloudflareBlockedError } from '../src/types.js';

describe('providerOwnsIdentity', () => {
  it('is true when opts.cookie is set', () => {
    expect(providerOwnsIdentity({ cookie: 'cf_clearance=x' })).toBe(true);
  });

  it('is true when headers.Cookie is set', () => {
    expect(providerOwnsIdentity({ headers: { Cookie: 'a=b' } })).toBe(true);
  });

  it('is true when an explicit User-Agent header is set', () => {
    expect(
      providerOwnsIdentity({ headers: { 'User-Agent': 'PlayStation 4' } })
    ).toBe(true);
  });

  it('is false for plain fetches (no cookie, no UA override)', () => {
    expect(providerOwnsIdentity({})).toBe(false);
    expect(providerOwnsIdentity({ headers: { 'Accept-Language': 'pl' } })).toBe(
      false
    );
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
