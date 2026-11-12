import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseTiles,
  parseSources,
  qualityNum,
  sortSources,
} from '../src/providers/maxvod.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

const params = {
  imdbId: 'tt5180504',
  type: 'tv' as const,
  title: 'Wiedźmin',
  originalTitle: 'The Witcher',
  year: '2019',
};

describe('maxvod.tv search tile parsing', () => {
  it('parses tiles with alt title, year span, and type from url prefix', () => {
    const items = parseTiles(fixture('maxvod-search.html'));
    expect(items.length).toBeGreaterThan(3);

    const movie = items.find((i) => i.url.endsWith('/movie/wiedzmin-2001'));
    expect(movie).toEqual({
      title: 'Wiedźmin',
      url: 'https://maxvod.tv/movie/wiedzmin-2001',
      year: '2001',
      type: 'movie',
    });

    const series = items.find((i) =>
      i.url.endsWith('/series/wiedzmin-the-witcher')
    );
    expect(series?.type).toBe('tv');
    expect(series?.title).toBe('Wiedźmin / The Witcher');
    expect(series?.year).toBe('2019');
  });

  it('matches "Wiedźmin" preferring year 2019', () => {
    const items = parseTiles(fixture('maxvod-search.html')).filter(
      (i) => i.type === 'tv'
    );
    const matches = pickMatches(items, params);
    expect(matches[0].url).toBe(
      'https://maxvod.tv/series/wiedzmin-the-witcher'
    );
  });

  it('returns empty for pages without tiles', () => {
    expect(parseTiles('<html><body>nothing here</body></html>')).toEqual([]);
  });
});

describe('maxvod.tv player sources', () => {
  it('parses the const SOURCES json from a movie player page', () => {
    const sources = parseSources(fixture('maxvod-player-movie.html'));
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      uuid: 'f00ddeb3-35c9-4f63-a19b-a591e63d0f3a',
      label: 'Player bez limitu',
      quality: '720p',
      mediaType: 'video',
      contentType: 'video/mp4',
      langKey: 'polski',
      langLabel: 'Polski',
    });
    expect(sources[1].variant).toBe('original');
  });

  it('parses multi-language series sources (dubbing + lektor)', () => {
    const sources = parseSources(fixture('maxvod-player-series.html'));
    expect(sources.length).toBeGreaterThanOrEqual(4);
    const langs = new Set(sources.map((s) => s.langLabel));
    expect(langs.has('Dubbing')).toBe(true);
    expect(langs.has('Lektor')).toBe(true);
    // bez limitu direct + original iframe twin share a uuid
    expect(sources[0].uuid).toBe(sources[1].uuid);
    expect(sources[0].mediaType).toBe('video');
    expect(sources[1].mediaType).toBe('iframe');
  });

  it('returns empty when SOURCES is absent (e.g. login redirect page)', () => {
    expect(
      parseSources('<html><body>redirect to /login</body></html>')
    ).toEqual([]);
  });

  it('sorts direct sources before ad iframes, quality desc', () => {
    const sorted = sortSources([
      { uuid: '1', label: 'a', quality: '720p', mediaType: 'video', langLabel: 'Polski' },
      { uuid: '2', label: 'b', quality: '1080p', mediaType: 'iframe', langLabel: 'Polski' },
      { uuid: '3', label: 'c', quality: 'Wysoka', mediaType: 'video', langLabel: 'Lektor' },
      { uuid: '4', label: 'd', quality: '4k', mediaType: 'video', langLabel: 'Polski' },
    ]);
    expect(sorted.map((s) => s.uuid)).toEqual(['4', '3', '1', '2']);
    expect(qualityNum('4k')).toBe(2160);
    expect(qualityNum('Wysoka')).toBe(1081);
    expect(qualityNum('720p')).toBe(720);
  });
});
