import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSearchHtml,
  decodeCdaFile,
  parsePlayerData,
  detectLanguage,
  yearDiffers,
  formatDuration,
} from '../src/providers/cda.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('cda.pl search parsing', () => {
  it('parses search results with premium flag and quality hint', () => {
    const items = parseSearchHtml(fixture('cda-search.html'));
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      id: '101573308e',
      title: 'Diuna odcinek 1',
      premium: true,
      qualityHint: '1080p',
    });
  });

  it('marks free videos correctly', () => {
    const items = parseSearchHtml(fixture('cda-search.html'));
    expect(items.find((i) => i.id === '1046822391')?.premium).toBe(false);
    expect(items.find((i) => i.id === '1502279402')?.premium).toBe(false);
  });
});

describe('cda.pl file decoding (e2iplayer algorithm, live-verified)', () => {
  it('decodes the obfuscated file field into a direct mp4 URL', () => {
    // real 202-char obfuscated string captured from a live embed page
    const obfuscated =
      'GH2Hefb%5Db452%5DA%3D%5E6%5E3%5E5%5E%3Fx%7Et9uJf%3AIG%22%2A%2B%2Bbp%5C%3Dy4%22%5Ebbh3%5E%2B%3DxH%7Ety%7D%25%26A%28%27wpc%2B%3Eyu%2Bu%2B93K_%5E%60fhcdcd_ec%5E%3DBa72b%606%60a_dgagh3h5ef6d_3a%605h4e5b__Q5';
    const decoded = decodeCdaFile(obfuscated);
    expect(decoded).toBe(
      'https://vwaw673.cda.pl/e/b/d/nIOEhFy7ixvQYZZ3A-lJcQ/339b/ZlIwOEJNTUpWVHA4ZmJFZFZhbz0/1794545064/lq2fa31e12058289b9d67e50b21d9c6d30.mp4'
    );
  });

  it('strips obfuscation markers before decoding', () => {
    // markers (_Q5, _XDDD, ...) are placeholder junk inserted by cda
    expect(decodeCdaFile('abc_Q5def')).toBe(decodeCdaFile('abcdef'));
    expect(decodeCdaFile('ab_XDDDcd_ADC')).toBe(decodeCdaFile('abcd'));
  });

  it('handles upstream variant URLs', () => {
    // '2^FADEC62>3' is the obfuscated form of 'a/upstreamb' under the +14 remap
    const decoded = decodeCdaFile('2%5EFADEC62%3E3');
    expect(decoded).toBe('https://a.mp4/upstreamb');
  });
});

describe('cda.pl player_data', () => {
  it('extracts video object from embed page', () => {
    const video = parsePlayerData(fixture('cda-embed.html'));
    expect(video).not.toBeNull();
    expect(video!.quality).toBe('lq');
    expect(video!.qualities).toEqual({
      '360p': 'vl',
      '480p': 'lq',
      '720p': 'sd',
      '1080p': 'hd',
    });
  });

  it('returns null for premium upsell pages (no player_data)', () => {
    expect(parsePlayerData(fixture('cda-embed-premium.html'))).toBeNull();
  });
});

describe('cda.pl language detection', () => {
  it('detects Lektor/Napisy/Dubbing from upload titles', () => {
    expect(detectLanguage('Dune / Diuna (1984) Lektor PL')).toBe('Lektor PL');
    expect(detectLanguage('Diuna (1984) Napisy PL')).toBe('Napisy PL');
    expect(detectLanguage('Film Dubbing PL')).toBe('Dubbing PL');
    expect(detectLanguage('Diuna odcinek 1')).toBeNull();
  });
});

describe('cda.pl junk-upload filters', () => {
  it('yearDiffers: flags uploads self-labeling a different year', () => {
    expect(yearDiffers('Obsesja. 2009. Lektor.pl', '2026')).toBe(true);
    expect(yearDiffers('Obsesja (2004) FULL HD', '2026')).toBe(true);
    expect(yearDiffers('Obsesja 2025 Lektor PL', '2026')).toBe(false); // ±1 ok
    expect(yearDiffers('Obsesja (2026) Napisy PL', '2026')).toBe(false);
    expect(yearDiffers('Obsesja Lektor PL', '2026')).toBe(false); // no year
  });

  it('formatDuration renders h:mm:ss', () => {
    expect(formatDuration(5029)).toBe('1:23:49');
    expect(formatDuration(754)).toBe('12:34');
  });
});
