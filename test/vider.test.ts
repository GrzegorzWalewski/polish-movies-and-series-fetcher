import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeFileCode,
  encodeFileId,
  titleMeta,
  parseSearchResponse,
  is404Shell,
  isCaptcha,
  streamUrl,
  selectTvMatches,
} from '../src/providers/vider.js';
import type { ProviderSearchParams } from '../src/types.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('vider.info file code cipher', () => {
  it('decodes codes digit-by-digit (docstring example + live-verified id)', () => {
    expect(decodeFileCode('xn8esm')).toBe('215430');
    expect(decodeFileCode('xn8m5x')).toBe('215072');
  });

  it('returns null on unknown characters or empty code', () => {
    expect(decodeFileCode('abcz')).toBeNull();
    expect(decodeFileCode('')).toBeNull();
  });

  it('encodes numeric ids back to codes (roundtrip)', () => {
    expect(encodeFileId('215072')).toBe('xn8m5x');
    expect(decodeFileCode(encodeFileId('123456') ?? '')).toBe('123456');
  });
});

describe('vider.info titleMeta', () => {
  it('parses SxxExx titles into tv meta', () => {
    const meta = titleMeta('1670 S02E04 Palant');
    expect(meta.type).toBe('tv');
    expect(meta.title).toBe('1670');
    expect(meta.season).toBe(2);
    expect(meta.episode).toBe(4);
  });

  it('parses bare episode numbering ("Title 01- subtitle") into absolute tv', () => {
    const meta = titleMeta('Pokemon Indigo League 01- Pokemon wybieram cię !');
    expect(meta.type).toBe('tv');
    expect(meta.title).toBe('Pokemon Indigo League');
    expect(meta.season).toBe(1);
    expect(meta.episode).toBe(1);
  });

  it('parses odcinek titles into absolute tv', () => {
    const meta = titleMeta('M jak milosc odcinek 1700');
    expect(meta.type).toBe('tv');
    expect(meta.episode).toBe(1700);
  });

  it('parses year titles into movie meta', () => {
    const meta = titleMeta('The Fix 2026 PL');
    expect(meta.type).toBe('movie');
    expect(meta.title).toBe('The Fix');
    expect(meta.year).toBe('2026');
  });

  it('falls back to movie with full name', () => {
    const meta = titleMeta('Zwykły film');
    expect(meta.type).toBe('movie');
    expect(meta.title).toBe('Zwykły film');
  });
});

describe('vider.info parseSearchResponse', () => {
  const items = parseSearchResponse(fixture('vider-search.json'));

  it('keeps video files (type_fk 7) with codes and urls', () => {
    expect(items.map((i) => i.code)).toEqual([
      'xn8m5x',
      'xn8m5s',
      'nxse81',
      'nsvx51',
    ]);
    expect(items[0].url).toBe('https://vider.info/vid/+fxn8m5x');
    expect(items[0].fileId).toBe('215072');
  });

  it('splits titles into matchable series names', () => {
    expect(items[2].title).toBe('1670');
    expect(items[2].season).toBe(2);
    expect(items[3].title).toBe('The Fix');
    expect(items[3].year).toBe('2026');
  });

  it('returns empty for html shells or non-json', () => {
    expect(parseSearchResponse(fixture('vider-404shell.html'))).toEqual([]);
    expect(parseSearchResponse('gateway timeout')).toEqual([]);
  });

  it('parses the response-wrapped shape (live 2026-11-16)', () => {
    const wrapped = parseSearchResponse(
      fixture('vider-search-wrapped.json')
    );
    expect(wrapped.map((i) => i.code)).toEqual([
      '1xmvxs',
      '1xmsmc',
      '1xmc1m',
      '1xmc8s',
      '1xm5e8',
      'nsvx51',
    ]);
    expect(wrapped[0].fileId).toBe('620923');
    expect(wrapped[0].url).toBe('https://vider.info/vid/+f1xmvxs');
  });

  it('parses hevc-suffixed SxxExx titles and bare-number uploads', () => {
    const wrapped = parseSearchResponse(
      fixture('vider-search-wrapped.json')
    );
    // "Znieczulenie S01e01_hevc" -> tv s1e1 titled "Znieczulenie"
    expect(wrapped[4].type).toBe('tv');
    expect(wrapped[4].title).toBe('Znieczulenie');
    expect(wrapped[4].season).toBe(1);
    expect(wrapped[4].episode).toBe(1);
    // "Znieczulenie 8" has no S/E marker — stays movie-classified
    expect(wrapped[2].type).toBe('movie');
    expect(wrapped[2].title).toBe('Znieczulenie 8');
  });
});

describe('vider.info response gates', () => {
  it('detects the 404 error shell', () => {
    expect(is404Shell(fixture('vider-404shell.html'))).toBe(true);
    expect(is404Shell(fixture('vider-search.json'))).toBe(false);
  });

  it('detects the captcha page', () => {
    expect(isCaptcha(fixture('vider-captcha.html'))).toBe(true);
    expect(isCaptcha(fixture('vider-search.json'))).toBe(false);
  });
});

describe('vider.info stream url', () => {
  it('points at the stream CDN with guest uid (live-verified mp4)', () => {
    expect(streamUrl('215072')).toBe(
      'https://stream.vider.info/video/215072/v.mp4?uid=0'
    );
  });
});

describe('vider.info selectTvMatches', () => {
  const items = parseSearchResponse(fixture('vider-search.json'));

  it('prefers exact S/E over bare-number matches', () => {
    const params: ProviderSearchParams = {
      imdbId: null,
      type: 'tv',
      title: '1670',
      originalTitle: '1670',
      year: '',
      season: 2,
      episode: 4,
    };
    const picked = selectTvMatches(
      items.filter((i) => i.type === 'tv'),
      params
    );
    expect(picked.map((m) => m.code)).toEqual(['nxse81']);
  });

  it('falls back to absolute episode numbering', () => {
    const params: ProviderSearchParams = {
      imdbId: null,
      type: 'tv',
      title: 'Pokemon Indigo League',
      originalTitle: 'Pokemon',
      year: '',
      season: 1,
      episode: 2,
      absoluteEpisode: 2,
    };
    const picked = selectTvMatches(
      items.filter(
        (i) => i.title.toLowerCase().includes('pokemon indigo')
      ),
      params
    );
    expect(picked.map((m) => m.code)).toEqual(['xn8m5s']);
  });

  it('maps bare-number movie-classified uploads onto the absolute episode', () => {
    const wrapped = parseSearchResponse(
      fixture('vider-search-wrapped.json')
    );
    const params: ProviderSearchParams = {
      imdbId: null,
      type: 'tv',
      title: 'Znieczulenie',
      originalTitle: 'Znieczulenie',
      year: '2026',
      season: 1,
      episode: 8,
      absoluteEpisode: 8,
    };
    const picked = selectTvMatches(wrapped, params);
    // exact S01E08 upload wins over the bare-number fallback
    expect(picked.map((m) => m.code)).toEqual(['1xmvxs']);
  });

  it('uses bare-number uploads when no S/E upload exists', () => {
    const wrapped = parseSearchResponse(
      fixture('vider-search-wrapped.json')
    ).filter((i) => i.code !== '1xmvxs'); // drop the S01E08 upload
    const params: ProviderSearchParams = {
      imdbId: null,
      type: 'tv',
      title: 'Znieczulenie',
      originalTitle: 'Znieczulenie',
      year: '2026',
      season: 1,
      episode: 8,
      absoluteEpisode: 8,
    };
    const picked = selectTvMatches(wrapped, params);
    expect(picked.map((m) => m.code)).toEqual(['1xmc1m']);
    expect(picked[0].type).toBe('movie'); // fallback keeps the movie classification
  });

  it('never returns movie-classified rows without the bare-number fallback', () => {
    const wrapped = parseSearchResponse(
      fixture('vider-search-wrapped.json')
    );
    const params: ProviderSearchParams = {
      imdbId: null,
      type: 'tv',
      title: 'Znieczulenie',
      originalTitle: 'Znieczulenie',
      year: '2026',
      season: 1,
      episode: 4,
    };
    const picked = selectTvMatches(wrapped, params);
    expect(picked.every((m) => m.type === 'tv')).toBe(true);
    expect(picked.some((m) => m.code === 'nsvx51')).toBe(false); // The Fix movie
  });
});
