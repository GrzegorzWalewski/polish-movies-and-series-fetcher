import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchResponse,
  parseSeasonDirs,
  parseEpisodeDirs,
  parseEmbedUrls,
} from '../src/providers/bajeczki24.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

const params = {
  imdbId: 'tt1160419',
  type: 'movie' as const,
  title: 'Diuna',
  originalTitle: 'Dune',
  year: '2021',
};

describe('bajeczki24.pl search response parsing', () => {
  it('parses hits into matches with years, mapping /filmy/ to movie', () => {
    const items = parseSearchResponse(JSON.parse(fixture('bajeczki-search.json')));
    expect(items).toHaveLength(4); // /inne/ path dropped
    expect(items[0]).toEqual({
      title: 'Diuna (2021)',
      url: 'https://bajeczki24.pl/filmy/sci-fi/diuna/',
      type: 'movie',
    });
  });

  it('maps /seriale/ and /bajki/ paths to tv', () => {
    const items = parseSearchResponse(JSON.parse(fixture('bajeczki-search.json')));
    const tv = items.filter((i) => i.type === 'tv');
    expect(tv.map((t) => t.title)).toEqual([
      'Wiedźmin (2019)',
      'Lis i ptak (2022)',
    ]);
  });

  it('handles missing fields and empty hits', () => {
    expect(parseSearchResponse({})).toEqual([]);
    expect(
      parseSearchResponse({ hits: [{ title: 'No path' }, { path: '/filmy/x/', title: 'no year' }] })
    ).toEqual([{ title: 'no year', url: 'https://bajeczki24.pl/filmy/x/', type: 'movie' }]);
  });

  it('matches "Diuna" preferring year 2021', () => {
    const items = parseSearchResponse(JSON.parse(fixture('bajeczki-search.json')));
    const movies = items.filter((i) => i.type === 'movie');
    const matches = pickMatches(movies, params);
    expect(matches[0].url).toBe('https://bajeczki24.pl/filmy/sci-fi/diuna/');
  });
});

describe('bajeczki24.pl season/episode navigation', () => {
  it('extracts season numbers from a series page', () => {
    expect(parseSeasonDirs(fixture('bajeczki-series.html'))).toEqual([1, 2]);
  });

  it('extracts episode numbers from a season page', () => {
    expect(parseEpisodeDirs(fixture('bajeczki-season.html'))).toEqual([1, 2]);
  });

  it('ignores links without an article card', () => {
    const html = '<a href="3/">plain link</a><a href="4/"><article>x</article></a>';
    expect(parseSeasonDirs(html)).toEqual([4]);
  });
});

describe('bajeczki24.pl embed extraction', () => {
  it('collects iframe srcs, dedupes, fixes protocol-relative', () => {
    const urls = parseEmbedUrls(fixture('bajeczki-title.html'));
    expect(urls).toEqual(['https://bysesukior.com/e/d85cn46mrq07']);
  });

  it('returns empty when no player present', () => {
    expect(parseEmbedUrls('<html><body>no player</body></html>')).toEqual([]);
  });
});
