import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';
import { loadEnvFile } from '../utils/env.js';

const BASE_URL = 'https://cda-hd.cc';

const COOKIE_ENV = 'CDA_HD_CC_COOKIE';
const UA_ENV = 'CDA_HD_CC_UA';

function cookieHeader(): string | undefined {
  loadEnvFile();
  return process.env[COOKIE_ENV]?.trim() || undefined;
}

function cookieHint(): string {
  return `${COOKIE_ENV}=<cf_clearance cookie copied from your browser devtools> and ${UA_ENV}=<that browser's exact User-Agent>`;
}

/** "Title / Original (2025)" -> ("Title / Original", "2025") */
export function splitTitle(raw: string): [string, string] {
  const m = /^(.*?)\s*\(((?:19|20)\d{2})\)\s*$/.exec(raw.trim());
  return m ? [m[1], m[2]] : [raw.trim(), ''];
}

function cleanFragment(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export interface SearchTile extends SiteMatch {
  type: 'movie' | 'tv';
  quality: string;
}

/**
 * Search/list tiles: `<div id="mt-N" class="item">` blocks — `<a href>` page
 * url (`/tvshows/` = series, numeric id = movie), `<span class="tt">title
 * (year)</span>`, `<span class="year">`, `<span class="calidad2">quality`.
 */
export function parseSearchHtml(html: string): SearchTile[] {
  const results: SearchTile[] = [];
  const seen = new Set<string>();
  const tiles = html.split('<div id="mt-').slice(1);

  for (const tile of tiles) {
    const url = /<a href="([^"]+)"/.exec(tile)?.[1] ?? '';
    const rawTitle = cleanFragment(/<span class="tt">([\s\S]*?)<\/span>/.exec(tile)?.[1] ?? '');
    if (!url || !rawTitle || seen.has(url)) continue;
    seen.add(url);
    const [title, yearFromTitle] = splitTitle(rawTitle);
    const year =
      yearFromTitle ||
      (/<span class="year">\s*(\d{4})/.exec(tile)?.[1] ?? '');
    const quality =
      cleanFragment(/<span class="calidad2">([^<]+)</.exec(tile)?.[1] ?? '');
    results.push({
      title: year ? `${title} (${year})` : title,
      url,
      year,
      type: url.includes('/tvshows/') ? 'tv' : 'movie',
      quality,
    });
  }
  return results;
}

export interface SeasonEpisodes {
  [season: number]: { episode: number; url: string; name: string }[];
}

/**
 * "Sezony i odcinki" block: `<div class="se-c">` season blocks, each
 * `<li>` with `<div class="numerando">S x E</div>` + episode `<a href>`.
 */
export function parseSeasons(html: string): SeasonEpisodes {
  const seasons: SeasonEpisodes = {};
  const seen = new Set<string>();
  for (const block of html.split('<div class="se-c">').slice(1)) {
    for (const liHtml of block.split('<li').slice(1)) {
      const li = liHtml.split('</li>')[0];
      const numbers = /(\d+)\s*x\s*(\d+)/.exec(
        /<div class="numerando">([^<]+)</.exec(li)?.[1] ?? ''
      );
      const url = /<a href="([^"]+)"/.exec(li)?.[1] ?? '';
      if (!numbers || !url || seen.has(url)) continue;
      seen.add(url);
      const name = cleanFragment(
        (/<a href="[^"]+">([\s\S]*?)<\/a>/.exec(li)?.[1] ?? '')
      );
      const season = Number(numbers[1]);
      (seasons[season] ??= []).push({
        episode: Number(numbers[2]),
        url,
        name,
      });
    }
  }
  return seasons;
}

export interface PlayerTab {
  url: string;
  label: string;
}

/**
 * Player iframes live in tabbed containers `<div id="divN">`/`playerN`;
 * the tab anchor `<a href="#divN">` carries the language label
 * ("Lektor PL", "PL", ...). Ad tabs are labeled "Reklama" — skipped.
 */
export function parsePlayerTabs(html: string): PlayerTab[] {
  const labels = new Map<string, string>();
  for (const m of html.matchAll(
    /<a href="#((?:div|player)\d+)"[^>]*>([\s\S]*?)<\/a>/g
  )) {
    labels.set(m[1], cleanFragment(m[2]));
  }

  const out: PlayerTab[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<iframe[^>]+src="([^"]+)"/g)) {
    let src = m[1].trim().replace(/&amp;/g, '&');
    if (src.startsWith('//')) src = 'https:' + src;
    if (!/^https?:\/\//.test(src) || seen.has(src)) continue;
    const divStart = html.lastIndexOf('<div id="', m.index);
    const tab =
      divStart >= 0
        ? (/^((?:div|player)\d+)/.exec(
            html.slice(divStart + 9, m.index)
          )?.[1] ?? '')
        : '';
    if (!tab) continue;
    const label = labels.get(tab) ?? '';
    if (/^reklama$/i.test(label)) continue;
    seen.add(src);
    out.push({ url: src, label });
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

function fetchOpts(): {
  headers: Record<string, string>;
  site: string;
  cookieHint: string;
} {
  const ua = process.env[UA_ENV]?.trim();
  return {
    headers: {
      // No UA by default: lets fetchPage's FlareSolverr path apply its solved
      // context; when CDA_HD_CC_UA is set the provider owns its identity.
      ...(ua ? { 'User-Agent': ua } : {}),
      'Accept-Language': 'pl,en;q=0.8',
      ...(cookieHeader() ? { Cookie: cookieHeader()! } : {}),
    },
    site: 'cda-hd.cc',
    cookieHint: cookieHint(),
  };
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetchPage(url, fetchOpts());
  return res.text();
}

function toResults(tabs: PlayerTab[], quality: string | null): StreamResult[] {
  return tabs.map((t) => ({
    provider: 'cda-hd.cc',
    quality,
    language: t.label || null,
    url: t.url,
    label: hostname(t.url),
  }));
}

export const cdaHd: Provider = {
  name: 'cda-hd.cc',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const html = await fetchHtml(
      `${BASE_URL}/?s=${encodeURIComponent(query)}`
    );
    const items = parseSearchHtml(html).filter((i) => i.type === params.type);
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];
    const match = matches[0];

    if (params.type === 'movie') {
      const page = await fetchHtml(match.url);
      return toResults(parsePlayerTabs(page), match.quality || null);
    }

    // tv: series page -> season -> episode page -> player tabs
    const seasons = parseSeasons(await fetchHtml(match.url));
    const episodes: SeasonEpisodes[number] =
      (params.season && seasons[params.season]) ||
      Object.values(seasons)[0] ||
      [];
    const target = params.episode
      ? episodes.find((e) => e.episode === params.episode)
      : episodes[0];
    if (!target) return [];
    const episodePage = await fetchHtml(target.url);
    return toResults(parsePlayerTabs(episodePage), match.quality || null);
  },
};
