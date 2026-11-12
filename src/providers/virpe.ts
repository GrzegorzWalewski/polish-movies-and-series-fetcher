import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://virpe.cc';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
  site: 'virpe.cc',
};

/** film section URLs: everything under them is a movie article */
const FILM_RE =
  /\/(?:filmy-polskie-online-za-darmo|online-filmy-zagraniczne-za-darmo)\//;
const SEASON_RE = /\bsezon[\s-]*(\d+)/i;
const EPISODE_RE = /odcinek\s*(\d+)/i;

export interface SearchItem extends SiteMatch {
  /** series = season category dir, movie = film article, episode = stray article */
  kind: 'series' | 'movie' | 'episode';
  season: number;
}

export interface EpisodeItem {
  url: string;
  title: string;
  episode: number;
}

function cleanFragment(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

/** "Przyjaciółki sezon 9" / "Przyjaciółki 26" -> ("Przyjaciółki", 9|26) */
export function seriesTitle(title: string, url: string): [string, number] {
  const sm = SEASON_RE.exec(title);
  if (sm) return [title.replace(/\s*-?\s*\bsezon[\s-]*\d+\s*/i, ' ').trim(), Number(sm[1])];
  const um = /-(\d{1,4})\/?$/.exec(url);
  const tm = /\s+(\d{1,4})$/.exec(title);
  if (um && tm && um[1] === tm[1]) {
    return [title.slice(0, tm.index).trim(), Number(tm[1])];
  }
  return [title.trim(), 0];
}

/**
 * Parse `search.html?searchword=` results: <li class="rowN"> blocks between
 * `<div class="searchresults">` and the closing `</ul>`.
 */
export function parseSearchHtml(html: string): SearchItem[] {
  let body = html.includes('<div class="searchresults">')
    ? html.slice(html.indexOf('<div class="searchresults">'))
    : html;
  body = body.split('</ul>')[0];

  const items: SearchItem[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(
    /<li class="row\d">\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<span class="small">([^<]*)<\/span>/g
  )) {
    const url = m[1].replace(/&amp;/g, '&');
    const title = cleanFragment(m[2]);
    const section = m[3];
    if (!title || seen.has(url)) continue;
    // audiobooks and news flashes are out of scope
    if (/ksiazki-audio/.test(url)) continue;
    if (url.endsWith('/') && !/Category List/i.test(section)) continue;
    seen.add(url);

    if (url.endsWith('/')) {
      const [base, season] = seriesTitle(title, url);
      items.push({ title: base, url, kind: 'series', season });
    } else if (FILM_RE.test(url)) {
      items.push({ title, url, kind: 'movie', season: 0 });
    } else if (url.endsWith('.html')) {
      items.push({ title, url, kind: 'episode', season: 0 });
    }
  }
  return items;
}

/** Episode rows `<li class="sectiontableentryN"><a href=...>Title</a>` inside `<ul class="table">` */
export function parseEpisodeList(html: string): EpisodeItem[] {
  const items: EpisodeItem[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(
    /<li class="sectiontableentry\d"\s*>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  )) {
    const url = m[1].replace(/&amp;/g, '&');
    const title = cleanFragment(m[2]);
    const em = EPISODE_RE.exec(title);
    if (!url.endsWith('.html') || !em || seen.has(url)) continue;
    seen.add(url);
    items.push({ url, title, episode: Number(em[1]) });
  }
  return items;
}

/**
 * Hoster links from an episode article: `<p class="server"><b><a href="url">label`.
 */
export function parseServerLinks(html: string): { url: string; label: string }[] {
  let body = html.includes('<div id="elxisarticle')
    ? html.slice(html.indexOf('<div id="elxisarticle'))
    : html;
  body = body.split('<div style="clear:both;"></div>')[0];

  const out: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(
    /<p class="server"><b><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  )) {
    const url = m[1].replace(/&amp;/g, '&');
    const label = cleanFragment(m[2]);
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label });
  }
  return out;
}

/** Embed iframes from a movie article body. */
export function parseMovieSources(html: string): string[] {
  let body = html.includes('<div id="elxisarticle')
    ? html.slice(html.indexOf('<div id="elxisarticle'))
    : html;
  body = body.split('<div style="clear:both;"></div>')[0];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<iframe[^>]+src="([^"]+)"/g)) {
    let url = m[1].replace(/&amp;/g, '&');
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Long categories paginate 20 rows/page (Elxis ?page=N, zero-based), but
 * episode URLs are formulaic: swap the odcinek number in any seen episode url.
 */
function deriveEpisodeUrl(
  episodes: EpisodeItem[],
  episode: number
): string | null {
  const anyEp = episodes[0];
  if (!anyEp) return null;
  const candidate = anyEp.url.replace(
    /(odcinek-)(\d+)(\.html)/i,
    `$1${episode}$3`
  );
  return candidate === anyEp.url ? null : candidate;
}

async function fetchHtml(url: string, extra: object = {}): Promise<string> {
  const res = await fetchPage(url, {
    ...fetchOpts,
    ...extra,
  } as typeof fetchOpts);
  return res.text();
}

async function searchSite(query: string): Promise<string> {
  return fetchHtml(
    `${BASE_URL}/search.html?searchword=${encodeURIComponent(query)}&ordering=category`
  );
}

export const virpe: Provider = {
  name: 'virpe.cc',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    let items = parseSearchHtml(await searchSite(query));

    if (params.type === 'movie') {
      const matches = pickMatches(
        items.filter((i) => i.kind === 'movie'),
        { ...params, title: query }
      );
      if (matches.length === 0) return [];
      const article = await fetchHtml(matches[0].url);
      const urls = parseMovieSources(article);
      const servers = parseServerLinks(article);
      const all = [
        ...urls.map((url) => ({ url, label: hostname(url) })),
        ...servers,
      ];
      return all.map((s) => ({
        provider: 'virpe.cc',
        quality: null,
        language: null,
        url: s.url,
        label: hostname(s.url),
      }));
    }

    // tv: candidates are season categories; prefer the matching season
    let series = pickMatches(
      items.filter((i) => i.kind === 'series'),
      { ...params, title: query }
    );
    if (series.length === 0) {
      // long-running shows list seasons as separate categories — retry scoped
      items = parseSearchHtml(
        await searchSite(`${query} sezon ${params.season ?? ''}`.trim())
      );
      series = pickMatches(
        items.filter((i) => i.kind === 'series'),
        { ...params, title: query }
      );
    }
    if (series.length === 0) return [];

    const withSeason =
      (params.season && series.find((s) => s.season === params.season)) ||
      undefined;
    const category = withSeason ?? series[0];

    let episodes = parseEpisodeList(await fetchHtml(category.url));
    const target = episodes.find((e) => e.episode === params.episode);
    const articleUrl =
      target?.url ??
      (params.episode ? deriveEpisodeUrl(episodes, params.episode) : null);
    if (!articleUrl) return [];

    const article = await fetchHtml(articleUrl);
    const servers = parseServerLinks(article);
    const iframes = parseMovieSources(article);
    return [
      ...servers,
      ...iframes.map((url) => ({ url, label: hostname(url) })),
    ].map((s) => ({
      provider: 'virpe.cc',
      quality: null,
      language: null,
      url: s.url,
      label: hostname(s.url),
    }));
  },
};
