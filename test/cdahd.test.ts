import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  splitTitle,
  parseSearchHtml,
  parseSeasons,
  parsePlayerTabs,
} from '../src/providers/cda-hd.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('cda-hd.cc splitTitle', () => {
  it('extracts the year from the raw title', () => {
    expect(splitTitle('Wiedźmin / The Hexer (2001)')).toEqual([
      'Wiedźmin / The Hexer',
      '2001',
    ]);
    expect(splitTitle('Wiedźmin / The Witcher')).toEqual([
      'Wiedźmin / The Witcher',
      '',
    ]);
  });
});

describe('cda-hd.cc search parsing', () => {
  const tiles = () => parseSearchHtml(fixture('cdahd-search.html'));

  it('parses tiles with title, year, quality and /tvshows/ type split', () => {
    const all = tiles();
    expect(all).toHaveLength(6);

    const movie = all.find((t) => t.url.includes('/59764/'));
    expect(movie).toEqual({
      title: 'Wiedźmin / The Hexer (2001)',
      url: 'https://cda-hd.cc/59764/wiedzmin-the-hexer-2001-online/',
      year: '2001',
      type: 'movie',
      quality: 'HD',
    });

    const series = all.find((t) =>
      t.url.endsWith('/tvshows/wiedzmin-the-witcher/')
    );
    expect(series?.type).toBe('tv');
    expect(series?.title).toBe('Wiedźmin / The Witcher (2019)');
  });

  it('matches "Wiedźmin" preferring year 2019 among tv tiles', () => {
    const tv = tiles().filter((t) => t.type === 'tv');
    const matches = pickMatches(tv, {
      imdbId: 'tt5180504',
      type: 'tv',
      title: 'Wiedźmin',
      originalTitle: 'The Witcher',
      year: '2019',
    });
    expect(matches[0].url).toBe('https://cda-hd.cc/tvshows/wiedzmin-the-witcher/');
  });

  it('matches the 2001 movie', () => {
    const movies = tiles().filter((t) => t.type === 'movie');
    const matches = pickMatches(movies, {
      imdbId: 'tt0300657',
      type: 'movie',
      title: 'Wiedźmin',
      originalTitle: 'The Hexer',
      year: '2001',
    });
    expect(matches[0].url).toBe(
      'https://cda-hd.cc/59764/wiedzmin-the-hexer-2001-online/'
    );
  });
});

describe('cda-hd.cc season parsing', () => {
  it('builds a season -> episodes map from se-c blocks', () => {
    const seasons = parseSeasons(fixture('cdahd-series.html'));
    expect(Object.keys(seasons).map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    const s1e1 = seasons[1].find((e) => e.episode === 1);
    expect(s1e1?.url).toBe('https://cda-hd.cc/episode/wiedzmin-sezon-1-odcinek-1-online');
    expect(s1e1?.name).toBe('Początek końca');
    const s2e1 = seasons[2].find((e) => e.episode === 1);
    expect(s2e1?.name).toBe('Ziarno prawdy');
  });
});

describe('cda-hd.cc player tabs', () => {
  it('maps episode iframes to their tab labels, skipping ad tabs', () => {
    const tabs = parsePlayerTabs(fixture('cdahd-episode.html'));
    expect(tabs).toEqual([
      { url: 'https://voe.sx/e/tlwiow0xvdfa', label: 'Lektor PL' },
      { url: 'https://vtbe.to/embed-zzlvrqfyap7k.html', label: 'Lektor PL' },
    ]);
  });

  it('maps movie iframes and skips the "Reklama" tab', () => {
    const tabs = parsePlayerTabs(fixture('cdahd-movie.html'));
    expect(tabs).toEqual([
      { url: 'https://ogladaj.me/e/pzxpb3njtvml', label: 'PL' },
    ]);
  });
});
