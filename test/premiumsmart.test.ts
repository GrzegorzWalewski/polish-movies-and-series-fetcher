import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchResponse,
  parseFullVideos,
  hitType,
  hitYear,
} from '../src/providers/premiumsmart.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureJson = (name: string) =>
  JSON.parse(readFileSync(join(fixturesDir, name), 'utf-8'));

const params = {
  imdbId: 'tt0848228',
  type: 'movie' as const,
  title: 'Avengers',
  originalTitle: 'The Avengers',
  year: '2012',
};

describe('premiumsmart.eu search response parsing', () => {
  it('parses title hits, keeps release_date fallback year, drops non-titles', () => {
    const items = parseSearchResponse(fixtureJson('premiumsmart-search.json'));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title: 'Wiedźmin (2019)',
      url: 'https://premiumsmart.eu/api/v1/titles/25474',
      type: 'tv',
    });
    expect(items[1].title).toBe('Szczury: Opowieść ze świata Wiedźmina (2025)');
    // release_date fallback
    expect(items[2].title).toBe('Avengers (2012)');
  });

  it('hitType/hitYear helpers', () => {
    expect(hitType({ is_series: true })).toBe('tv');
    expect(hitType({})).toBe('movie');
    expect(hitYear({ year: 2019 })).toBe('2019');
    expect(hitYear({ release_date: '2012-04-25' })).toBe('2012');
    expect(hitYear({ year: 'bad' })).toBe('');
  });

  it('matches "Avengers" preferring year 2012', () => {
    const items = parseSearchResponse(fixtureJson('premiumsmart-search.json'));
    const movies = items.filter((i) => i.type === 'movie');
    const matches = pickMatches(movies, params);
    expect(matches[0].url).toBe('https://premiumsmart.eu/api/v1/titles/1195835');
  });
});

describe('premiumsmart.eu full-video extraction', () => {
  it('takes title.videos, keeps only category=full, sorts by order', () => {
    const videos = parseFullVideos(fixtureJson('premiumsmart-title.json'));
    expect(videos.map((v) => v.order)).toEqual([1, 2, 3]); // trailer dropped
  });

  it('takes episode.videos and drops trailers', () => {
    const videos = parseFullVideos(fixtureJson('premiumsmart-episode.json'));
    expect(videos).toHaveLength(1);
    expect(videos[0].quality).toBe('1080p');
    expect(videos[0].language_type).toBe('Lektor PL');
  });

  it('falls back to video / alternative_videos (old rows)', () => {
    expect(parseFullVideos({ video: { src: 'https://a/e/1', category: 'full' } })).toHaveLength(1);
    expect(
      parseFullVideos({ alternative_videos: [{ src: 'https://a/e/1' }, { src: 'https://a/e/2' }] })
    ).toHaveLength(2);
    expect(parseFullVideos({})).toEqual([]);
  });
});
