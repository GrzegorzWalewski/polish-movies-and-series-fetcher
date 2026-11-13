/**
 * Library entry point for consumers embedding the fetcher as a dependency
 * (e.g. the Stremio addon). Import via `movies-series-fetcher/lib`.
 * The CLI keeps its own entry (dist/index.js) — do not import CLI code here.
 */

// types
export type {
  MediaResult,
  MediaType,
  StreamResult,
  ProviderSearchParams,
  Provider,
} from './types.js';
export { CloudflareBlockedError } from './types.js';

// tmdb
export {
  searchTmdbCandidates,
  resolveMediaDetails,
  resolveMediaDetailsFromImdb,
  mapTmdbDetails,
  resolveAbsoluteEpisode,
  TmdbAuthError,
  type TmdbSearchCandidate,
} from './tmdb.js';

// providers
export { providers } from './providers/registry.js';
export {
  safeProviderSearch,
  ProviderTimeoutError,
  type ProviderAttempt,
} from './utils/cloudflare.js';

// env
export { loadEnvFile } from './utils/env.js';
