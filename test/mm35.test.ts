import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSitemapTitles,
  parseContentAsset,
  seasonEpisode,
} from '../src/providers/mm35.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('35mm.online parseSitemapTitles', () => {
  const items = parseSitemapTitles(fixture('mm35-sitemap.xml'));

  it('extracts title-level /vod/<cat>/<slug> pages, slug as title', () => {
    expect(items).toContainEqual({
      title: 'walizka',
      url: 'https://35mm.online/vod/teatroteka/walizka',
    });
    expect(items).toContainEqual({
      title: 'u pana boga w krolowym moscie serial',
      url: 'https://35mm.online/vod/fabula/u-pana-boga-w-krolowym-moscie-serial',
    });
    expect(items).toContainEqual({
      title: 'reksio',
      url: 'https://35mm.online/vod/dla-dzieci/reksio',
    });
    expect(items).toHaveLength(3);
  });

  it('skips categories, doubled series paths, episodes and non-vod urls', () => {
    const urls = items.map((i) => i.url);
    expect(urls.some((u) => u.endsWith('/vod/fabula'))).toBe(false);
    expect(
      urls.some((u) => u.endsWith('/u-pana-boga-w-krolowym-moscie-serial/u-pana-boga-w-krolowym-moscie-serial'))
    ).toBe(false);
    expect(urls.some((u) => u.includes('-odc-1'))).toBe(false);
    expect(urls.some((u) => u.includes('subskrypcja'))).toBe(false);
    expect(urls.some((u) => u.includes('fonoteka'))).toBe(false);
  });

  it('dedupes repeated loc entries', () => {
    const xml = fixture('mm35-sitemap.xml') +
      '<url><loc>https://35mm.online/vod/teatroteka/walizka</loc></url>';
    expect(parseSitemapTitles(xml)).toHaveLength(3);
  });
});

describe('35mm.online parseContentAsset', () => {
  it('parses movie asset payload with metadata', () => {
    const a = parseContentAsset(fixture('mm35-asset.json'));
    expect(a?.alias).toBe('asset');
    expect(a?.title).toBe('Walizka');
    expect(a?.year).toBe('2013');
    expect(a?.quality).toBe('W rozdzielczości HD');
    expect(a?.language).toBeNull(); // sound: null in this payload
    expect(a?.seasons).toBeUndefined();
  });

  it('parses series payload with ordered seasons', () => {
    const s = parseContentAsset(fixture('mm35-series.json'));
    expect(s?.alias).toBe('series');
    expect(s?.title).toBe('Reksio');
    expect(s?.seasons).toHaveLength(1);
    expect(s?.seasons?.[0].episodes?.[0].url).toBe(
      '/vod/dla-dzieci/reksio/reksio/reksio-reksio-dentysta'
    );
  });

  it('returns null for error pages and non-json', () => {
    expect(parseContentAsset('{"statusCode":400,"content":{"alias":"error-page"}}')).toBeNull();
    expect(parseContentAsset('<html>blocked</html>')).toBeNull();
  });
});

describe('35mm.online seasonEpisode', () => {
  const s = parseContentAsset(fixture('mm35-series.json'))!;

  it('picks episodes by 1-based season/episode index', () => {
    const ep = seasonEpisode(s, 1, 1);
    expect(ep?.url).toBe('/vod/dla-dzieci/reksio/reksio/reksio-reksio-dentysta');
    expect(ep?.title).toBe('Reksio: Reksio dentysta');
    expect(seasonEpisode(s, 1, 3)?.title).toBe('Reksio i ptaki: Reksio i pelikan');
  });

  it('returns null for out-of-range or missing seasons', () => {
    expect(seasonEpisode(s, 2, 1)).toBeNull();
    expect(seasonEpisode(s, 1, 99)).toBeNull();
    expect(seasonEpisode({ ...s, seasons: undefined }, 1, 1)).toBeNull();
  });
});
