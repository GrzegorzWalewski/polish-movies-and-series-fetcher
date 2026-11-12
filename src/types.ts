export type MediaType = 'movie' | 'tv';

/** Resolved media from TMDB search + details */
export interface MediaResult {
  type: 'movie' | 'tv';
  tmdbId: number;
  imdbId: string | null;
  plTitle: string;
  originalTitle: string;
  year: string;
  runtimeMinutes: number | null;
}

/** A single stream link found on a provider site */
export interface StreamResult {
  provider: string;
  quality: string | null; // "720p", "1080p", "HD", "Auto"...
  language: string | null; // "PL", "Lektor PL", "PL napisy"...
  url: string; // direct m3u8/mp4 or embed URL
  label?: string | null; // host/player name, e.g. "Cda (Lektor PL)"
}

/** Provider search params — Polish sites search by title+year, not imdb_id */
export interface ProviderSearchParams {
  imdbId: string | null;
  type: 'movie' | 'tv';
  title: string; // Polish title from TMDB
  originalTitle: string;
  year: string;
  season?: number;
  episode?: number;
}

export interface Provider {
  name: string;
  baseUrl: string;
  search(params: ProviderSearchParams): Promise<StreamResult[]>;
}

/** Error thrown when a site is behind a Cloudflare challenge we cannot pass */
export class CloudflareBlockedError extends Error {
  constructor(public site: string) {
    super(
      `${site} is protected by Cloudflare — headless bypass not supported yet (FlareSolverr integration planned)`
    );
    this.name = 'CloudflareBlockedError';
  }
}
