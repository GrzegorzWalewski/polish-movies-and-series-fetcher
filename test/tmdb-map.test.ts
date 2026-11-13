import { describe, expect, it } from 'vitest';
import { mapTmdbDetails } from '../src/tmdb.js';
import type { MediaResult } from '../src/types.js';

describe('mapTmdbDetails', () => {
  it('maps a movie details payload', () => {
    const result: MediaResult = mapTmdbDetails(
      {
        title: 'Seksmisja',
        original_title: 'Seksmisja',
        release_date: '1983-11-11',
        runtime: 112,
        external_ids: { imdb_id: 'tt0083564' },
      },
      { type: 'movie', tmdbId: 12345, fallbackTitle: 'ignored' }
    );
    expect(result).toEqual({
      type: 'movie',
      tmdbId: 12345,
      imdbId: 'tt0083564',
      plTitle: 'Seksmisja',
      originalTitle: 'Seksmisja',
      year: '1983',
      runtimeMinutes: 112,
    });
  });

  it('maps a tv details payload (name fields, episode_run_time)', () => {
    const result = mapTmdbDetails(
      {
        name: 'Wiedźmin',
        original_name: 'The Witcher',
        first_air_date: '2019-12-20',
        episode_run_time: [62],
        external_ids: { imdb_id: 'tt5180501' },
      },
      { type: 'tv', tmdbId: 71912, fallbackTitle: 'ignored' }
    );
    expect(result.type).toBe('tv');
    expect(result.plTitle).toBe('Wiedźmin');
    expect(result.originalTitle).toBe('The Witcher');
    expect(result.year).toBe('2019');
    expect(result.runtimeMinutes).toBe(62);
    expect(result.imdbId).toBe('tt5180501');
  });

  it('falls back to ref title when PL/EN titles are missing', () => {
    const result = mapTmdbDetails(
      { release_date: undefined, external_ids: {} },
      { type: 'movie', tmdbId: 1, fallbackTitle: 'Fallback' }
    );
    expect(result.plTitle).toBe('Fallback');
    expect(result.originalTitle).toBe('Fallback');
    expect(result.year).toBe('');
    expect(result.imdbId).toBeNull();
    expect(result.runtimeMinutes).toBeNull();
  });
});
