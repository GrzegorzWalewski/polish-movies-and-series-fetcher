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

  const isMovie = candidate.type === 'movie';
  return {
    type: isMovie ? 'movie' : 'tv',
    tmdbId: candidate.tmdbId,
    imdbId: details.external_ids?.imdb_id ?? null,
    plTitle: (isMovie ? details.title : details.name) ?? candidate.title,
    originalTitle:
      (isMovie ? details.original_title : details.original_name) ??
      candidate.title,
    year:
      (isMovie ? details.release_date : details.first_air_date)?.slice(0, 4) ??
      '',
    runtimeMinutes: isMovie
      ? (details.runtime ?? null)
      : (details.episode_run_time?.[0] ?? null),
  };
}
