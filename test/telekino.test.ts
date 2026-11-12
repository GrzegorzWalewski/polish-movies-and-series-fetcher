import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeEntities,
  parseEpisodeTitle,
  parseTiles,
  parsePostTags,
  parseEmbedIframes,
  nextPageUrl,
} from '../src/providers/telekino.js';
import { pickMatches } from '../src/providers/match.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('telekino.top decodeEntities', () => {
  it('decodes en-dash and apostrophe entities', () => {
    expect(decodeEntities('Wiedźmin &#8211; 7 &#8211; Przed upadkiem')).toBe(
      'Wiedźmin \u2013 7 \u2013 Przed upadkiem'
    );
    expect(decodeEntities('Co&#8217;s więcej')).toBe("Co's więcej");
  });
});

describe('telekino.top parseEpisodeTitle', () => {
  it('extracts series, episode and name from en-dash titles', () => {
    expect(parseEpisodeTitle('Wiedźmin \u2013 7 \u2013 Przed upadkiem')).toEqual({
      series: 'Wiedźmin',
      episode: 7,
      name: 'Przed upadkiem',
    });
  });

  it('accepts hyphen separators', () => {
    expect(parseEpisodeTitle('Wiedźmin - 7 - Przed upadkiem')).toEqual({
      series: 'Wiedźmin',
      episode: 7,
      name: 'Przed upadkiem',
    });
  });

  it('returns null for movie titles', () => {
    expect(parseEpisodeTitle('Inspektor Clouseau')).toBeNull();
    expect(parseEpisodeTitle('Wiedźmin \u2013 Zmora Wilka')).toBeNull();
  });
});

describe('telekino.top search parsing', () => {
  it('parses the loop tiles only (widgets lack post type-post)', () => {
    const tiles = parseTiles(fixture('telekino-search.html'));
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({
      title: 'Wiedźmin',
      url: 'https://telekino.top/wiedzmin-7-przed-upadkiem/',
      episode: 7,
      gated: false,
    });
  });

  it('flags login-gated posts from the category class', () => {
    const tiles = parseTiles(fixture('telekino-tag.html'));
    const ep9 = tiles.find((t) => t.episode === 9);
    expect(ep9?.gated).toBe(true);
    const ep7 = tiles.find((t) => t.episode === 7);
    expect(ep7?.gated).toBe(false);
    // the movie "Zmora Wilka" carries no episode number and is gated
    const movie = tiles.find((t) => t.episode === null);
    expect(movie?.title).toBe('Wiedźmin \u2013 Zmora Wilka');
    expect(movie?.gated).toBe(true);
  });

  it('matches series tiles by series name via pickMatches', () => {
    const tiles = parseTiles(fixture('telekino-search.html'));
    const matches = pickMatches(tiles, {
      imdbId: 'tt5180504',
      type: 'tv',
      title: 'Wiedźmin',
      originalTitle: 'The Witcher',
      year: '2019',
    });
    expect(matches[0].url).toBe('https://telekino.top/wiedzmin-7-przed-upadkiem/');
  });
});

describe('telekino.top tag archive', () => {
  it('lists all episodes with absolute numbering', () => {
    const tiles = parseTiles(fixture('telekino-tag.html')).filter(
      (t) => t.episode !== null
    );
    expect(tiles).toHaveLength(23);
    const eps = tiles.map((t) => t.episode).sort((a, b) => a! - b!);
    expect(eps[0]).toBe(2); // ep 1 sits on archive page 2
    expect(eps).toContain(9); // "Ziarno prawdy" = S02E01 absolute
  });

  it('extracts the next pagination link', () => {
    expect(nextPageUrl(fixture('telekino-tag.html'))).toBe(
      'https://telekino.top/tag/wiedzmin-the-witcher/page/2/'
    );
    expect(nextPageUrl(fixture('telekino-search.html'))).toBe(
      'https://telekino.top/page/2/?s=wied%C5%BAmin'
    );
  });
});

describe('telekino.top post pages', () => {
  it('extracts series tags from the episode post', () => {
    expect(parsePostTags(fixture('telekino-episode.html'))).toEqual([
      'wiedzmin-the-witcher',
    ]);
  });

  it('extracts player iframes from episode and movie posts', () => {
    expect(parseEmbedIframes(fixture('telekino-episode.html'))).toEqual([
      'https://filelions.online/v/8dyoazanaka4',
    ]);
    expect(parseEmbedIframes(fixture('telekino-movie.html'))).toEqual([
      'https://ebd.cda.pl/620x395/1998733743',
    ]);
  });
});
