import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  foldDiacritics,
  fileMeta,
  parseSearchResponse,
  parseEmbedUrl,
  parseEmbedPage,
  streamUrlFromPageUrl,
} from '../src/providers/freedisc.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('freedisc.pl diacritic folding', () => {
  it('folds Polish diacritics so dropped-diacritic file names still match', () => {
    expect(foldDiacritics('Chłopaki nie płaczą')).toBe('Chlopaki nie placza');
    expect(foldDiacritics('Żółć Ęś')).toBe('Zolc Es');
  });
});

describe('freedisc.pl fileMeta', () => {
  it('parses SxxExx names into tv meta (title after __ wins)', () => {
    const meta = fileMeta(
      'Jess i chlopaki - New.Girl.S02E03.PL.480p.WEB-DL.AC3.2.0.XviD-Ralf.DeiX.avi'
    );
    expect(meta?.type).toBe('tv');
    expect(meta?.title).toBe('Jess i chlopaki - New Girl');
    expect(meta?.season).toBe(2);
    expect(meta?.episode).toBe(3);
  });

  it('parses year names into movie meta', () => {
    const meta = fileMeta('Dragon Ball Super Film 02 - Super Hero (2022) Dubbing.mkv');
    expect(meta?.type).toBe('movie');
    expect(meta?.title).toBe('Dragon Ball Super Film 02 - Super Hero');
    expect(meta?.year).toBe('2022');
  });

  it('falls back to absolute odcinek numbers', () => {
    const meta = fileMeta('Barwy szczescia odcinek 2338.mp4');
    expect(meta?.type).toBe('tv');
    expect(meta?.episode).toBe(2338);
  });

  it('returns null for names without year, sxe, or odcinek', () => {
    expect(fileMeta('gandalf.mp4')).toBeNull();
  });
});

describe('freedisc.pl search response parsing', () => {
  const items = () => parseSearchResponse(fixture('freedisc-search.json'));

  it('maps type_fk 7 files to page urls using logins_translated', () => {
    const items_ = items();
    expect(items_.length).toBeGreaterThan(3);
    const first = items_.find((i) => i.url.includes('f-1085639'));
    expect(first?.url).toBe(
      'https://freedisc.pl/Andrzej78,f-1085639,chlopaki-na-ibizie-pl-dubbing-avi'
    );
    expect(first?.type).toBe('movie');
  });

  it('extracts sxe from file names for episode matching', () => {
    const ep = items().find((i) => i.url.includes('f-596792'));
    expect(ep?.type).toBe('tv');
    expect(ep?.season).toBe(2);
    expect(ep?.episode).toBe(3);
  });

  it('returns empty for html error bodies', () => {
    expect(parseSearchResponse('<html><title>404 error</title></html>')).toEqual([]);
  });
});

describe('freedisc.pl resolution', () => {
  it('extracts the direct mp4 from ld+json embedUrl', () => {
    expect(
      parseEmbedUrl(fixture('freedisc-file.html'))
    ).toBe(
      'https://stream.freedisc.pl/video/24049022/campus-drivers-s01e04-lektor-pl.mp4'
    );
  });

  it('extracts the mp4 from the embed page fallback', () => {
    expect(
      parseEmbedPage(fixture('freedisc-embed.html'))
    ).toBe(
      'https://stream.freedisc.pl/video/24049022/campus-drivers-s01e04-lektor-pl.mp4'
    );
  });

  it('constructs the stream url from a file page url', () => {
    expect(
      streamUrlFromPageUrl(
        'https://freedisc.pl/jackalus,f-24049022,campus-drivers-s01e04-lektor-pl-mp4'
      )
    ).toBe(
      'https://stream.freedisc.pl/video/24049022/campus-drivers-s01e04-lektor-pl.mp4'
    );
    expect(streamUrlFromPageUrl('https://freedisc.pl/nofile')).toBeNull();
  });
});
