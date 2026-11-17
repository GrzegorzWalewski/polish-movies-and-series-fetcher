import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchHtml,
  parseWatchHtml,
  buildEpisodeUrl,
  isEkinoGate,
  extractEkinoTarget,
  buildVerifyBody,
} from '../src/providers/ekino-tv.js';
import {
  extractBootstrapData,
  parseSearchData,
  parseWatchPageHtml,
} from '../src/providers/obejrzyj-to.js';
import {
  parseSearchHtml as parseZaluknijSearchHtml,
  filterByType,
  parseTitleHtml,
  findEpisodeUrl,
} from '../src/providers/zaluknij.js';
import { pickMatches } from '../src/providers/match.js';
import { looksEpisodic } from '../src/providers/cda.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

const params = {
  imdbId: 'tt5180501',
  type: 'tv' as const,
  title: 'Wiedźmin',
  originalTitle: 'The Witcher',
  year: '2019',
};

describe('ekino-tv', () => {
  it('parses search results (real markup: title link inside .title)', () => {
    const results = parseSearchHtml(fixture('ekino-search.html'));
    expect(results).toHaveLength(3);
    expect(results[1]).toEqual({
      title: 'Wiedźmin',
      url: 'https://ekino.ws/serie/show/wiedzmin-the-witcher/',
      year: '2019',
    });
  });

  it('matches "Wiedźmin" preferring the release year from item id', () => {
    const results = parseSearchHtml(fixture('ekino-search.html'));
    expect(results[1].year).toBe('2019');
    const matches = pickMatches(results, params);
    // both entries match by title; year 2019 (from item id) picks the series
    expect(matches[0].url).toBe(
      'https://ekino.ws/serie/show/wiedzmin-the-witcher/'
    );
  });

  it('builds episode url from serie show url (port of zetta slug logic)', () => {
    expect(
      buildEpisodeUrl(
        'https://ekino.ws/serie/show/wiedzmin-the-witcher/',
        1,
        1
      )
    ).toBe(
      'https://ekino.ws/serie/watch/wiedzmin-the-witcher+season[1]+episode[1]+'
    );
    expect(
      buildEpisodeUrl('https://ekino.ws/show/12873/', 2, 10)
    ).toBe(
      'https://ekino.ws/serie/watch/12873+season[2]+episode[10]+'
    );
  });

  it('parses watch page: keeps player/hqq/jetload, filters mix/upzone', () => {
    const sources = parseWatchHtml(
      fixture('ekino-watch.html'),
      'https://ekino.ws/serie/watch/wiedzmin-the-witcher+season[1]+episode[1]+'
    );
    const urls = sources.map((s) => s.url);
    expect(urls).toContain(
      'https://ekino.ws/watch/f/player/s4z8VrloSf4BrpL6vEfTvsLfhpqeoVsXhDfY1w'
    );
    expect(urls).toContain(
      'https://ekino.ws/watch/f/hqq/hlf1u-eQ1dBWToExHAd8tKXJKwPUInHnLTWKdA'
    );
    expect(urls).toContain(
      'https://ekino.ws/watch/f/jetload/5xwfYzLXZmUC8u-SRQF9HXOoFiDfxtfBCb_5Gg'
    );
    // excluded hosts
    expect(urls.some((u) => u.includes('mix'))).toBe(false);
    expect(urls.some((u) => u.includes('upzone'))).toBe(false);
    // player appears twice with different ids -> both kept
    expect(urls.filter((u) => u.includes('/f/player/'))).toHaveLength(2);
    // no fallback needed
    expect(sources.every((s) => s.label !== 'DEFAULT PLAYER')).toBe(true);
  });

  it('falls back to default player when no ids found (movies only)', () => {
    const sources = parseWatchHtml(
      '<html><body></body></html>',
      'https://ekino.ws/movie/show/obsesja/42466/'
    );
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://ekino.ws/movie/watch/obsesja/42466/');
    expect(sources[0].label).toBe('DEFAULT PLAYER');
    // series show pages have no watch equivalent — no fallback
    const series = parseWatchHtml(
      '<html><body></body></html>',
      'https://ekino.ws/serie/show/wiedzmin/'
    );
    expect(series).toHaveLength(0);
  });

  it('detects the Turnstile gate page (live capture)', () => {
    const gateHtml =
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=hCaptchaCallback"></script>' +
      '<div id="center"><div id="gcaptcha"></div></div><script>window.hCaptchaCallback = function(){\n' +
      "turnstile.render('#gcaptcha', { sitekey:'0x4AAAAAAAFuHEOflkh2qqPw', callback: function(token) {\n" +
      "$.post('/watch/verify.php', {verify:token}, function(re){ if(re.error){ alert('err'); } }); }); };</script>";
    expect(isEkinoGate(gateHtml)).toBe(true);
    expect(isEkinoGate('<html>normal interstitial</html>')).toBe(false);
    expect(isEkinoGate('<html>verify.php mentioned alone</html>')).toBe(false);
  });

  it('extracts play.ekino.link tokens without leaking surrounding markup', () => {
    // live page has an unquoted href — the token charset stops the capture
    const html = '<a href=https://play.ekino.link/6bu7kIH9RCFrCfFe3pCbUcvOYILlxyJqRWRlbfOm8lkIZORiXT_DnTvbD2iT46IGRlDr <style>body{}</style>';
    expect(extractEkinoTarget(html)).toBe(
      'https://play.ekino.link/6bu7kIH9RCFrCfFe3pCbUcvOYILlxyJqRWRlbfOm8lkIZORiXT_DnTvbD2iT46IGRlDr'
    );
    expect(extractEkinoTarget('<p>nothing</p>')).toBeNull();
  });

  it('extracts direct hoster links from the buttonprch anchor (both attr orders)', () => {
    const hrefFirst =
      '<a href="https://dood.la/d/6o5ppdo390hnqu1px00mlrk0j9ixb" target="_blank" class="buttonprch"></a>';
    expect(extractEkinoTarget(hrefFirst)).toBe('https://dood.la/d/6o5ppdo390hnqu1px00mlrk0j9ixb');
    const classFirst =
      '<a class="buttonprch" href="https://voe.sx/e/abc123def456">GO</a>';
    expect(extractEkinoTarget(classFirst)).toBe('https://voe.sx/e/abc123def456');
  });

  it('builds the form-encoded verify body', () => {
    expect(buildVerifyBody('tok.en-x')).toBe('verify=tok.en-x');
  });
});

describe('obejrzyj.to', () => {
  it('extracts bootstrapData JSON', () => {
    const data = extractBootstrapData(fixture('obejrzyj-search.html'));
    expect(data?.loaders?.searchPage?.results).toHaveLength(3);
  });

  it('parses search page and keeps only series for tv type', () => {
    const data = extractBootstrapData(fixture('obejrzyj-search.html'));
    const matches = parseSearchData(data, 'Wiedźmin');
    expect(matches).toHaveLength(2);
    // note: zetta's slug algorithm drops non-ASCII ("Wiedźmin" -> "wied-min")
    expect(matches[0].url).toContain('/titles/the-witcher-2019/wied-min');
  });

  it('prefers exact imdb_id match from site metadata', () => {
    const data = extractBootstrapData(fixture('obejrzyj-search.html'));
    const matches = parseSearchData(data, 'Wiedźmin', 'tt5180501');
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toContain('/titles/the-witcher-2019/');
  });

  it('parses watch page into stream results', () => {
    const sources = parseWatchPageHtml(fixture('obejrzyj-watch.html'));
    // main video + alternative 102; alternative id 101 is the main video -> skipped
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe('https://cdn1.examplehost.tv/hls/s1e1.m3u8');
    expect(sources[0].quality).toBe('1080p');
    expect(sources[0].language).toBe('Lektor PL');
    expect(sources[1].url).toBe('https://host2.examplestream.net/v/abc123.mp4');
    expect(sources[1].language).toBe('PL napisy & Napisy PL');
  });
});

describe('zaluknij.cc', () => {
  it('parses search results with fallback selector', () => {
    const results = parseZaluknijSearchHtml(fixture('zaluknij-search.html'));
    expect(results).toHaveLength(3);
    expect(results[0].url).toContain('/serial-online/wiedzmin/');
  });

  it('filters by type using /serial-online/ url pattern', () => {
    const results = parseZaluknijSearchHtml(fixture('zaluknij-search.html'));
    const series = filterByType(results, 'tv');
    expect(series.map((m) => m.url)).toEqual([
      'https://zaluknij.cc/serial-online/wiedzmin/8787/',
      'https://zaluknij.cc/serial-online/cos-wiecej/8811/',
    ]);
    const movies = filterByType(results, 'movie');
    expect(movies).toHaveLength(1);
  });

  it('finds episode url by [sXXeYY] tag', () => {
    const url = findEpisodeUrl(fixture('zaluknij-title.html'), 1, 2);
    expect(url).toBe('https://zaluknij.cc/serial-online/wiedzmin/8787/odcinek-2');
  });

  it('parses title page: decodes base64 data-iframe, excludes junk hosts', () => {
    const sources = parseTitleHtml(
      fixture('zaluknij-title.html'),
      'https://zaluknij.cc/serial-online/wiedzmin/8787/odcinek-1'
    );
    expect(sources).toHaveLength(2); // voe row excluded
    expect(sources[0]).toMatchObject({
      provider: 'zaluknij.cc',
      url: 'https://www.cda.pl/video/1234567',
      language: 'Lektor PL',
      quality: '1080p',
    });
    expect(sources[1].url).toBe('https://ebd.examplecdn.stream/embed/xyz'); // protocol-relative -> https
  });
});

describe('fetcher', () => {
  it('detects Cloudflare challenge pages', async () => {
    const { isCloudflareChallenge } = await import('../src/utils/fetcher.js');
    expect(
      isCloudflareChallenge(
        '<html><head><title>Just a moment...</title></head><body>cf_chl_opt</body></html>'
      )
    ).toBe(true);
    expect(isCloudflareChallenge('<html><title>Wiedźmin online</title></html>')).toBe(
      false
    );
  });
});

describe('pickMatches year tolerance', () => {
  const base = {
    imdbId: null,
    type: 'movie' as const,
    title: 'Obsesja',
    originalTitle: 'Obsession',
  };

  it('prefers exact year when available', () => {
    const matches = pickMatches(
      [
        { title: 'Obsesja', url: '/movie/obsesja-2025', year: '2025' },
        { title: 'Obsesja', url: '/movie/obsesja-2026', year: '2026' },
      ],
      { ...base, year: '2026' }
    );
    expect(matches[0].url).toBe('/movie/obsesja-2026');
  });

  it('falls back to ±1 year when no exact hit (TMDB vs site year drift)', () => {
    // real case: TMDB says 2026 (premiere), ekino page is "obsesja-...-2025-lektor"
    const matches = pickMatches(
      [
        { title: 'Obsesja', url: '/movie/show/obsesja-hd-obsession-2025-lektor/42466', year: '2025' },
        { title: 'Obsesja coś', url: '/serie/show/obsesja-cos-2026', year: '2026' },
      ],
      { ...base, year: '2026' }
    );
    // exact-year ranks first, ±1 kept after it as a fallback
    expect(matches).toHaveLength(2);
    expect(matches[0].url).toBe('/serie/show/obsesja-cos-2026');
    expect(matches[1].url).toBe('/movie/show/obsesja-hd-obsession-2025-lektor/42466');
    const filtered = pickMatches(
      [
        { title: 'Obsesja', url: '/movie/show/obsesja-hd-obsession-2025-lektor/42466', year: '2025' },
      ],
      { ...base, year: '2026' }
    );
    expect(filtered).toHaveLength(1); // ±1 hit is kept when it's the only match
  });

  it('drops results ±2 or more years off when better candidates exist', () => {
    const matches = pickMatches(
      [
        { title: 'Obsesja', url: '/movie/obsesja-2023', year: '2023' },
        { title: 'Obsesja', url: '/movie/obsesja-2026', year: '2026' },
      ],
      { ...base, year: '2026' }
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].url).toBe('/movie/obsesja-2026');
  });

  it('drops results ±2 or more years off', () => {
    const matches = pickMatches(
      [{ title: 'Obsesja', url: '/movie/obsesja-2023', year: '2023' }],
      { ...base, year: '2026' }
    );
    expect(matches).toHaveLength(1); // single match: year filter only runs on >1
  });
});

describe('looksEpisodic (cda junk filter)', () => {
  it('flags S/E and odcinek-style upload titles', () => {
    expect(looksEpisodic('Obsesja s01e01')).toBe(true);
    expect(looksEpisodic('Obsesja S2E10 Lektor PL')).toBe(true);
    expect(looksEpisodic('Obsesja odcinek 2')).toBe(true);
    expect(looksEpisodic('Obsesja (2025) Lektor PL')).toBe(false);
    expect(looksEpisodic('Obsession 2025 FULL HD')).toBe(false);
  });
});
