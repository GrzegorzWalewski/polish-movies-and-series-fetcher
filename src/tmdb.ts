import type { MediaResult, MediaType } from './types.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';

// read lazily so .env loading at CLI startup takes effect
function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.TMDB_READ_TOKEN ?? ''}`,
    accept: 'application/json',
  };
}

interface TmdbSearchItem {
  id: number;
  media_type: 'movie' | 'tv' | string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  vote_average?: number;
}

interface TmdbDetails {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  external_ids?: { imdb_id?: string | null };
}

export interface TmdbSearchCandidate {
  type: MediaType;
  tmdbId: number;
  title: string;
  year: string;
  rating: number | null;
  overview: string;
}

export class TmdbAuthError extends Error {
  constructor() {
    super(
      'TMDB_READ_TOKEN is not set. Create a Read Access Token (JWT) at https://www.themoviedb.org/settings/api and set it as env variable TMDB_READ_TOKEN.'
    );
    this.name = 'TmdbAuthError';
  }
}

function titleOf(item: TmdbSearchItem): string {
  return item.title ?? item.name ?? '(unknown)';
}

function yearOf(item: TmdbSearchItem): string {
  return (item.release_date ?? item.first_air_date ?? '').slice(0, 4);
}

/** Search TMDB multi endpoint; returns movie/tv candidates for interactive selection. */
export async function searchTmdbCandidates(
  query: string
): Promise<TmdbSearchCandidate[]> {
  if (!process.env.TMDB_READ_TOKEN) throw new TmdbAuthError();

  const url = `${TMDB_BASE}/search/multi?query=${encodeURIComponent(query)}&language=pl-PL&include_adult=false`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 401) throw new TmdbAuthError();
  const data = (await res.json()) as { results?: TmdbSearchItem[] };

  return (data.results ?? [])
    .filter((i) => i.media_type === 'movie' || i.media_type === 'tv')
    .map((i) => ({
      type: i.media_type as MediaType,
      tmdbId: i.id,
      title: titleOf(i),
      year: yearOf(i),
      rating: i.vote_average ?? null,
      overview: i.overview ?? '',
    }));
}

/**
 * Sites that number episodes continuously across seasons (no per-season
 * reset) need the absolute episode number: sum of prior seasons' episode
 * counts + episode.
 */
export async function resolveAbsoluteEpisode(
  tmdbId: number,
  season: number,
  episode: number
): Promise<number | null> {
  try {
    const url = `${TMDB_BASE}/tv/${tmdbId}?language=pl-PL`;
    const data = (await fetch(url, { headers: headers() }).then((r) =>
      r.json()
    )) as {
      seasons?: { season_number: number; episode_count: number }[];
    };
    if (!Array.isArray(data.seasons)) return null;
    const prior = data.seasons
      .filter((s) => s.season_number >= 1 && s.season_number < season)
      .reduce((sum, s) => sum + s.episode_count, 0);
    return prior + episode;
  } catch {
    return null;
  }
}

/** Fetch details + external_ids for the chosen candidate → MediaResult. */
export async function resolveMediaDetails(
  candidate: TmdbSearchCandidate
): Promise<MediaResult> {
  const endpoint = candidate.type === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_BASE}/${endpoint}/${candidate.tmdbId}?language=pl-PL&append_to_response=external_ids`;
  const details = (await fetch(url, { headers: headers() }).then((r) =>
    r.json()
  )) as TmdbDetails;

  return mapTmdbDetails(details, {
    type: candidate.type,
    tmdbId: candidate.tmdbId,
    fallbackTitle: candidate.title,
  });
}

/**
 * Pure mapping from a TMDB details payload to MediaResult — shared by
 * resolveMediaDetails (TMDB id path) and resolveMediaDetailsFromImdb
 * (/find path, where movie/tv payloads nest under movie_results/tv_results).
 */
export function mapTmdbDetails(
  details: TmdbDetails,
  ref: { type: MediaType; tmdbId: number; fallbackTitle: string }
): MediaResult {
  const isMovie = ref.type === 'movie';
  return {
    type: isMovie ? 'movie' : 'tv',
    tmdbId: ref.tmdbId,
    imdbId: details.external_ids?.imdb_id ?? null,
    plTitle: (isMovie ? details.title : details.name) ?? ref.fallbackTitle,
    originalTitle:
      (isMovie ? details.original_title : details.original_name) ??
      ref.fallbackTitle,
    year:
      (isMovie ? details.release_date : details.first_air_date)?.slice(0, 4) ??
      '',
    runtimeMinutes: isMovie
      ? (details.runtime ?? null)
      : (details.episode_run_time?.[0] ?? null),
  };
}

/**
 * Resolve a TMDB MediaResult from an IMDb id (Stremio-style "tt…" ids).
 * GET /find/{imdbId} → first movie_results / tv_results hit → details call
 * (for tmdbId + external_ids.imdb_id). Throws on TMDB auth failure.
 */
export async function resolveMediaDetailsFromImdb(
  imdbId: string,
  type: MediaType
): Promise<MediaResult | null> {
  if (!process.env.TMDB_READ_TOKEN) throw new TmdbAuthError();

  const findUrl = `${TMDB_BASE}/find/${encodeURIComponent(imdbId)}?external_source=imdb_id&language=pl-PL`;
  const findRes = await fetch(findUrl, { headers: headers() });
  if (findRes.status === 401) throw new TmdbAuthError();
  const find = (await findRes.json()) as {
    movie_results?: TmdbDetailsWithId[];
    tv_results?: TmdbDetailsWithId[];
  };

  const hit =
    (type === 'movie' ? find.movie_results?.[0] : find.tv_results?.[0]) ??
    (type === 'movie' ? find.tv_results?.[0] : find.movie_results?.[0]);
  if (!hit?.id) return null;

  const endpoint = type === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_BASE}/${endpoint}/${hit.id}?language=pl-PL&append_to_response=external_ids`;
  const details = (await fetch(url, { headers: headers() }).then((r) =>
    r.json()
  )) as TmdbDetails;

  return mapTmdbDetails(details, {
    type,
    tmdbId: hit.id,
    fallbackTitle: hit.title ?? hit.name ?? imdbId,
  });
}

interface TmdbDetailsWithId extends TmdbDetails {
  id: number;
}
