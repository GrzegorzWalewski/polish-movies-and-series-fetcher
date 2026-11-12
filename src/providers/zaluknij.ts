import * as cheerio from 'cheerio';
import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://zaluknij.cc';

/** Hosts whose players need browser automation — excluded (as in zetta). */
const EXCLUDED_HOSTS = [
  'voe',
  'savefiles',
  'ups2up',
  'veev',
  'lulu',
  'vdo',
  'dood',
];

function isExcluded(text: string): boolean {
  const t = text.toLowerCase();
  return EXCLUDED_HOSTS.some((h) => t.includes(h));
}

/** Parse zaluknij search results page HTML. */
export function parseSearchHtml(html: string): SiteMatch[] {
  const $ = cheerio.load(html);
  const results: SiteMatch[] = [];

  let elements = $('#advanced-search a.item').toArray();
  if (elements.length === 0) {
    elements = $('.col-sm-4 a, .col-sm-2 a')
      .toArray()
      .filter(
        (el) =>
          $(el).attr('href')?.includes('/film/') ||
          $(el).attr('href')?.includes('/serial-online/')
      );
  }

  for (const el of elements) {
    let url = $(el).attr('href');
    const title =
      $(el).find('.title').text().trim() || $(el).attr('title')?.trim();
    if (title && url) {
      if (!url.startsWith('http')) url = BASE_URL + url;
      results.push({ title, url });
    }
  }
  return results;
}

/** Filter matches by media type based on zaluknij URL patterns. */
export function filterByType(
  matches: SiteMatch[],
  type: 'movie' | 'tv'
): SiteMatch[] {
  return matches.filter((m) => {
    const isSeries = m.url.includes('/serial-online/');
    return type === 'tv' ? isSeries : !isSeries;
  });
}

/**
 * Parse a zaluknij title/episode page: rows in table.table-bordered,
 * video URL from base64-encoded data-iframe JSON or href.
 */
export function parseTitleHtml(
  html: string,
  pageUrl: string
): StreamResult[] {
  const $ = cheerio.load(html);
  const sources: StreamResult[] = [];

  $('table.table-bordered tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const link = $(cells[1]).find('a').first();
    if (link.length === 0) return;

    const iframeData = link.attr('data-iframe');
    const version = $(cells[2]).text().trim();
    const quality = cells.length > 3 ? $(cells[3]).text().trim() : 'Auto';
    const hostName = link.text().trim();

    if (isExcluded(hostName)) return;

    let videoUrl: string | undefined;
    if (iframeData) {
      try {
        const json = JSON.parse(
          Buffer.from(iframeData, 'base64').toString('utf-8')
        );
        videoUrl = json.src;
      } catch {
        /* fall back to href */
      }
    }
    videoUrl ??= link.attr('href');

    if (videoUrl && videoUrl.length > 0) {
      if (videoUrl.startsWith('//')) videoUrl = `https:${videoUrl}`;
      if (isExcluded(videoUrl)) return;

      sources.push({
        provider: 'zaluknij.cc',
        quality: quality || 'Auto',
        language: version || null,
        url: videoUrl,
        label: `${hostName}${version ? ` (${version})` : ''}`,
      });
    }
  });

  return sources;
}

/** Find episode link ([s01e02] tag) from a series page. */
export function findEpisodeUrl(
  html: string,
  season: number,
  episode: number
): string | null {
  const $ = cheerio.load(html);
  const tag = `[s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}]`;
  let found: string | null = null;
  $('#episode-list a').each((_, el) => {
    if (found) return;
    if ($(el).text().includes(tag)) {
      const href = $(el).attr('href');
      if (href) {
        found = href.startsWith('http') ? href : BASE_URL + href;
      }
    }
  });
  return found;
}

export const zaluknij: Provider = {
  name: 'zaluknij.cc',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const searchUrl = `${BASE_URL}/wyszukiwarka?phrase=${encodeURIComponent(query)}`;

    // CF-protected: fetchPage throws CloudflareBlockedError on challenge pages
    const searchRes = await fetchPage(searchUrl, { site: this.name });
    const matches = filterByType(
      pickMatches(parseSearchHtml(await searchRes.text()), {
        ...params,
        title: query,
      }),
      params.type
    );
    if (matches.length === 0) return [];

    let fetchUrl = matches[0].url;

    if (params.type === 'tv' && params.season && params.episode) {
      const seriesRes = await fetchPage(fetchUrl, { site: this.name });
      const epUrl = findEpisodeUrl(
        await seriesRes.text(),
        params.season,
        params.episode
      );
      if (epUrl) fetchUrl = epUrl;
    }

    const titleRes = await fetchPage(fetchUrl, { site: this.name });
    return parseTitleHtml(await titleRes.text(), fetchUrl);
  },
};
