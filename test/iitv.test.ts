import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSeriesList,
  pickSeries,
  episodeUrl,
  isHomepageShell,
  parsePlayerLinks,
  parsePlayerFragment,
} from '../src/providers/iitv.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) =>
  readFileSync(join(fixturesDir, name), 'utf-8');

describe('iitv.info parseSeriesList', () => {
  const items = parseSeriesList(fixture('iitv-home.html'));

  it('parses all-series entries with Polish + original titles', () => {
    expect(items.length).toBe(4);
    expect(items[1].title).toBe('07 zgłoś się');
    expect(items[1].slug).toBe('07-zglos-sie');
    expect(items[2].titleOriginal).toBe('100 things to do before high school');
    expect(items[2].url).toBe('serial,564,100-rzeczy-do-przezycia-przed-liceum.html');
  });

  it('ignores entries outside #allSeries (popular list)', () => {
    // popular list has 1 duplicate entry — allSeries items deduped by url
    expect(items.filter((i) => i.slug === '07-zglos-sie').length).toBe(1);
  });

  it('returns empty when the list is missing', () => {
    expect(parseSeriesList(fixture('iitv-homepage-shell.html'))).toEqual([]);
  });
});

describe('iitv.info pickSeries', () => {
  const items = parseSeriesList(fixture('iitv-home.html'));

  it('matches the Polish title', () => {
    expect(pickSeries(items, '07 zgłoś się', '')?.slug).toBe('07-zglos-sie');
  });

  it('matches the original title (diacritics folded by matcher)', () => {
    expect(
      pickSeries(items, '100 rzeczy do przezycia przed liceum', '100 Things to Do Before High School')?.slug
    ).toBe('100-rzeczy-do-przezycia-przed-liceum');
  });

  it('returns null when nothing matches', () => {
    expect(pickSeries(items, 'Breaking Bad', 'Breaking Bad')).toBeNull();
  });
});

describe('iitv.info episodeUrl', () => {
  it('builds zero-padded episode urls', () => {
    expect(episodeUrl('07-zglos-sie', 1, 1)).toBe(
      'https://iitv.info/epizod,07-zglos-sie,s01e01.html'
    );
    expect(episodeUrl('community', 10, 23)).toBe(
      'https://iitv.info/epizod,community,s10e23.html'
    );
  });
});

describe('iitv.info isHomepageShell', () => {
  it('detects the generic homepage title (redirect target)', () => {
    expect(isHomepageShell(fixture('iitv-homepage-shell.html'))).toBe(true);
    expect(isHomepageShell(fixture('iitv-episode.html'))).toBe(false);
  });
});

describe('iitv.info parsePlayerLinks', () => {
  it('extracts data-href + hoster label in order, deduped', () => {
    const links = parsePlayerLinks(fixture('iitv-episode.html'));
    expect(links).toEqual([
      { href: 'show-player,5569689,35904.html', hoster: 'upstream.to' },
      { href: 'show-player,198325,35904.html', hoster: 'vod.tvp.pl' },
      { href: 'show-player,5074887,35904.html', hoster: 'aparat.cam' },
    ]);
  });
});

describe('iitv.info parsePlayerFragment', () => {
  it('extracts the external hoster embed url', () => {
    expect(parsePlayerFragment(fixture('iitv-player-fragment.html'))).toBe(
      'https://upstream.to/45vlehk1ai45'
    );
    expect(parsePlayerFragment('<div>no link here</div>')).toBeNull();
  });
});
