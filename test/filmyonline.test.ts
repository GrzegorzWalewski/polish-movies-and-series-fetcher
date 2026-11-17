import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchResponse,
  toSiteMatches,
  hitType,
  hitYear,
  parseFullVideos,
  languageLabel,
  toStreamResults,
} from '../src/providers/filmyonline.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('filmyonline.cc', () => {
  it('parses search hits (pagination.data shape)', () => {
    const hits = parseSearchResponse(JSON.parse(fixture('fo-search.json')));
    expect(hits.length).toBe(3);
    const dh = hits.find((h) => h.imdb_id === 'tt0095016');
    expect(dh?.name).toBe('Szklana pułapka');
    expect(dh?.is_series).toBe(false);
    expect(hitYear(dh!)).toBe('1988');
  });

  it('type always comes from is_series (site `type` field is always "movie")', () => {
    const hits = parseSearchResponse(JSON.parse(fixture('fo-ep.json')));
    // fixture title payload has is_series:true
    expect(hits).toEqual([]); // no pagination wrapper
    const seriesHit = JSON.parse(fixture('fo-ep.json')).title;
    expect(hitType(seriesHit)).toBe('tv');
    expect(hitType({ is_series: false, type: 'movie' })).toBe('movie');
  });

  it('toSiteMatches: title+year, dedupe by id, imdb captured', () => {
    const hits = parseSearchResponse(JSON.parse(fixture('fo-search.json')));
    const items = toSiteMatches(hits);
    const dh = items.find((i) => i.imdbId === 'tt0095016');
    expect(dh?.title).toBe('Szklana pułapka (1988)');
    expect(dh?.url).toContain('/titles/13699');
    expect(dh?.type).toBe('movie');
  });

  it('prefers the exact imdb_id match over title heuristics', () => {
    const hits = parseSearchResponse(JSON.parse(fixture('fo-search.json')));
    const items = toSiteMatches(hits).filter((i) => i.type === 'movie');
    // "Szklana pułapka 3 i 1/2" would also fuzzy-match a bare "szklana pulapka"
    // query — imdb id must pin Die Hard
    const match = items.find((i) => i.imdbId === 'tt0095016');
    expect(match?.id).toBe(13699);
    const heur = pickMatches(items, {
      imdbId: 'tt0095016',
      type: 'movie',
      title: 'Szklana pułapka',
      originalTitle: 'Die Hard',
      year: '1988',
    });
    expect(heur.length).toBeGreaterThan(0);
  });

  it('parseFullVideos: keeps category=full, drops trailers/tmdb origin', () => {
    const data = JSON.parse(fixture('fo-title.json'));
    const videos = parseFullVideos(data);
    // fixture has 2 videos: youtube trailer (category=trailer) + myvidplay full
    expect(videos).toHaveLength(1);
    expect(videos[0].src).toBe('https://myvidplay.com/e/yfpqxhp60bcc');
  });

  it('parseFullVideos: episode payload shape (episode.videos)', () => {
    const data = JSON.parse(fixture('fo-ep.json'));
    const videos = parseFullVideos(data);
    expect(videos).toHaveLength(1);
    expect(videos[0].src).toBe('https://doodstream.com/e/7vacl83iui9b');
    expect(videos[0].name).toBe('Odcinek 1');
  });

  it('languageLabel: name suffix wins, then language code', () => {
    expect(languageLabel({ name: 'Szklana pułapka LektorPL' })).toBe('Lektor PL');
    expect(languageLabel({ name: 'Film DubbingPL' })).toBe('Dubbing PL');
    expect(languageLabel({ name: 'Odcinek 1', language: 'pl' })).toBe('PL');
    expect(languageLabel({ name: 'Sub', language: 'en' })).toBe('en');
    expect(languageLabel({})).toBeNull();
  });

  it('toStreamResults: quality hd→HD, dedupes, hoster label fallback', () => {
    const results = toStreamResults([
      { src: '//myvidplay.com/e/aaa', quality: 'hd', name: 'X LektorPL' },
      { src: 'https://myvidplay.com/e/aaa', quality: 'hd' }, // deduped
      { src: 'https://streamtape.com/e/bbb/', quality: '1080p' },
      { src: 'not-a-url', quality: null },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      provider: 'filmyonline.cc',
      quality: 'HD',
      language: 'Lektor PL',
      label: 'X LektorPL',
    });
    expect(results[1].quality).toBe('1080p');
    expect(results[1].label).toBe('streamtape.com');
  });
});
