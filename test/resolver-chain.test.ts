import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyStreamUrl } from '../src/utils/resolvers/index.js';
import { resolveDood, doodEmbedHosts } from '../src/utils/resolvers/dood.js';
import { resolveMaxvod } from '../src/utils/resolvers/maxvod.js';

/**
 * curl (dood CF fallback) is disabled in tests by default — execFile rejects.
 * Individual tests re-mock it to simulate curl output. Global-fetch stubbing
 * for the rest — dood.ts / maxvod.ts sit inside index.ts's own import cycle,
 * so module-mocking index.js can't rebind their captured references; node
 * builtins have no cycle, so child_process CAN be module-mocked.
 */
const { execFileMock } = vi.hoisted(() => {
  const fn = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      cb(new Error('curl disabled in tests'), '', '');
    }
  );
  // promisify(execFile) must resolve {stdout, stderr} — attach node's custom
  // promisify symbol, otherwise it resolves the bare stdout string
  (fn as unknown as Record<symbol, unknown>)[
    Symbol.for('nodejs.util.promisify.custom')
  ] = (cmd: string, args: string[], opts: unknown) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      (
        fn as unknown as (
          c: string,
          a: string[],
          o: unknown,
          cb: (e: Error | null, stdout?: string, stderr?: string) => void
        ) => void
      )(cmd, args, opts, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      });
    });
  return { execFileMock: fn };
});

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

/** Full response stand-in for redirect:'follow' fetches (fetchEmbedText). */
function htmlRes(text: string, url: string): Response {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html' : null) },
    body: { cancel: async () => {} },
    text: async () => text,
  } as unknown as Response;
}

/** Headers-only stand-in for redirect:'manual' fetches (resolveMaxvod). */
function headersRes(status: number, headers: Record<string, string>): Response {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: { cancel: async () => {} },
  } as unknown as Response;
}

/** Default curl mock: reject (binary "missing") — tests re-mock as needed. */
function resetCurlMock(): void {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (e: Error | null, stdout?: string, stderr?: string) => void
    ) => {
      cb(new Error('curl disabled in tests'), '', '');
    }
  );
}

describe('dood resolver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCurlMock();
  });

  it('includes the dood-family alias hosts', () => {
    expect(doodEmbedHosts).toContain('myvidplay.com');
    expect(doodEmbedHosts).toContain('playmogo.com');
    expect(classifyStreamUrl('https://myvidplay.com/e/abc')).toBe('embed');
    expect(classifyStreamUrl('https://playmogo.com/e/abc')).toBe('embed');
  });

  it('sends the pass_md5 request to the final (post-redirect) origin', async () => {
    const inputUrl = 'https://myvidplay.com/e/abc123';
    const finalUrl = 'https://playmogo.com/e/abc123';
    const md5Path = '/pass_md5/8f3a/token';

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u === inputUrl) {
        // redirect followed — res.url is the FINAL url
        return htmlRes(`<script>var a='${md5Path}';</script>`, finalUrl);
      }
      if (u === `https://playmogo.com${md5Path}`) {
        return htmlRes('https://v.doodcdn.la/hls/x/playlist\n', u);
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveDood(inputUrl, 5_000);
    expect(out).not.toBeNull();
    expect(out!.url).toMatch(
      /^https:\/\/v\.doodcdn\.la\/hls\/x\/playlist[A-Za-z0-9]{10}\?token=token$/
    );
    // md5 request went to the final origin, not the input alias
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://playmogo.com${md5Path}`);
    // Referer still points at the original embed URL
    const headers = (fetchMock.mock.calls[1]?.[1] as { headers?: Record<string, string> })
      ?.headers;
    expect(headers?.Referer).toBe(inputUrl);
  });

  it('returns null when the embed page has no pass_md5 path (curl disabled)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlRes('<html><body>nothing</body></html>', 'https://playmogo.com/e/x'))
    );
    expect(await resolveDood('https://playmogo.com/e/x', 5_000)).toBeNull();
  });

  it('falls back to curl when node fetch is CF-blocked (403)', async () => {
    const md5Path = '/pass_md5/8f3a/token';
    // node fetch: everything 403s (dood Cloudflare wall, 2026-11-17)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        url: 'https://playmogo.com/e/abc',
        headers: { get: () => 'text/html' },
        body: { cancel: async () => {} },
        text: async () => '<html>challenge</html>',
      }))
    );
    // curl passes: embed page (with -w final-url trailer) then pass_md5 text
    execFileMock.mockImplementation(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb: (e: Error | null, stdout?: string) => void
      ) => {
        const url = args.at(-1) ?? '';
        if (url.includes('/e/')) {
          cb(null, `<script>var a='${md5Path}';</script>\n@@https://playmogo.com/e/abc`);
        } else if (url.includes('/pass_md5/')) {
          cb(null, 'https://v.doodcdn.la/hls/x/playlist\n@@' + url);
        } else {
          cb(new Error(`unexpected curl url: ${url}`));
        }
      }
    );

    const out = await resolveDood('https://playmogo.com/e/abc', 5_000);
    expect(out).not.toBeNull();
    expect(out!.url).toMatch(
      /^https:\/\/v\.doodcdn\.la\/hls\/x\/playlist[A-Za-z0-9]{10}\?token=token$/
    );
    expect(out!.headers).toEqual({ Referer: 'https://dood.la/' });
    // pass_md5 went to the curl-reported FINAL origin
    const md5Call = execFileMock.mock.calls.find((c) =>
      String(c[1].at(-1)).includes('/pass_md5/')
    );
    expect(String(md5Call?.[1].at(-1))).toBe(
      `https://playmogo.com${md5Path}`
    );
  });

  it('returns null when curl is unavailable (binary missing)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        url: 'https://playmogo.com/e/abc',
        headers: { get: () => 'text/html' },
        body: { cancel: async () => {} },
        text: async () => '<html>challenge</html>',
      }))
    );
    // execFileMock stays at its default rejecting implementation
    expect(await resolveDood('https://playmogo.com/e/abc', 5_000)).toBeNull();
  });
});

describe('maxvod resolver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetCurlMock();
  });

  it('returns the redirect target with site referer for media targets', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        headersRes(302, { location: 'https://cdn.maxvod.tv/v/file.mp4' })
      )
      .mockResolvedValueOnce(headersRes(206, { 'content-type': 'video/mp4' }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveMaxvod('https://maxvod.tv/player/play/uuid', 5_000);
    expect(out).toEqual({
      url: 'https://cdn.maxvod.tv/v/file.mp4',
      headers: { Referer: 'https://maxvod.tv/' },
    });
  });

  it('chains embed resolution for dood-family iframe targets', async () => {
    const target = 'https://myvidplay.com/e/abc?md5=x&expires=1';
    const md5Path = '/pass_md5/8f3a/token';
    // maxvod redirect → HTML embed target → real dood chain
    // (myvidplay "redirects" to playmogo = final url) → direct stream
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u === 'https://maxvod.tv/player/play/uuid') {
        return headersRes(302, { location: target });
      }
      if (u === target && init?.redirect === 'manual') {
        return headersRes(200, { 'content-type': 'text/html' });
      }
      if (u === target && init?.redirect !== 'manual') {
        return htmlRes(`<script>var a='${md5Path}';</script>`, 'https://playmogo.com/e/abc');
      }
      if (u === `https://playmogo.com${md5Path}`) {
        return htmlRes('https://v.doodcdn.la/hls/x/playlist\n', u);
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await resolveMaxvod('https://maxvod.tv/player/play/uuid', 5_000);
    expect(out).not.toBeNull();
    expect(out!.url).toMatch(
      /^https:\/\/v\.doodcdn\.la\/hls\/x\/playlist[A-Za-z0-9]{10}\?token=token$/
    );
    expect(out!.headers).toEqual({ Referer: 'https://dood.la/' });
  });

  it('returns null when the chained embed cannot be resolved', async () => {
    const target = 'https://playmogo.com/e/abc';
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u === 'https://maxvod.tv/player/play/uuid') {
        return headersRes(302, { location: target });
      }
      if (init?.redirect === 'manual') {
        return headersRes(200, { 'content-type': 'text/html' });
      }
      // embed page without a pass_md5 path → dood resolution fails
      return htmlRes('<html><body>nothing</body></html>', target);
    });
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveMaxvod('https://maxvod.tv/player/play/uuid', 5_000)).toBeNull();
  });

  it('returns null on login redirect', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(headersRes(302, { location: 'https://maxvod.tv/login' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveMaxvod('https://maxvod.tv/player/play/uuid', 5_000)).toBeNull();
  });
});
