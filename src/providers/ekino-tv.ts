import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import { absorbCookies } from '../utils/filman-session.js';
import { solveTurnstile } from '../utils/twocaptcha.js';
import { DEFAULT_EMBED_UA } from '../utils/resolvers/index.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

// ekino-tv.pl is a permanent 301 → ekino.ws (2026-11); hit the new domain
// directly. Provider name / FlareSolverr site key stay 'ekino-tv.pl'.
const BASE_URL = 'https://ekino.ws';

const HEADERS = {
  Referer: 'https://ekino.ws/',
};

/** Parse ekino-tv search results page HTML. */
export function parseSearchHtml(html: string): SiteMatch[] {
  const $ = cheerio.load(html);
  const results: SiteMatch[] = [];
  $('.movies-list-item, .list-item, .movie-item').each((_, el) => {
    const a = $(el).find('.title a, .name a, h2 a').first();
    let url = a.attr('href');
    const title = a.text().trim();
    if (title && url) {
      if (!url.startsWith('http')) url = BASE_URL + url;
      // release year lives in the item id, e.g. "wiedzmin-the-witcher-2019-12-20-..."
      const year = /-(19|20)\d{2}-/.exec($(el).attr('id') ?? '')?.[0]?.replace(/-/g, '');
      results.push({ title, url, year });
    }
  });
  return results;
}

/** Parse the ekino watch page for player ids (server list). */
export function parseWatchHtml(
  html: string,
  fetchUrl: string
): StreamResult[] {
  const $ = cheerio.load(html);
  const sources: StreamResult[] = [];
  const seen = new Set<string>();

  $('.players li, .player-item, [data-id]').each((_, el) => {
    const id = $(el).attr('data-id');
    const nameAttr = $(el).attr('data-name');
    const sName = $(el).text().trim().split('\n')[0].trim();

    if (id && id.length > 5) {
      const serverName = (nameAttr ?? sName)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      if (
        serverName.includes('mix') ||
        serverName.includes('upzone') ||
        serverName.includes('voe')
      )
        return;
      const url = `${BASE_URL}/watch/f/${serverName}/${id}`;
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({
          provider: 'ekino-tv.pl',
          quality: 'HD',
          language: null,
          url,
          label: sName.toUpperCase(),
        });
      }
    }
  });

  // inline ShowPlayer("name", "id") calls in scripts
  const re = /ShowPlayer\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/gi;
  for (const m of html.matchAll(re)) {
    const sName = m[1];
    const id = m[2];
    const lowerName = sName.toLowerCase();
    if (
      lowerName.includes('mix') ||
      lowerName.includes('upzone') ||
      lowerName.includes('voe')
    )
      continue;
    const url = `${BASE_URL}/watch/f/${lowerName}/${id}`;
    if (!seen.has(url)) {
      seen.add(url);
      sources.push({
        provider: 'ekino-tv.pl',
        quality: 'HD',
        language: null,
        url,
        label: sName.toUpperCase(),
      });
    }
  }

  // fallback: the watch page itself is a playable player — movies only
  // (a series show page has no /watch/ equivalent without an episode)
  if (sources.length === 0 && fetchUrl.includes('/movie/')) {
    sources.push({
      provider: 'ekino-tv.pl',
      quality: 'Auto',
      language: null,
      url: fetchUrl.replace('/show/', '/watch/'),
      label: 'DEFAULT PLAYER',
    });
  }

  return sources;
}

/** Build the watch URL for a series episode (port of zetta slug logic). */
export function buildEpisodeUrl(
  originalUrl: string,
  season: number,
  episode: number
): string {
  const pathParts = originalUrl.split('/show/').pop()?.split('/') ?? [];
  let slug = pathParts[0] ?? '';
  if (/^\d+$/.test(slug) && pathParts.length > 1) slug = pathParts[1];
  if (slug.endsWith('/')) slug = slug.slice(0, -1);
  if (!slug) slug = pathParts[0] ?? '';
  return `${BASE_URL}/serie/watch/${slug}+season[${season}]+episode[${episode}]+`;
}

// ---------------------------------------------------------------------------
// watch/f interstitial handling
//
// Two interstitial shapes exist:
//   1. "player" server → href to a single-use play.ekino.link token whose
//      page embeds the real hoster iframe (byse-family mfw09.org etc.)
//   2. direct hoster link in the button anchor (class "buttonprch"), e.g.
//      dood.la/d/...
// Some sessions additionally hit a Cloudflare Turnstile gate first
// (sitekey rendered, callback $.post('/watch/verify.php', {verify: token}) →
// server-side session → reload shows the real interstitial).

/** Pure: does this page carry the Turnstile gate? */
export function isEkinoGate(html: string): boolean {
  return html.includes('verify.php') && /turnstile/i.test(html);
}

/** Pure: extract the interstitial's target (play token or direct hoster link). */
export function extractEkinoTarget(html: string): string | null {
  const play = /href="?(https:\/\/play\.ekino\.link\/[A-Za-z0-9_-]{20,})/.exec(html)?.[1];
  if (play) return play;
  // button anchor — href/class attribute order varies
  const anchor =
    /<a[^>]*class="[^"]*buttonprch[^"]*"[^>]*href=?"?(https?:\/\/[A-Za-z0-9_./?%=&:#-]+)/i.exec(html)?.[1] ??
    /<a[^>]*href=?"?(https?:\/\/[A-Za-z0-9_./?%=&:#-]+)"?[^>]*class="[^"]*buttonprch[^"]*"/i.exec(html)?.[1];
  return anchor ?? null;
}

/** Pure: form body the gate JS posts ($.post serialize shape). */
export function buildVerifyBody(token: string): string {
  return new URLSearchParams({ verify: token }).toString();
}

interface EkinoGateSession {
  cookieHeader: string;
  ua: string;
  savedAt: number;
}

let gateSession: EkinoGateSession | null = null;
let gateInflight: Promise<EkinoGateSession | null> | null = null;

/** Test hook. */
export function resetEkinoGateForTests(): void {
  gateSession = null;
  gateInflight = null;
}

const GATE_TIMEOUT_MS = 20_000;

/**
 * Solve the Turnstile gate once: GET the watch page (seed cookies),
 * solve via 2Captcha, POST /watch/verify.php {verify} (form-encoded,
 * per the page's own $.post), absorb the session Set-Cookie.
 */
async function solveGateSession(watchUrl: string): Promise<EkinoGateSession | null> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY?.trim();
  if (!apiKey) return null;
  const ua = DEFAULT_EMBED_UA;
  try {
    const p1 = await fetch(watchUrl, {
      headers: { 'User-Agent': ua, Referer: HEADERS.Referer },
      redirect: 'follow',
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    let jar = absorbCookies('', p1.headers.getSetCookie());
    await p1.text();

    const token = await solveTurnstile(apiKey, '0x4AAAAAAAFuHEOflkh2qqPw', watchUrl);

    const p2 = await fetch(`${BASE_URL}/watch/verify.php`, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        Referer: watchUrl,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(jar ? { Cookie: jar } : {}),
      },
      body: buildVerifyBody(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    jar = absorbCookies(jar, p2.headers.getSetCookie());
    const re = (await p2.json().catch(() => null)) as { error?: unknown } | null;
    if (re && re.error) return null;
    if (!jar) return null;
    return { cookieHeader: jar, ua, savedAt: Date.now() };
  } catch {
    return null;
  }
}

/** Single-flight: parallel resolves share one solve (captcha spend). */
async function ensureGateSession(watchUrl: string): Promise<EkinoGateSession | null> {
  if (gateSession) return gateSession;
  if (!gateInflight) {
    gateInflight = solveGateSession(watchUrl)
      .then((s) => {
        gateSession = s;
        gateInflight = null;
        return s;
      })
      .catch(() => {
        gateInflight = null;
        return null;
      });
  }
  return gateInflight;
}

/** Re-fetch the watch page with the verified session; null on failure. */
async function fetchBehindGate(watchUrl: string, sess: EkinoGateSession): Promise<string | null> {
  try {
    const res = await fetch(watchUrl, {
      headers: { 'User-Agent': sess.ua, Referer: HEADERS.Referer, Cookie: sess.cookieHeader },
      redirect: 'follow',
      signal: AbortSignal.timeout(GATE_TIMEOUT_MS),
    });
    const html = await res.text();
    return extractEkinoTarget(html);
  } catch {
    return null;
  }
}

/**
 * watch/f URLs are interstitials ("Przejdź do odtwarzacza" button): either a
 * single-use play.ekino.link token whose page embeds the real hoster player,
 * or a direct hoster link in the button anchor. A Turnstile gate may front
 * both (solved once per process via 2Captcha; rows stay external without a
 * TWOCAPTCHA_API_KEY). Follow the chain server-side and return the embed /
 * direct URL so the resolver layer can make it playable. Any failure → null
 * (keep the interstitial URL as external).
 */
export async function resolveEkinoWatch(watchUrl: string): Promise<string | null> {
  try {
    const wRes = await fetchPage(watchUrl, {
      headers: HEADERS,
      site: 'ekino-tv.pl',
      retries: 0,
    });
    const html = await wRes.text();

    let target = extractEkinoTarget(html);
    if (!target && isEkinoGate(html)) {
      let sess = await ensureGateSession(watchUrl);
      if (sess) {
        target = await fetchBehindGate(watchUrl, sess);
        if (!target) {
          // cached session died (or was never valid) — one fresh solve
          gateSession = null;
          sess = await solveGateSession(watchUrl);
          if (sess) {
            gateSession = sess;
            target = await fetchBehindGate(watchUrl, sess);
          }
        }
      }
    }
    if (!target) return null;

    // play.ekino.link tokens need one more hop: the token page embeds the hoster
    if (!target.includes('play.ekino.link')) return target;

    const pRes = await fetchPage(target, {
      headers: { Referer: 'https://ekino.ws/' },
      site: 'ekino-tv.pl',
      retries: 0,
    });
    const src = /<iframe[^>]*\ssrc="(https?:\/\/[^"]+)"/i.exec(
      await pRes.text()
    )?.[1];
    return src ?? null;
  } catch {
    return null;
  }
}

export const ekinoTv: Provider = {
  name: 'ekino-tv.pl',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const searchUrl = `${BASE_URL}/search/qf/?q=${encodeURIComponent(query)}`;
    const res = await fetchPage(searchUrl, {
      headers: HEADERS,
      site: this.name,
    });

    const matches = pickMatches(parseSearchHtml(await res.text()), {
      ...params,
      title: query,
    });

    // ekino urls: movies live under /movie/show/, series under /serie/show/
    // — never fall back to a match of the other type (a movie must not
    // resolve to a series page; that produced broken watch URLs)
    const best = matches.find((m) =>
      params.type === 'tv'
        ? m.url.includes('/serie/')
        : m.url.includes('/movie/')
    );
    if (!best) return [];

    let fetchUrl = best.url;
    if (params.type === 'tv' && params.season && params.episode) {
      fetchUrl = buildEpisodeUrl(best.url, params.season, params.episode);
    }

    const watchRes = await fetchPage(fetchUrl, {
      headers: HEADERS,
      site: this.name,
    });
    let sources = parseWatchHtml(await watchRes.text(), fetchUrl);

    // swap the first few interstitial URLs for real hoster embeds (tokens
    // are single-use; unresolved ones stay as browser-playable externals)
    const swapped: StreamResult[] = [];
    await Promise.all(
      sources.map(async (s, i) => {
        if (i < 3 && s.url.includes('/watch/f/')) {
          const embed = await resolveEkinoWatch(s.url);
          swapped.push(embed ? { ...s, url: embed } : s);
        } else {
          swapped.push(s);
        }
      })
    );
    sources = swapped;

    return sources;
  },
};
