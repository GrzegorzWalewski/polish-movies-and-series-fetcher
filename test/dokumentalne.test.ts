import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  decodeEntities,
  parseRestSearch,
  parsePostIframes,
} from '../src/providers/dokumentalne.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('dokumentalne.net decodeEntities', () => {
  it('decodes numeric and named entities from WP titles', () => {
    expect(decodeEntities('NASA &#8211; Blaski i cienie')).toBe(
      'NASA – Blaski i cienie'
    );
    expect(decodeEntities('&#8222;To&#8221; &amp; &#8212;')).toBe('„To” & —');
    expect(decodeEntities('Cze&#347;&#263;')).toBe('Cześć');
  });
});

describe('dokumentalne.net parseRestSearch', () => {
  const items = parseRestSearch(fixture('dokumentalne-search.json'));

  it('parses posts with year stripped from title into year field', () => {
    expect(items[0]).toEqual({
      title: 'Apollo 11',
      url: 'https://dokumentalne.net/apollo-11/',
      year: '2019',
      wpId: 21206,
    });
    expect(items[1].title).toBe('Mercury 13');
    expect(items[1].year).toBe('');
  });

  it('decodes entities and keeps en-dash titles', () => {
    expect(items[2].title).toBe('Historia NASA – Na Księżyc');
  });

  it('returns empty for non-json responses', () => {
    expect(parseRestSearch('<html>blocked</html>')).toEqual([]);
    expect(parseRestSearch('{"code":"rest_invalid"}')).toEqual([]);
  });
});

describe('dokumentalne.net parsePostIframes', () => {
  it('collects embed iframes, resolving protocol-relative urls', () => {
    const urls = parsePostIframes(fixture('dokumentalne-post.html'));
    expect(urls).toEqual([
      'https://ok.ru/videoembed/1900982766321',
      'https://widgets.example.com/widget.html',
    ]);
  });

  it('returns empty for description-only posts (no player)', () => {
    expect(parsePostIframes('<p>tylko opis, brak video</p>')).toEqual([]);
  });
});
