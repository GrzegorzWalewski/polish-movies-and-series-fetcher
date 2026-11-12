import type { Provider } from '../types.js';
import { ekinoTv } from './ekino-tv.js';
import { obejrzyjTo } from './obejrzyj-to.js';
import { zaluknij } from './zaluknij.js';
import { cda } from './cda.js';
import { filman } from './filman.js';
import { bajeczki24 } from './bajeczki24.js';
import { premiumsmart } from './premiumsmart.js';

/** All enabled providers. Later batches add entries here. */
export const providers: Provider[] = [
  ekinoTv,
  obejrzyjTo,
  zaluknij,
  cda,
  filman,
  bajeczki24,
  premiumsmart,
];
