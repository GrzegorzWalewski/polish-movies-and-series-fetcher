import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

const BASE_URL = 'https://premiumsmart.eu';
const API_URL = `${BASE_URL}/api/v1/`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * The API answers 401 without the session cookie the start page sets
 * (Laravel XSRF-TOKEN + session) — fetch the homepage first.
 */
async function sessionCookie(): Promise<string> {
  const home = await fetch(`${BASE_URL}/`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  });
  const cookies =
    (home.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function api<T>(
  path: string,
  cookie: string
): Promise<T> {
  const res = await fetch(API_URL + path, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE_URL}/`,
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`premiumsmart.eu API ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface PssSearchHit {
  id?: number;
  name?: string;
  is_series?: boolean;
  year?: number | string;
  release_date?: string;
  model_type?: string;
}

export interface PssSearchResponse {
  results?: PssSearchHit[];
}

export interface PssVideo {
  src?: string;
  name?: string;
  quality?: string | null;
  language_type?: string | null;
  category?: string; // 'full' | 'trailer'
  order?: number;
}

export interface PssPagination {
  data?: Record<string, unknown>[];
  next_page?: number | null;
}

export function hitType(hit: PssSearchHit): 'movie' | 'tv' {
  return hit.is_series ? 'tv' : 'movie';
}

export function hitYear(hit: PssSearchHit): string {
  const year = String(hit.year ?? hit.release_date ?? '').slice(0, 4);
  return /^(19|20)\d\d$/.test(year) ? year : '';
}

/** Parse search results into site matches (titles only). */
export function parseSearchResponse(
  data: PssSearchResponse
): (SiteMatch & { type: 'movie' | 'tv' })[] {
  const results: (SiteMatch & { type: 'movie' | 'tv' })[] = [];
  const seen = new Set<string>();
  for (const hit of data.results ?? []) {
    if ((hit.model_type ?? 'title') !== 'title') continue;
    const title = (hit.name ?? '').trim();
    if (!title || !hit.id) continue;
    const url = `${API_URL}titles/${hit.id}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const year = hitYear(hit);
    results.push({
      title: year ? `${title} (${year})` : title,
      url,
      type: hitType(hit),
    });
  }
  return results;
}

/** Full ('category=full') videos of a title/episode payload, sorted by order. */
export function parseFullVideos(data: unknown): PssVideo[] {
  const d = data as {
    title?: { videos?: PssVideo[] };
    episode?: { videos?: PssVideo[] };
    video?: PssVideo | null;
    alternative_videos?: PssVideo[];
  };
  const videos =
    d.title?.videos ?? d.episode?.videos ?? d.alternative_videos ??
    (d.video ? [d.video] : []);
  return videos
    .filter((v) => (v.category ?? 'full') === 'full')
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

/** Collect all pages of a paginated API list. */
async function apiPages<T>(
  path: string,
  perPage: number,
  cookie: string,
  maxPages = 10
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await api<{ pagination?: PssPagination }>(
      `${path}?perPage=${perPage}${page > 1 ? `&page=${page}` : ''}`,
      cookie
    );
    const pagination = data.pagination ?? {};
    items.push(...((pagination.data ?? []) as T[]));
    if (!pagination.next_page) break;
  }
  return items;
}

function titleIdFromUrl(url: string): string {
  return /\/titles\/(\d+)/.exec(url)?.[1] ?? '';
}

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function toStreamResults(videos: PssVideo[]): StreamResult[] {
  const results: StreamResult[] = [];
  const seen = new Set<string>();
  for (const v of videos) {
    let src = (v.src ?? '').trim();
    if (src.startsWith('//')) src = 'https:' + src;
    if (!src.startsWith('http') || seen.has(src)) continue;
    seen.add(src);
    results.push({
      provider: 'premiumsmart.eu',
      quality: v.quality ?? null,
      language: v.language_type ?? null,
      url: src,
      label: v.name?.trim() || hostname(src),
    });
  }
  return results;
}

export const premiumsmart: Provider = {
  name: 'premiumsmart.eu',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const cookie = await sessionCookie();

    const data = await api<PssSearchResponse>(
      `search/${encodeURIComponent(query)}?limit=50`,
      cookie
    );
    const items = parseSearchResponse(data).filter((i) => i.type === params.type);
    const matches = pickMatches(items, { ...params, title: query });
    if (matches.length === 0) return [];

    const titleId = titleIdFromUrl(matches[0].url);
    if (!titleId) return [];

    if (params.type === 'tv' && params.season && params.episode) {
      const seasons = await apiPages<{
        number?: number;
        available_episodes_count?: number;
      }>(`titles/${titleId}/seasons`, 30, cookie);
      const season = seasons.find(
        (s) => String(s.number) === String(params.season)
      );
      if (!season || season.available_episodes_count === 0) return [];

      const episodes = await apiPages<{
        episode_number?: number;
        has_sources?: boolean;
      }>(
        `titles/${titleId}/seasons/${params.season}/episodes`,
        100,
        cookie
      );
      const episode = episodes.find(
        (e) =>
          String(e.episode_number) === String(params.episode) &&
          e.has_sources !== false
      );
      if (!episode) return [];

      const epData = await api<Record<string, unknown>>(
        `titles/${titleId}/seasons/${params.season}/episodes/${params.episode}`,
        cookie
      );
      return toStreamResults(parseFullVideos(epData));
    }

    const titleData = await api<Record<string, unknown>>(
      `titles/${titleId}`,
      cookie
    );
    return toStreamResults(parseFullVideos(titleData));
  },
};
