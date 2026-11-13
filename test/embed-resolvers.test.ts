import { describe, expect, it } from 'vitest';
import { classifyStreamUrl } from '../src/utils/resolvers/index.js';
import { intToToken, unpackPacker, findMediaUrl } from '../src/utils/resolvers/packer.js';
import { decodeVoePayload } from '../src/utils/resolvers/voe.js';
import { extractMd5Path, buildFinalUrl } from '../src/utils/resolvers/dood.js';
import { extractHlsUrl, selectBestVariant } from '../src/utils/resolvers/vidmoly.js';
import { extractFromJs, fixUrl } from '../src/utils/resolvers/vidoza.js';
import { normalizeCdaId } from '../src/utils/resolvers/cda.js';
import {
  customHash256,
  leadingZeroBits,
  solvePow,
  keyFromParts,
  decryptPlayback,
} from '../src/utils/resolvers/byse.js';
import {
  extractStreamtapeId,
  extractIdeoolink,
  parseRobotConstruction,
  assembleRobotUrl,
  extractGetVideoParams,
} from '../src/utils/resolvers/streamtape.js';
import { extractOkruMediaUrl } from '../src/utils/resolvers/okru.js';
import { extractTvpProductId } from '../src/utils/resolvers/tvpvod.js';

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('classifyStreamUrl', () => {
  it('direct media extensions', () => {
    expect(classifyStreamUrl('https://cdn.x/v.m3u8?tok=1')).toBe('direct');
    expect(classifyStreamUrl('https://cdn.x/v.mp4')).toBe('direct');
  });

  it('known embed hosts', () => {
    expect(classifyStreamUrl('https://voe.sx/e/abc')).toBe('embed');
    expect(classifyStreamUrl('https://ebd.cda.pl/620x368/abc123')).toBe('embed');
    expect(classifyStreamUrl('https://dood.la/d/abc')).toBe('embed');
    expect(classifyStreamUrl('https://vide0.net/e/abc')).toBe('embed');
    expect(classifyStreamUrl('https://vidmoly.me/e/abc')).toBe('embed');
    expect(classifyStreamUrl('https://bysesukior.com/e/abc')).toBe('embed');
    expect(classifyStreamUrl('https://strmup.to/e/abc')).toBe('embed');
  });

  it('site pages', () => {
    expect(classifyStreamUrl('https://ekino-tv.pl/movie/show/x')).toBe('page');
    expect(classifyStreamUrl('not a url')).toBe('page');
  });
});

describe('packer', () => {
  it('encodes base62 tokens like the packer alphabet', () => {
    expect(intToToken(0, 62)).toBe('0');
    expect(intToToken(9, 62)).toBe('9');
    expect(intToToken(10, 62)).toBe('a');
    expect(intToToken(35, 62)).toBe('z');
    expect(intToToken(36, 62)).toBe('A');
    expect(intToToken(11, 62)).toBe('b');
    expect(intToToken(62, 62)).toBe('10');
  });

  it('unpacks a P.A.C.K.E.R. blob containing a media URL', () => {
    // minimal real-format blob with escaped quotes inside the packed string
    // unpacked equivalent: `var file='https://v.x/s.m3u8';play(file);`
    const packed =
      "eval(function(p,a,c,k,e,d){e=function(c){return c};while(c--){if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c])}return p}('1 0=\\'2\\';3(0);',10,4,'file|var|https://v.x/s.m3u8|play'.split('|'),0,{}))";
    const unpacked = unpackPacker(packed);
    // escaped quotes survive into the unpacked JS (valid JS escapes)
    expect(unpacked).toContain("var file=\\'https://v.x/s.m3u8\\'");
    expect(findMediaUrl(unpacked)).toBe('https://v.x/s.m3u8');
  });

  it('returns input unchanged when nothing is packed', () => {
    const plain = 'var a=1;';
    expect(unpackPacker(plain)).toBe(plain);
    expect(findMediaUrl(plain)).toBeNull();
  });

  it('handles multi-digit tokens with word boundaries', () => {
    // radix 36, count 12: token "a"=10 … tokens 10 and 11 must not corrupt token 1
    const packed =
      "eval(function(p,a,c,k,e,d){while(c--){if(k[c])p=p.replace(new RegExp('\\\\b'+c.toString(a)+'\\\\b','g'),k[c])}return p}('1 1 1 b a 0',3,3,'zero|one|two'.split('|'),0,{}))";
    expect(unpackPacker(packed)).toContain('one');
  });
});

describe('voe payload decode', () => {
  // inverse of the documented decode chain, used to build a test vector:
  // encode: JSON -> b64 -> reverse -> shift(+3) -> b64 -> rot13
  function encode(source: string, junk: string[]): { ct: string; luts: string } {
    const b1 = Buffer.from(JSON.stringify({ source }), 'utf-8').toString('base64');
    const shifted = b1
      .split('')
      .reverse()
      .join('')
      .split('')
      .map((c) => String.fromCharCode(c.charCodeAt(0) + 3))
      .join('');
    const b2 = Buffer.from(shifted, 'utf-8').toString('base64');
    // insert junk pairs (no regex metachars) at fixed offsets
    let withJunk = b2;
    for (let i = 0; i < junk.length; i++) {
      const pos = (i + 1) * 5;
      withJunk = withJunk.slice(0, pos) + junk[i] + withJunk.slice(pos);
    }
    // rot13 is self-inverse
    const ct = withJunk.replace(/[a-zA-Z]/g, (c) => {
      const x = c.charCodeAt(0);
      const base = x < 91 ? 65 : 97;
      return String.fromCharCode(((x - base + 13) % 26) + base);
    });
    return { ct, luts: "['" + junk.join("','") + "']" };
  }

  it('decodes the LUT-based payload to JSON source', () => {
    const { ct, luts } = encode('https://x.cdn/source.m3u8', ['&&', '!!']);
    const data = decodeVoePayload(ct, luts);
    expect(data?.source).toBe('https://x.cdn/source.m3u8');
  });

  it('returns null on garbage', () => {
    expect(decodeVoePayload('!!!not-base64!!!', "['&&']")).toBeNull();
  });
});

describe('dood helpers', () => {
  it('finds the pass_md5 path', () => {
    const html = `<script>var a="/pass_md5/8f3a.../AbCdEf?token=x';</script>`;
    expect(extractMd5Path(html)).toBe('/pass_md5/8f3a.../AbCdEf?token=x');
    expect(extractMd5Path('<p>nothing</p>')).toBeNull();
  });

  it('appends a 10-char hash and token param', () => {
    const url = buildFinalUrl('https://v.dood.la/hls', 'AbCdEf');
    expect(url).toMatch(/^https:\/\/v\.dood\.la\/hls[A-Za-z0-9]{10}\?token=AbCdEf$/);
  });
});

describe('vidmoly helpers', () => {
  it('extracts the master HLS url', () => {
    const html = 'sources : [{file: "https://cdn.v/master.m3u8"}], other';
    expect(extractHlsUrl(html)).toBe('https://cdn.v/master.m3u8');
    expect(extractHlsUrl('<html></html>')).toBeNull();
  });

  it('selects the highest-bandwidth variant', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
      'high/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720',
      'mid/index.m3u8',
    ].join('\n');
    expect(selectBestVariant(playlist, 'https://cdn.v/master.m3u8')).toBe(
      'https://cdn.v/high/index.m3u8'
    );
  });

  it('falls back to the master url when no variants', () => {
    expect(selectBestVariant('#EXTM3U', 'https://cdn.v/master.m3u8')).toBe(
      'https://cdn.v/master.m3u8'
    );
  });
});

describe('vidoza helpers', () => {
  it('extracts file+res pairs and sorts by quality desc', () => {
    const html =
      `jwplayer("v").setup({file: "https://s.vidoza.net/v/low.mp4", res: "360p", other: 1});
       jwplayer("v").setup({file: "https://s.vidoza.net/v/high.mp4", res: "1080p"});`;
    const out = extractFromJs(html);
    expect(out).toHaveLength(2);
    expect(out[0].quality).toBe('1080p');
    expect(out[0].url).toBe('https://s.vidoza.net/v/high.mp4');
  });

  it('fixes scheme-relative urls', () => {
    expect(fixUrl('//str38.vidoza.net/v/a.mp4')).toBe('https://str38.vidoza.net/v/a.mp4');
    expect(fixUrl('https://x/v.mp4')).toBe('https://x/v.mp4');
  });
});

describe('byse pow + playback decrypt', () => {
  it('customHash256 is deterministic and 8 words wide', () => {
    const a = customHash256(new TextEncoder().encode('nonce:0'));
    const b = customHash256(new TextEncoder().encode('nonce:0'));
    const c = customHash256(new TextEncoder().encode('nonce:1'));
    expect(a).toHaveLength(8);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
  });

  it('leadingZeroBits counts across zero words', () => {
    expect(leadingZeroBits(new Uint32Array([0x80000000]))).toBe(0);
    expect(leadingZeroBits(new Uint32Array([0xffffffff]))).toBe(0);
    expect(leadingZeroBits(new Uint32Array([0]))).toBe(32);
    expect(leadingZeroBits(new Uint32Array([0, 0xffffffff]))).toBe(32);
    expect(leadingZeroBits(new Uint32Array([0, 0x00400000]))).toBe(41);
    expect(leadingZeroBits(new Uint32Array([0x00010000, 0]))).toBe(15);
  });

  it('solvePow finds a solution satisfying the difficulty', () => {
    const solution = solvePow('testnonce', 8, 5_000);
    expect(solution).not.toBeNull();
    const digest = customHash256(
      new TextEncoder().encode(`testnonce:${solution}`)
    );
    expect(leadingZeroBits(digest)).toBeGreaterThanOrEqual(8);
  });

  it('solvePow with zero difficulty short-circuits', () => {
    expect(solvePow('n', 0, 100)).toBe('0');
  });

  it('decrypts the playback payload using the version permutation', async () => {
    // 32-byte key split into two halves, placed at parts[version-1] and parts[31-version-1]
    const version = 3;
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = (i * 7 + 1) & 255;
    const parts: string[] = new Array(31).fill('');
    parts[version - 1] = b64urlEncode(key.slice(0, 16));
    parts[31 - version - 1] = b64urlEncode(key.slice(16));

    const iv = new Uint8Array(12).fill(9);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      key,
      'AES-GCM',
      false,
      ['encrypt']
    );
    const payload = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      cryptoKey,
      new TextEncoder().encode(
        JSON.stringify({ sources: [{ url: 'https://edge/x/master.m3u8', label: '1080p' }] })
      )
    );

    const cfg = await decryptPlayback({
      algorithm: 'AES-GCM',
      iv: b64urlEncode(iv),
      payload: b64urlEncode(new Uint8Array(payload)),
      key_parts: parts,
      version: String(version),
    });
    expect(cfg?.sources?.[0]?.url).toBe('https://edge/x/master.m3u8');
    expect(cfg?.sources?.[0]?.label).toBe('1080p');
  });

  it('keyFromParts falls back to all parts without a valid version', () => {
    const p1 = b64urlEncode(new Uint8Array([1, 2, 3]));
    const p2 = b64urlEncode(new Uint8Array([4, 5]));
    expect([...keyFromParts({ algorithm: 'AES-GCM', iv: '', payload: '', key_parts: [p1, p2], version: '99' })]).toEqual([1, 2, 3, 4, 5]);
    expect(keyFromParts({ algorithm: 'AES-GCM', iv: '', payload: '', key_parts: [], version: '1' })).toHaveLength(0);
  });
});

describe('streamtape helpers', () => {
  it('extracts the video id from /e/ paths', () => {
    expect(extractStreamtapeId('https://streamtape.to/e/AbCdEf123/')).toBe('AbCdEf123');
    expect(extractStreamtapeId('https://streamtape.com/e/xyz?x=1')).toBe('xyz');
    expect(extractStreamtapeId('https://streamtape.com/v/xyz')).toBeNull();
    expect(extractStreamtapeId('garbage')).toBeNull();
  });

  it('reads the server-rendered ideoolink div', () => {
    expect(extractIdeoolink('<div id="ideoolink" class="x">//get.st/v.mp4</div>')).toBe(
      'https://get.st/v.mp4'
    );
    expect(extractIdeoolink("<div id='ideoolink'>https://get.st/v.mp4</div>")).toBe(
      'https://get.st/v.mp4'
    );
    expect(extractIdeoolink('<div id="other">x</div>')).toBeNull();
  });

  it('parses and assembles the robot() JS construction', () => {
    const html =
      `document.getElementById('ideoolink').innerHTML = '//get.site.com/get_video?id=abc';` +
      `robot('%26expires%3D123%26token%3DXY').substring(9)`;
    const m = parseRobotConstruction(html);
    expect(m).not.toBeNull();
    expect(m!.substr1).toBe(9);
    const url = assembleRobotUrl(m!);
    expect(url).toBe('https://get.site.com/get_video?id=abcs%3D123%26token%3DXY');
  });

  it('finds get_video params via the video-id split method', () => {
    // 10 chunks containing the id, then the id, then params starting chunk 11
    const html10 =
      Array(10).fill('x').join('/e/QS5xQ8Db4Y/') + '/e/QS5xQ8Db4Y' + "?expires=1&token=t' rest";
    expect(extractGetVideoParams(html10, 'QS5xQ8Db4Y')).toBe('?expires=1&token=t');
    expect(extractGetVideoParams('<p>nope</p>', 'QS5xQ8Db4Y')).toBeNull();
  });
});

describe('ok.ru data-options extraction', () => {
  const fixture = (metadata: string) =>
    `<div data-options="${metadata.replace(/"/g, '&quot;')}"></div>`;

  it('prefers hlsManifestUrl', () => {
    const md = JSON.stringify({ hlsManifestUrl: 'https://vd.okcdn.ru/video.m3u8?sig=x' });
    const out = extractOkruMediaUrl(fixture(`{"playerId":"p","flashvars":{"metadata":${md}}}`));
    expect(out?.url).toBe('https://vd.okcdn.ru/video.m3u8?sig=x');
    expect(out?.quality).toBeNull();
  });

  it('parses nested metadata JSON strings and falls back to videos[]', () => {
    const md = JSON.stringify({
      videos: [
        { name: 'mobile', url: 'https://v/m.mp4', disallowed: false },
        { name: 'full', url: 'https://v/full.mp4', disallowed: false },
        { name: 'low', url: 'https://v/l.mp4', disallowed: true },
      ],
    });
    const html = fixture(`{"flashvars":{"metadata":${JSON.stringify(md)}}}`);
    const out = extractOkruMediaUrl(html);
    expect(out?.url).toBe('https://v/full.mp4');
    expect(out?.quality).toBe('full');
  });

  it('returns null without data-options or on garbage', () => {
    expect(extractOkruMediaUrl('<html></html>')).toBeNull();
    expect(extractOkruMediaUrl('<div data-options="not json"></div>')).toBeNull();
  });
});

describe('tvp vod id extraction', () => {
  it('reads the product id after the last comma', () => {
    expect(
      extractTvpProductId('https://vod.tvp.pl/seriale,18/ranczo-odcinki,316445/odcinek-1,S00E01,3092745')
    ).toBe('3092745');
    expect(extractTvpProductId('https://vod.tvp.pl/filmy-fabularne,136/samsara,2439790')).toBe(
      '2439790'
    );
    expect(extractTvpProductId('https://vod.tvp.pl/')).toBeNull();
    expect(extractTvpProductId('garbage')).toBeNull();
  });
});

describe('cda id normalization', () => {
  it('extracts ids from url shapes', () => {
    expect(normalizeCdaId('https://www.cda.pl/video/205342abc')).toBe('205342abc');
    expect(normalizeCdaId('https://ebd.cda.pl/620x368/205342abc')).toBe('205342abc');
    expect(normalizeCdaId('https://www.cda.pl/video/205342abc/vfilm')).toBe(null);
  });

  it('rejects non-cda hosts', () => {
    expect(normalizeCdaId('https://evil.com/video/abc')).toBeNull();
    expect(normalizeCdaId('garbage')).toBeNull();
  });
});
