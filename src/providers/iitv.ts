import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { cleanTitle, matchesQuery } from './match.js';

const BASE_URL = 'https://iitv.info';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
  site: 'iitv.info',
};

export interface SeriesItem {
  /** Polish title (data-title) */
  title: string;
  /** original title (data-title-original) */
  titleOriginal: string;
  /** relative url, e.g. serial,1043,07-zglos-sie.html */
  url: string;
  slug: string;
}

/**
 * The homepage embeds a full client-side searchable list of every series
 * (#allSeries, 1290 entries) — no server search endpoint exists.
 */
export function parseSeriesList(html: string): SeriesItem[] {
  const start = html.indexOf('<ul id="allSeries"');
  if (start === -1) return [];
  const region = html.slice(start, html.indexOf('</ul>', start));

  const items: SeriesItem[] = [];
  const seen = new Set<string>();
  const re =
    /<li data-title="([^"]*)"\s+data-title-original="([^"]*)">\s*<a href="(serial,\d+,[^"]+)"/g;
  for (const m of region.matchAll(re)) {
    const url = m[3];
    if (seen.has(url)) continue;
    seen.add(url);
    const sm = /serial,\d+,([^"]+)\.html/.exec(url);
    if (!sm) continue;
    items.push({
      title: m[1].trim(),
      titleOriginal: m[2].trim(),
      url,
      slug: sm[1],
    });
  }
  return items;
}

/** match Polish or original title against either TMDB title */
export function pickSeries(
  items: SeriesItem[],
  plTitle: string,
  originalTitle: string
): SeriesItem | null {
  const q1 = cleanTitle(plTitle);
  const q2 = cleanTitle(originalTitle);
  const matches = items.filter(
    (s) =>
      matchesQuery(s.title, q1) ||
      matchesQuery(s.titleOriginal, q1) ||
      matchesQuery(s.title, q2) ||
      matchesQuery(s.titleOriginal, q2)
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) => a.title.length - b.title.length)[0];
}

/** episode pages use s01e05-style tokens; unpadded also resolves */
export function episodeUrl(slug: string, season: number, episode: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${BASE_URL}/epizod,${slug},s${pad(season)}e${pad(episode)}.html`;
}

/** the generic homepage title = site 301'd us (unknown series/episode) */
export function isHomepageShell(html: string): boolean {
  return /<title>\s*iitv\.info - seriale online\s*<\/title>/.test(html);
}

export interface PlayerLink {
  /** relative data-href, e.g. show-player,5569689,35904.html */
  href: string;
  /** hoster label from the anchor text */
  hoster: string;
}

/** player link list on an episode page */
export function parsePlayerLinks(html: string): PlayerLink[] {
  const links: PlayerLink[] = [];
  const seen = new Set<string>();
  const re =
    /<a[^>]+data-href="(show-player,\d+,\d+\.html)"[^>]*>([^<]*)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const href = m[1];
    const hoster = m[2].trim();
    if (!href || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, hoster });
  }
  return links;
}

/**
 * show-player fragments only load via XHR (X-Requested-With header); the
 * fragment wraps the real hoster embed in a class="external-link" anchor.
 */
export function parsePlayerFragment(html: string): string | null {
  const m =
    /class="external-link"\s+href="(https?:\/\/[^"]+)"/.exec(html) ??
    /href="(https?:\/\/[^"]+)"[^>]*class="external-link"/.exec(html);
  return m?.[1].replace(/&amp;/g, '&') ?? null;
}

async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await fetchPage(url, {
    ...fetchOpts,
    headers: {
      ...fetchOpts.headers,
      ...(referer ? { Referer: referer } : {}),
    },
  });
  return res.text();
}

async function fetchPlayerFragment(
  href: string,
  episodeUrl: string
): Promise<string | null> {
  const res = await fetchPage(`${BASE_URL}/${href}`, {
    ...fetchOpts,
    headers: {
      ...fetchOpts.headers,
      Referer: episodeUrl,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  const url = parsePlayerFragment(await res.text());
  return url;
}

export const iitv: Provider = {
  name: 'iitv.info',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    if (params.type !== 'tv' || !params.episode) return [];

    const series = pickSeries(
      parseSeriesList(await fetchHtml(`${BASE_URL}/`)),
      params.title,
      params.originalTitle
    );
    if (!series) return [];

    const epUrl = episodeUrl(series.slug, params.season ?? 1, params.episode);
    const epHtml = await fetchHtml(epUrl);
    if (isHomepageShell(epHtml)) return [];

    const links = parsePlayerLinks(epHtml).slice(0, 6);
    const out: StreamResult[] = [];
    const seen = new Set<string>();
    for (const link of links) {
      const url = await fetchPlayerFragment(link.href, epUrl).catch(() => null);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        provider: 'iitv.info',
        quality: null,
        language: null,
        url,
        label: link.hoster || undefined,
      });
    }
    return out;
  },
};
