import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://ekino-tv.pl';

const HEADERS = {
  Referer: 'https://ekino-tv.pl/',
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
    return parseWatchHtml(await watchRes.text(), fetchUrl);
  },
};
