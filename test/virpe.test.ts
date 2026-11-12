import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchHtml,
  parseEpisodeList,
  parseServerLinks,
  parseMovieSources,
  seriesTitle,
} from '../src/providers/virpe.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('virpe.cc search parsing', () => {
  const items = () => parseSearchHtml(fixture('virpe-search.html'));

  it('classifies category rows as series, film-section articles as movies', () => {
    const movies = parseSearchHtml(fixture('virpe-search-movies.html')).filter(
      (i) => i.kind === 'movie'
    );
    expect(movies.map((m) => m.title)).toContain('Chłopaki nie płaczą');
    expect(
      movies.every((m) =>
        /\/(?:filmy-polskie-online-za-darmo|online-filmy-zagraniczne-za-darmo)\//.test(m.url)
      )
    ).toBe(true);
    expect(items().filter((i) => i.kind === 'series').length).toBeGreaterThan(5);
  });

  it('extracts season from title ("sezon N" and bare trailing number)', () => {
    const series = items().filter((i) => i.kind === 'series');
    const withSezon = series.find((s) => s.title === 'Przyjaciółki' && s.season === 26);
    expect(withSezon?.url).toBe('https://virpe.cc/polsat-online-free/przyjaciolki-26/');
    const bare = series.find((s) => s.title === 'Przyjaciółki' && s.season === 24);
    expect(bare?.url).toBe('https://virpe.cc/polsat-online-free/przyjaciolki-24/');
    expect(series.find((s) => s.season === 11)).toBeDefined();
  });

  it('skips audiobook links and keeps titles season-free for matching', () => {
    const all = items();
    expect(all.some((i) => /ksiazki-audio/.test(i.url))).toBe(false);
    expect(all.some((i) => i.title.includes('sezon'))).toBe(false);
  });

  it('matches "Przyjaciółki" S24 among season categories', () => {
    const series = items().filter((i) => i.kind === 'series');
    const matches = pickMatches(series, {
      imdbId: null,
      type: 'tv',
      title: 'Przyjaciółki',
      originalTitle: 'Przyjaciółki',
      year: '',
    });
    const s24 = matches.find((m) => (m as { season?: number }).season === 24);
    expect(s24?.url).toBe('https://virpe.cc/polsat-online-free/przyjaciolki-24/');
  });

  it('returns empty for pages without searchresults', () => {
    expect(parseSearchHtml('<html><body>nothing</body></html>')).toEqual([]);
  });
});

describe('virpe.cc seriesTitle', () => {
  it('handles "sezon N" suffixes', () => {
    expect(seriesTitle('Przyjaciółki online sezon 6', 'https://virpe.cc/x/przyjaciolki-online-sezon-6/')).toEqual([
      'Przyjaciółki online',
      6,
    ]);
  });

  it('falls back to a matching trailing number in title+url', () => {
    expect(seriesTitle('Przyjaciółki 26', 'https://virpe.cc/x/przyjaciolki-26/')).toEqual([
      'Przyjaciółki',
      26,
    ]);
  });

  it('keeps titles without season info intact', () => {
    expect(seriesTitle('Barwy Szczęścia', 'https://virpe.cc/tvp-online/barwy-szczescia-online/')).toEqual([
      'Barwy Szczęścia',
      0,
    ]);
  });
});

describe('virpe.cc episode list', () => {
  it('parses sectiontableentry rows with odcinek numbers', () => {
    const eps = parseEpisodeList(fixture('virpe-series.html'));
    expect(eps.length).toBeGreaterThanOrEqual(30);
    const ep12 = eps.find((e) => e.episode === 12);
    expect(ep12?.url).toBe(
      'https://virpe.cc/polsat-online-free/przyjaciolki-26/przyjaciolki-26-odcinek-12.html'
    );
  });
});

describe('virpe.cc article parsing', () => {
  it('parses p.server hoster links from an episode article', () => {
    const servers = parseServerLinks(fixture('virpe-episode.html'));
    expect(servers.map((s) => s.url)).toEqual([
      'https://listeamed.net/e/0DogOGJYVbjEKjM',
      'https://dood.to/e/huhy0tp28dbw',
      'https://videzz.net/yyre4rhndntp.html?asgtbndr=1',
    ]);
  });

  it('parses embed iframes from a movie article', () => {
    const urls = parseMovieSources(fixture('virpe-movie.html'));
    expect(urls).toEqual([
      'https://www.thevideo.me/embed-aszyjmu5yja6.html',
      'https://vodlocker.com/embed-1hv0iiiehb8s-600x400.html',
    ]);
  });
});
