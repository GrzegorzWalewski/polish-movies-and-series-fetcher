import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseTiles,
  parsePlaylistHtml,
} from '../src/providers/seriale-vip.js';
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

describe('seriale.vip search tile parsing', () => {
  it('parses tiles with year from URL, classifies Film/Serial', () => {
    const items = parseTiles(fixture('seriale-search.html'));
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      title: 'Wiedźmin (2019)',
      url: 'https://seriale.vip/serials/30078-wiedmin-2019.html',
      type: 'tv',
    });
    expect(items[1].type).toBe('movie');
    expect(items[1].title).toBe('Szczury: Opowieść ze świata Wiedźmina (2025)');
    // animation tile without label: tentatively tv (playlist decides the truth)
    expect(items[2].type).toBe('tv');
    expect(items[3].title).toBe('Fantastyczny Matt Parey (2023)');
  });

  it('ignores tiles without a title url', () => {
    expect(parseTiles('<a class="poster grid-item" href="/x/y.html"><h3 class="poster__title">no id</h3></a>')).toEqual([]);
  });

  it('matches "Wiedźmin" preferring year 2019', () => {
    const items = parseTiles(fixture('seriale-search.html'));
    const tv = items.filter((i) => i.type === 'tv');
    const matches = pickMatches(tv, params);
    expect(matches[0].url).toBe('https://seriale.vip/serials/30078-wiedmin-2019.html');
  });
});

describe('seriale.vip playlist parsing', () => {
  const playlist = () =>
    parsePlaylistHtml(JSON.parse(fixture('seriale-playlist.json')).response as string);

  it('maps flat season folders in "N Sezon" format to season numbers', () => {
    const items = playlist();
    const s1e1 = items.filter((i) => i.season === 1 && i.episode === 1);
    // strmup flat item + veev lektor item
    expect(s1e1.map((i) => i.url)).toEqual([
      'https://strmup.to/h0zeqsQUMFLWg',
      'https://veev.to/e/xyz222',
    ]);
    const s2e1 = items.find((i) => i.season === 2 && i.episode === 1);
    expect(s2e1?.url).toBe('https://strmup.to/abc111');
    const s2e3 = items.find((i) => i.season === 2 && i.episode === 3);
    expect(s2e3?.url).toBe('https://veev.to/e/xyz333');
    expect(s2e3?.player).toBe('VEEV');
  });

  it('extracts player and version from Stream-X chains', () => {
    const items = playlist();
    const veev = items.find((i) => i.url === 'https://veev.to/e/xyz333');
    expect(veev?.player).toBe('VEEV');
    expect(veev?.version).toBe('LEKTOR');
  });

  it('treats items without episode as movie versions', () => {
    const items = playlist();
    const movies = items.filter((i) => i.episode === 0);
    expect(movies.map((m) => m.version)).toEqual(['Dubbing', 'Dubbing']);
    expect(movies.map((m) => m.url)).toEqual([
      'https://fsst.online/embed/952628/',
      'https://vidara.so/e/rAyVK4MVkg90U',
    ]);
  });

  it('unescapes protocol-relative urls and dedupes', () => {
    const html = '<ul><li data-file="//cdn.example/x" data-id="0">Dubbing</li>' +
      '<li data-file="https://cdn.example/x" data-id="0">Dubbing</li></ul>';
    const items = parsePlaylistHtml(html);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://cdn.example/x');
  });

  it('returns empty for malformed json response', () => {
    expect(parsePlaylistHtml('not html')).toEqual([]);
  });
});
