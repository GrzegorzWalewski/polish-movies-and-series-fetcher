import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://maxvod.tv';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const fetchOpts = {
  headers: { 'User-Agent': UA, 'Accept-Language': 'pl,en;q=0.8' },
  site: 'maxvod.tv',
};

export interface SearchTile extends SiteMatch {
  type: 'movie' | 'tv';
}

export interface SourceEntry {
  uuid: string;
  label: string;
  quality: string;
  mediaType: string; // 'video' (direct mp4) | 'iframe'
  langLabel: string;
  variant?: string; // 'original' = ad-supported iframe twin of a direct source
}

/**
 * Parse search result tiles: <a href="/(movie|series)/slug"> cards with an
 * <img alt="Title"> and a <span>YYYY</span> year badge.
 */
export function parseTiles(html: string): SearchTile[] {
  const results: SearchTile[] = [];
  const seen = new Set<string>();
  const tiles = html.split(/<a\s+href="\//).slice(1);

  for (const tileHtml of tiles) {
    const tile = tileHtml.split('</a>')[0];
    const um = /^(movie|series)\/([^"?#]+)["?#]/.exec(tile);
    const title = /<img[^>]+alt="([^"]+)"/.exec(tile)?.[1]?.trim() ?? '';
    const year =
      /<span[^>]*>\s*((?:19|20)\d{2})\s*<\/span>/.exec(tile)?.[1] ?? '';
    if (!um || !title) continue;
    const type = um[1] === 'movie' ? ('movie' as const) : ('tv' as const);
    const fullUrl = `${BASE_URL}/${um[1]}/${um[2]}`;
    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);
    results.push({ title, url: fullUrl, year, type });
  }
  return results;
}

/**
 * Parse `const SOURCES = [...]` from a player page body.
 */
export function parseSources(html: string): SourceEntry[] {
  const m = /const\s+SOURCES\s*=\s*(\[.*?\]);/.exec(html);
  if (!m) return [];
  try {
    return JSON.parse(m[1]) as SourceEntry[];
  } catch {
    return [];
  }
}

/** Numeric weight for sorting: "1080p" -> 1080, "4k" -> 2160, unknown ("Wysoka") -> 1081 */
export function qualityNum(q: string): number {
  const d = /(\d{3,4})/.exec(q);
  if (d) return Number(d[1]);
  if (/4k/i.test(q)) return 2160;
  return 1081;
}

/** Direct "bez limitu" first, then other direct, then ad iframes, quality desc */
export function sortSources(sources: SourceEntry[]): SourceEntry[] {
  return [...sources].sort((a, b) => {
    const rank = (s: SourceEntry) => (s.mediaType === 'video' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return qualityNum(b.quality) - qualityNum(a.quality);
  });
}

/**
 * Player pages redirect to /login unless a same-site Referer is sent.
 * The play URL 302s to a signed/expiring link (site IP-host needs Referer;
 * external hosters get md5/expires params), so we emit the stable play URL.
 */
function toPlayUrl(uuid: string, original: boolean): string {
  return `${BASE_URL}/player/play/${uuid}${original ? '?original=1' : ''}`;
}

async function getPlayerSources(
  playerUrl: string,
  referer: string
): Promise<SourceEntry[]> {
  const res = await fetchPage(playerUrl, {
    headers: {
      ...fetchOpts.headers,
      Referer: referer,
    },
    site: 'maxvod.tv',
  });
  return parseSources(await res.text());
}

export const maxvod: Provider = {
  name: 'maxvod.tv',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const res = await fetchPage(
      `${BASE_URL}/search?q=${encodeURIComponent(query)}`,
      fetchOpts
    );
    const items = parseTiles(await res.text()).filter(
      (i) => i.type === params.type
    );
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const pageUrl = matches[0].url;
    const slug = pageUrl.replace(`${BASE_URL}/series/`, '').replace(
      `${BASE_URL}/movie/`,
      ''
    );
    const playerUrl =
      params.type === 'tv' && params.season && params.episode
        ? `${BASE_URL}/player/series/${slug}?sezon=${params.season}&odcinek=${params.episode}`
        : `${BASE_URL}/player/${slug}`;

    const sources = sortSources(await getPlayerSources(playerUrl, pageUrl));

    const results: StreamResult[] = [];
    const seen = new Set<string>();
    // long shows list every dubbed/lektor variant per quality — cap the
    // emission (best sources first, sortSources sorts video>iframe, quality desc)
    for (const s of sources.slice(0, 6)) {
      // 'original' variant = ad-supported iframe twin of a direct source
      if (s.variant === 'original') continue;
      const url = toPlayUrl(s.uuid, false);
      if (seen.has(url)) continue;
      seen.add(url);
      results.push({
        provider: 'maxvod.tv',
        quality: s.quality || null,
        language: s.langLabel || null,
        url,
        label: s.label || null,
      });
    }
    return results;
  },
};
