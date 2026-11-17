import { fetchPage } from '../utils/fetcher.js';
import type {
  Provider,
  ProviderSearchParams,
  StreamResult,
} from '../types.js';
import { pickMatches, cleanTitle, type SiteMatch } from './match.js';

// filmyonline.cc is a React SPA over a Laravel JSON API — no HTML parsing
// anywhere. The API is anonymous but Cloudflare-fronted (fetchPage's
// FlareSolverr fallback handles the challenge; only cf_clearance is needed,
// the session cookies can be dropped).
const BASE_URL = 'https://filmyonline.cc';
const API_URL = `${BASE_URL}/api/v1/`;

// Laravel Sanctum stateful check: without a same-site Referer every API call
// answers 401 {"message":""} — looks like an auth wall but is just this
// header. (Cookie/UA deliberately unset — fetchPage must stay free to attach
// the FlareSolverr-solved cf_clearance + solver UA.)
const API_HEADERS = {
  Accept: 'application/json',
  Referer: `${BASE_URL}/`,
};

async function apiOnce(path: string): Promise<string> {
  const res = await fetchPage(API_URL + path, {
    headers: API_HEADERS,
    site: 'filmyonline.cc',
  });
  if (!res.ok) throw new Error(`filmyonline.cc API ${path}: HTTP ${res.status}`);
  return await res.text();
}

/**
 * The first request after a FlareSolverr solve returns the Chrome-rendered
 * HTML wrapper of the JSON (solveFallback hands back the browser page);
 * the clearance is cached by then, so one re-fetch yields the raw JSON.
 */
async function api<T>(path: string): Promise<T> {
  const text = await apiOnce(path);
  try {
    return JSON.parse(text) as T;
  } catch {
    return JSON.parse(await apiOnce(path)) as T;
  }
}

export interface FoSearchHit {
  id?: number;
  name?: string;
  /** site bug: `type` is ALWAYS "movie" — only this field distinguishes */
  is_series?: boolean;
  year?: number | string;
  release_date?: string;
  imdb_id?: string | null;
  tmdb_id?: number | null;
  original_title?: string | null;
}

export interface FoSearchResponse {
  pagination?: { data?: FoSearchHit[] };
}

export interface FoVideo {
  src?: string;
  name?: string;
  quality?: string | null;
  language?: string | null;
  /** 'full' | 'trailer' */
  category?: string;
  /** 'local' | 'external' | 'tmdb' (tmdb = trailer/clip) */
  origin?: string;
}

export interface FoSeason {
  number?: number;
  episodes_count?: number;
}

/** The search response data array, tolerating both shapes. */
export function parseSearchResponse(
  data: FoSearchResponse | FoSearchHit[]
): FoSearchHit[] {
  if (Array.isArray(data)) return data;
  return data.pagination?.data ?? [];
}

export function hitType(hit: FoSearchHit): 'movie' | 'tv' {
  return hit.is_series ? 'tv' : 'movie';
}

export function hitYear(hit: FoSearchHit): string {
  const year = String(hit.year ?? hit.release_date ?? '').slice(0, 4);
  return /^(19|20)\d\d$/.test(year) ? year : '';
}

/** Parse search hits into site matches (title/url/year + ids for imdb match). */
export function toSiteMatches(
  hits: FoSearchHit[]
): (SiteMatch & { id: number; type: 'movie' | 'tv'; imdbId: string | null })[] {
  const results: (SiteMatch & {
    id: number;
    type: 'movie' | 'tv';
    imdbId: string | null;
  })[] = [];
  const seen = new Set<number>();
  for (const hit of hits) {
    const title = (hit.name ?? '').trim();
    if (!title || !hit.id || seen.has(hit.id)) continue;
    seen.add(hit.id);
    const year = hitYear(hit);
    results.push({
      title: year ? `${title} (${year})` : title,
      url: `${API_URL}titles/${hit.id}`,
      year,
      id: hit.id,
      type: hitType(hit),
      imdbId: hit.imdb_id ?? null,
    });
  }
  return results;
}

/** Full ('category=full') videos of a title/episode payload, site order. */
export function parseFullVideos(data: unknown): FoVideo[] {
  const d = data as {
    title?: { videos?: FoVideo[] };
    episode?: { videos?: FoVideo[] };
  };
  const videos = d.title?.videos ?? d.episode?.videos ?? [];
  return videos.filter((v) => {
    if ((v.category ?? 'full') !== 'full') return false;
    // trailers/clips carry origin 'tmdb' + youtube srcs — belt and braces
    if (v.origin === 'tmdb') return false;
    return true;
  });
}

/** Human language label: name suffix wins ("LektorPL"), then language code. */
export function languageLabel(v: FoVideo): string | null {
  const name = (v.name ?? '').toLowerCase();
  if (name.includes('lektor')) return 'Lektor PL';
  if (name.includes('dubbing')) return 'Dubbing PL';
  if (name.includes('napisy')) return 'PL napisy';
  if ((v.language ?? '').toLowerCase().startsWith('pl')) return 'PL';
  return v.language ?? null;
}

function hostname(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function toStreamResults(videos: FoVideo[]): StreamResult[] {
  const results: StreamResult[] = [];
  const seen = new Set<string>();
  for (const v of videos) {
    let src = (v.src ?? '').trim();
    if (src.startsWith('//')) src = 'https:' + src;
    if (!src.startsWith('http') || seen.has(src)) continue;
    seen.add(src);
    results.push({
      provider: 'filmyonline.cc',
      quality: v.quality === 'hd' ? 'HD' : (v.quality ?? null),
      language: languageLabel(v),
      url: src,
      label: v.name?.trim() || hostname(src),
    });
  }
  return results;
}

export const filmyonline: Provider = {
  name: 'filmyonline.cc',
  baseUrl: BASE_URL,

  async search(params: ProviderSearchParams): Promise<StreamResult[]> {
    const query = cleanTitle(params.title);
    const data = await api<FoSearchResponse | FoSearchHit[]>(
      `titles?query=${encodeURIComponent(query)}`
    );
    const items = toSiteMatches(parseSearchResponse(data)).filter(
      (i) => i.type === params.type
    );

    // search hits are TMDB-sourced and carry imdb_id — exact id match wins
    // over title+year heuristics (episode imdb ids differ from the series',
    // so only trust it when it matches)
    let match = params.imdbId
      ? items.find((i) => i.imdbId === params.imdbId)
      : undefined;
    if (!match) {
      const matches = pickMatches(items, { ...params, title: query });
      match = matches[0];
    }
    if (!match) return [];

    if (params.type === 'tv' && params.season && params.episode) {
      const seasons = await api<FoSeason[]>(`titles/${match.id}/seasons`);
      const season = (Array.isArray(seasons) ? seasons : seasons.pagination?.data ?? []).find(
        (s) => String(s.number) === String(params.season)
      );
      if (!season || season.episodes_count === 0) return [];
      const epData = await api<Record<string, unknown>>(
        `titles/${match.id}/seasons/${params.season}/episodes/${params.episode}`
      );
      return toStreamResults(parseFullVideos(epData));
    }

    const titleData = await api<Record<string, unknown>>(`titles/${match.id}`);
    return toStreamResults(parseFullVideos(titleData));
  },
};
