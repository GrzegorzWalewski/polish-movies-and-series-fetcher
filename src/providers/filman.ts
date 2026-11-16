import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import {
  filmanIdentity,
  filmanOnChallenge,
  filmanOnLoginWall,
  isLoginWall,
  FilmanLoginWallError,
  BASE_URL,
  type FilmanIdentity,
} from '../utils/filman-session.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { CloudflareBlockedError } from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

/**
 * filman.cc requires a logged-in session behind a Cloudflare challenge.
 * Two modes (see utils/filman-session.ts):
 *  - auto (preferred): FLARESOLVERR_URL + FILMAN_CC_LOGIN + FILMAN_CC_PASSWORD
 *    + TWOCAPTCHA_API_KEY — CF re-solved daily by FlareSolverr, re-login via
 *    2Captcha only when the session itself dies
 *  - manual fallback: FILMAN_CC_COOKIE + FILMAN_CC_UA copied from browser
 */
const COOKIE_ENV = 'FILMAN_CC_COOKIE';
const UA_ENV = 'FILMAN_CC_UA';

function cookie(): string | undefined {
  return process.env[COOKIE_ENV]?.trim() || undefined;
}

function cookieHint(): string {
  return `set FLARESOLVERR_URL + FILMAN_CC_LOGIN + FILMAN_CC_PASSWORD + TWOCAPTCHA_API_KEY (auto mode), or FILMAN_CC_COOKIE=<cookie header from browser devtools> + FILMAN_CC_UA=<that browser's User-Agent> (manual)`;
}

const reqHeaders = (referer: string, ua?: string): Record<string, string> => ({
  Referer: referer,
  ...(ua ?? process.env[UA_ENV]?.trim()
    ? { 'User-Agent': ua ?? process.env[UA_ENV]!.trim() }
    : {}),
});

/** Identity-shaped auth from the manual env pair (used when auto is off). */
function manualAuth(): { cookie: string; ua: string | undefined } | null {
  const ck = cookie();
  return ck ? { cookie: ck, ua: process.env[UA_ENV]?.trim() } : null;
}

/**
 * Parse filman search results (#item-list grid). Each item is a bootstrap col
 * div: .poster > a[href="/m/..."|"/s/..."] with .film_title / .film_year as
 * siblings of .poster. Titles are "PL title / Original title".
 */
export function parseSearchHtml(html: string): (SiteMatch & { type: 'movie' | 'tv' })[] {
  const $ = cheerio.load(html);
  const results: (SiteMatch & { type: 'movie' | 'tv' })[] = [];
  const seen = new Set<string>();

  $('a[href*="/m/"], a[href*="/s/"]').each((_, el) => {
    const $el = $(el);
    const href = $el.attr('href') ?? '';
    // film_title/film_year live in the item container, not inside the anchor
    const $box = $el.closest('div[class*="col-"]');
    const title =
      $box.find('.film_title').text().trim() ||
      $el.attr('data-title')?.trim() ||
      $el.attr('title')?.trim() ||
      '';
    const type: 'movie' | 'tv' = href.includes('/s/') ? 'tv' : 'movie';
    const year = $box.find('.film_year').text().trim();

    if (title && href && !seen.has(href)) {
      seen.add(href);
      results.push({
        title: year ? `${title} (${year})` : title,
        url: absolutize(href),
        type,
      });
    }
  });
  return results;
}

function absolutize(href: string): string {
  return href.startsWith('http') ? href : BASE_URL + href;
}

/** Find episode link ([s01e02] tag, padding optional) from a series page. */
export function findEpisodeUrl(html: string, season: number, episode: number): string | null {
  const $ = cheerio.load(html);
  const re = new RegExp(`\\[s0?${season}e0?${episode}\\]`, 'i');
  let found: string | null = null;
  $('#episode-list a').each((_, el) => {
    if (found) return;
    const text = $(el).text();
    const href = $(el).attr('href') ?? '';
    if (re.test(text) || re.test(href)) {
      found = absolutize(href);
    }
  });
  return found;
}

interface LinkRow {
  server: string;
  version: string;
  quality: string;
  /** legacy generation: base64 JSON {src} in data-iframe */
  embedUrl: string | null;
  /** current generation: data-link-id + routeToken -> /link/token endpoint */
  linkId: string | null;
}

/** Parse both link-table generations from a title/episode page. */
export function parseLinkRows(html: string): LinkRow[] {
  const $ = cheerio.load(html);
  const rows: LinkRow[] = [];

  $('#links tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const server = $tr.find('img').attr('alt') ?? $tr.find('a').text().trim();
    const a = $tr.find('a').first();

    const iframeData = a.attr('data-iframe');
    let embedUrl: string | null = null;
    if (iframeData) {
      try {
        embedUrl = JSON.parse(
          Buffer.from(iframeData, 'base64').toString('utf-8')
        ).src ?? null;
      } catch {
        embedUrl = null;
      }
    }

    let quality = '';
    let version = '';
    $tr.find('td').each((_, td) => {
      const text = $(td).text().trim();
      if (/^\d+p$/i.test(text)) quality = text;
      if (/lektor|napisy|dubb|PL$|^PL$|ENG/i.test(text) && !quality) version = text;
    });

    if (server && (embedUrl || a.attr('data-link-id'))) {
      rows.push({
        server,
        version,
        quality,
        embedUrl,
        linkId: a.attr('data-link-id') ?? null,
      });
    }
  });

  return rows;
}

/** `var routeToken = '<alnum>'` from the page's inline script. */
export function extractRouteToken(html: string): string | null {
  return /var\s+routeToken\s*=\s*'([A-Za-z0-9]+)'/.exec(html)?.[1] ?? null;
}

/**
 * Decode the intermediate tmp-url page: vars _e (base64 payload), _a/_b/_c
 * (key parts); result[i] = base64decoded(_e)[i] XOR key[i % key.length].
 */
export function decodeTmpUrlPage(html: string): string | null {
  const e = /var\s+_e\s*=\s*'([^']+)'/.exec(html)?.[1];
  const a = /var\s+_a\s*=\s*'([^']+)'/.exec(html)?.[1];
  const b = /var\s+_b\s*=\s*'([^']+)'/.exec(html)?.[1];
  const c = /var\s+_c\s*=\s*'([^']+)'/.exec(html)?.[1];
  if (!e || !a || !b || !c) return null;

  const key = a + b + c;
  const raw = Buffer.from(e, 'base64');
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    out += String.fromCharCode(raw[i] ^ key.charCodeAt(i % key.length));
  }
  return out;
}

/** Resolve a current-generation link via the token endpoint. Returns
 * 'rate-limited' when the burst cap persists after the single wait-out. */
async function resolveTokenLink(
  pageUrl: string,
  row: LinkRow,
  routeToken: string,
  auth: { cookie?: string; ua?: string }
): Promise<string | 'rate-limited' | null> {
  if (!routeToken) return null;

  // the endpoint rejects requests right after page load (e2iplayer finding)
  await sleep(1100);

  const tokenUrl = `${BASE_URL}/link/token?link_id=${encodeURIComponent(row.linkId!)}&rt=${encodeURIComponent(routeToken)}`;
  const reqOpts = {
    headers: {
      ...reqHeaders(pageUrl, auth.ua),
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
    cookie: auth.cookie,
    site: 'filman.cc',
    retries: 0,
  };

  // the endpoint rate-limits bursts (HTTP 429 "Za szybko, spróbuj za chwilę")
  // with a cooldown in the 30s-2min range — wait it out once; if still
  // limited, give up (the caller marks the sweep rate-limited and falls back
  // to page-URL rows instead of burning the provider budget on more 429s)
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetchPage(tokenUrl, reqOpts);
      break;
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('HTTP 429')) return null;
      if (attempt === 0) await sleep(30000);
    }
  }
  if (!res) return 'rate-limited';

  const json = JSON.parse(await res.text()) as { url?: string };
  if (!json.url) return null;

  const tmpUrl = Buffer.from(json.url, 'base64').toString('utf-8');

  const tmpRes = await fetchPage(tmpUrl, {
    site: 'filman.cc',
    retries: 0,
  });
  const html = await tmpRes.text();
  return decodeTmpUrlPage(html) ?? tmpUrl;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Token endpoint has a per-page-load lag (1.1s) and a burst cap — resolve
 * at most this many links, two at a time. Sequential × all rows measured
 * 21-33s on a search page with 14 links. */
const MAX_TOKEN_LINKS = 8;
const TOKEN_CONCURRENCY = 2;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

async function resolveRows(
  html: string,
  pageUrl: string,
  routeToken: string,
  auth: { cookie?: string; ua?: string }
): Promise<StreamResult[]> {
  const rows = parseLinkRows(html);
  const seen = new Set<string>();
  const results: StreamResult[] = [];
  let rateLimited = false;

  // resolve token links first (concurrently, capped); direct-embed rows pass through
  const tokenIdx = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => !row.embedUrl && row.linkId)
    .slice(0, MAX_TOKEN_LINKS);
  const tokenUrls = await mapLimit(tokenIdx, TOKEN_CONCURRENCY, async ({ row }) => {
    if (rateLimited) return null;
    const resolved = await resolveTokenLink(pageUrl, row, routeToken, auth).catch(
      () => null
    );
    if (resolved === 'rate-limited') {
      rateLimited = true; // the whole burst is capped — stop burning requests
      return null;
    }
    return resolved;
  });

  rows.forEach((row, i) => {
    let url: string | null = row.embedUrl ?? null;
    if (!url && row.linkId) {
      const ti = tokenIdx.findIndex((t) => t.i === i);
      if (ti !== -1) url = tokenUrls[ti];
    }
    if (!url || seen.has(url)) return;
    seen.add(url);

    results.push({
      provider: 'filman.cc',
      quality: row.quality || null,
      language: row.version || null,
      url,
      label: `${row.server}${row.version ? ` (${row.version})` : ''}`,
    });
  });

  // burst-limited and nothing resolved: still surface one browser-openable
  // row so filman doesn't vanish from the results
  if (rateLimited && results.length === 0 && pageUrl) {
    results.push({
      provider: 'filman.cc',
      quality: null,
      language: null,
      url: pageUrl,
      label: 'page (rate-limited — open in browser)',
    });
  }
  return results;
}

async function searchOnce(
  params: ProviderSearchParams,
  query: string,
  identity: FilmanIdentity | null
): Promise<StreamResult[]> {
  const manual = manualAuth();
  const fetchOpts = identity
    ? {
        headers: {
          Referer: `${BASE_URL}/`,
          Cookie: identity.cookie,
          'User-Agent': identity.ua,
        },
        site: 'filman.cc',
        retries: 0,
      }
    : {
        headers: reqHeaders(`${BASE_URL}/`),
        cookie: manual?.cookie,
        site: 'filman.cc',
        cookieHint: cookieHint(),
      };
  const auth = identity ?? { cookie: manual?.cookie, ua: manual?.ua };

  // /search is the current endpoint (older /wyszukiwarka & /item now just
  // soft-redirect to the homepage with HTTP 200 — no 404 to trigger a fallback)
  const res = await fetchPage(
    `${BASE_URL}/search?phrase=${encodeURIComponent(query)}`,
    fetchOpts
  );

  const html = await res.text();
  // login wall — without an account filman shows the login page instead
  if (isLoginWall(html)) throw new FilmanLoginWallError();

  let items = parseSearchHtml(html);
  items = items.filter((i) => (params.type === 'tv' ? i.type === 'tv' : i.type === 'movie'));
  const matches = pickMatches(items, { ...params, title: query });
  if (matches.length === 0) return [];

  let pageUrl = matches[0].url;
  let routeToken = '';
  if (params.type === 'tv' && params.season && params.episode) {
    const seriesRes = await fetchPage(pageUrl, fetchOpts);
    const seriesHtml = await seriesRes.text();
    routeToken = extractRouteToken(seriesHtml) ?? '';
    const epUrl = findEpisodeUrl(seriesHtml, params.season, params.episode);
    if (!epUrl) return [];
    pageUrl = epUrl;
  }

  const pageRes = await fetchPage(pageUrl, fetchOpts);
  const pageHtml = await pageRes.text();
  routeToken = extractRouteToken(pageHtml) || routeToken;
  return resolveRows(pageHtml, pageUrl, routeToken, auth);
}

export const filman: Provider = {
  name: 'filman.cc',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);

    let identity: FilmanIdentity | null = await filmanIdentity();
    let challengeRetried = false;
    let loginRetried = false;

    // The identity (when present) is passed as explicit headers, so fetchPage
    // treats it as provider-owned and never injects the anonymous solver
    // session. Recovery is handled here instead:
    //  - CF challenge (clearance expired) -> re-solve, swap cf_clearance only
    //  - login wall (session died) -> full re-login via 2Captcha
    for (;;) {
      try {
        return await searchOnce(params, query, identity);
      } catch (err) {
        if (
          identity &&
          err instanceof CloudflareBlockedError &&
          !challengeRetried
        ) {
          challengeRetried = true;
          identity = (await filmanOnChallenge()) ?? identity;
          continue;
        }
        if (err instanceof FilmanLoginWallError && !loginRetried) {
          loginRetried = true;
          identity = await filmanOnLoginWall();
          if (identity) continue;
        }
        throw err;
      }
    }
  },
};
