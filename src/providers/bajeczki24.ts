import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://bajeczki24.pl';

/**
 * The site's search box talks to a Meilisearch proxy with a public key from
 * its own Search.*.js bundle (see e2iplayer hostbajeczki24.py).
 */
const SEARCH_API = 'https://api.bajeczki24.pl/radar/v1/multi-search';
const SEARCH_KEY =
  '118b6cd0fd246c02d4fe6465a1e5c16d7ce09fb67935180da44a060db68855c2';
const SEARCH_PAGE_SIZE = 30;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface BajeczkiHit {
  path?: string;
  title?: string;
  releaseYear?: number | string;
}

export interface BajeczkiSearchResponse {
  hits?: BajeczkiHit[];
  estimatedTotalHits?: number;
}

/** Parse the federated multi-search response into site matches. */
export function parseSearchResponse(
  data: BajeczkiSearchResponse
): (SiteMatch & { type: 'movie' | 'tv' })[] {
  const hits = data.hits ?? [];
  const results: (SiteMatch & { type: 'movie' | 'tv' })[] = [];
  const seen = new Set<string>();

  for (const hit of hits) {
    const path = hit.path ?? '';
    const title = (hit.title ?? '').trim();
    if (!path || !title || seen.has(path)) continue;

    let type: 'movie' | 'tv';
    if (path.startsWith('/filmy/')) type = 'movie';
    else if (path.startsWith('/seriale/') || path.startsWith('/bajki/'))
      type = 'tv';
    else continue;

    seen.add(path);
    const year = String(hit.releaseYear ?? '').trim();
    results.push({
      title: year ? `${title} (${year})` : title,
      url: BASE_URL + path,
      type,
    });
  }
  return results;
}

async function apiSearch(query: string): Promise<BajeczkiSearchResponse> {
  const res = await fetch(SEARCH_API, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${SEARCH_KEY}`,
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
    },
    body: JSON.stringify({
      queries: [
        { indexUid: 'movies-v2', q: query },
        { indexUid: 'tv-shows-v2', q: query },
      ],
      federation: { offset: 0, limit: SEARCH_PAGE_SIZE },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`bajeczki24 search API: HTTP ${res.status}`);
  return (await res.json()) as BajeczkiSearchResponse;
}

/** Season numbers from a series page: <a href="N/"> <article> ... </article> */
export function parseSeasonDirs(html: string): number[] {
  const $ = cheerio.load(html);
  const nums: number[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = /^(\d+)\/$/.exec(href);
    if (m && $(el).find('article').length > 0) {
      const n = Number(m[1]);
      if (!nums.includes(n)) nums.push(n);
    }
  });
  return nums.sort((a, b) => a - b);
}

/** Episode numbers from a season page (same card shape as seasons). */
export function parseEpisodeDirs(html: string): number[] {
  return parseSeasonDirs(html);
}

/**
 * Player iframes from a movie/episode page. Single Byse embed per title
 * typically; protocol-relative srcs get https: prefixed.
 */
export function parseEmbedUrls(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];
  $('iframe[src]').each((_, el) => {
    let src = ($(el).attr('src') ?? '').replace(/&amp;/g, '&');
    if (src.startsWith('//')) src = 'https:' + src;
    if (src.startsWith('http') && !urls.includes(src)) urls.push(src);
  });
  return urls;
}

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export const bajeczki24: Provider = {
  name: 'bajeczki24.pl',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const data = await apiSearch(query);
    const items = parseSearchResponse(data).filter((i) => i.type === params.type);
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const fetchOpts = {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
      site: 'bajeczki24.pl',
    };

    let pageUrl = matches[0].url;
    if (params.type === 'tv' && params.season && params.episode) {
      const seriesHtml = await (await fetchPage(pageUrl, fetchOpts)).text();
      if (!parseSeasonDirs(seriesHtml).includes(params.season)) return [];
      pageUrl = pageUrl.replace(/\/$/, '') + `/${params.season}/`;
      const seasonHtml = await (await fetchPage(pageUrl, fetchOpts)).text();
      if (!parseEpisodeDirs(seasonHtml).includes(params.episode)) return [];
      pageUrl = pageUrl + `${params.episode}/`;
    }

    const html = await (await fetchPage(pageUrl, fetchOpts)).text();
    return parseEmbedUrls(html).map((url) => ({
      provider: 'bajeczki24.pl',
      quality: null,
      language: null,
      url,
      label: hostname(url),
    }));
  },
};
