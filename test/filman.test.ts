import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchHtml,
  findEpisodeUrl,
  parseLinkRows,
  extractRouteToken,
  decodeTmpUrlPage,
} from '../src/providers/filman.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

const params = {
  imdbId: 'tt15239678',
  type: 'movie' as const,
  title: 'Diuna',
  originalTitle: 'Dune',
  year: '2021',
};

describe('filman.cc search parsing', () => {
  it('parses movie and series results with years (PL / original title)', () => {
    const items = parseSearchHtml(fixture('filman-search.html'));
    expect(items).toHaveLength(4);
    expect(items[1]).toEqual({
      title: 'Diuna / Dune (2021)',
      url: 'https://filman.cc/m/jG8rb9XL7VZ4BeyFTDpKtzwlE',
      type: 'movie',
    });
    expect(items[3].type).toBe('tv');
    expect(items[3].title).toBe('Diuna: Proroctwo / Dune: Prophecy (2024)');
  });

  it('filters movie vs series by /m/ and /s/ path', () => {
    const items = parseSearchHtml(fixture('filman-search.html'));
    const movies = items.filter((i) => i.type === 'movie');
    expect(movies).toHaveLength(3);
  });

  it('matches "Diuna" preferring year 2021', () => {
    const items = parseSearchHtml(fixture('filman-search.html'));
    const movies = items.filter((i) => i.type === 'movie');
    const matches = pickMatches(movies, params);
    expect(matches[0].url).toBe('https://filman.cc/m/jG8rb9XL7VZ4BeyFTDpKtzwlE');
  });
});

describe('filman.cc episode navigation', () => {
  it('finds episode url by zero-padded [sXXeYY] tag', () => {
    expect(findEpisodeUrl(fixture('filman-series.html'), 1, 3)).toBe(
      'https://filman.cc/e/dune-prophecy/223812/the-high-handed-enemy/1690322'
    );
    expect(findEpisodeUrl(fixture('filman-series.html'), 1, 1)).toBe(
      'https://filman.cc/e/dune-prophecy/221475/sisterhood-above-all/1690322'
    );
    expect(findEpisodeUrl(fixture('filman-series.html'), 2, 1)).toBeNull();
  });
});

describe('filman.cc legacy link rows (data-iframe)', () => {
  it('decodes base64 JSON src, extracts server/version/quality', () => {
    const rows = parseLinkRows(fixture('filman-title-legacy.html'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      server: 'cda.pl',
      version: 'Lektor',
      quality: '1080p',
      embedUrl: 'https://www.cda.pl/video/7654321',
      linkId: null,
    });
    expect(rows[1].embedUrl).toBe('https://streamtape.com/e/abcd1234');
  });

  it('drops unresolvable rows (invalid base64, no link id)', () => {
    const rows = parseLinkRows(fixture('filman-title-legacy.html'));
    expect(rows.map((r) => r.server)).toEqual(['cda.pl', 'streamtape']);
  });
});

describe('filman.cc current link rows (data-link-id + routeToken)', () => {
  it('parses rows with link ids and route token', () => {
    const html = fixture('filman-title-token.html');
    const rows = parseLinkRows(html);
    expect(rows).toHaveLength(2);
    expect(rows[0].linkId).toBe('84123');
    expect(rows[0].embedUrl).toBeNull();
    expect(rows[1].server).toBe('vidoza');
    expect(extractRouteToken(html)).toBe('Rx7Kp2mQ9z');
  });
});

describe('filman.cc tmp-url XOR decode', () => {
  it('decodes _e with key _a+_b+_c into the real host url', () => {
    const url = decodeTmpUrlPage(fixture('filman-tmp-url.html'));
    expect(url).toBe('https://cdn.examplehost.tv/v/xyz123/playlist.m3u8');
  });

  it('returns null when vars are missing', () => {
    expect(decodeTmpUrlPage('<html><body>no vars</body></html>')).toBeNull();
  });
});
