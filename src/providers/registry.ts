import type { Provider } from '../types.js';
import { ekinoTv } from './ekino-tv.js';
import { obejrzyjTo } from './obejrzyj-to.js';
import { zaluknij } from './zaluknij.js';
import { cda } from './cda.js';
import { filman } from './filman.js';
import { bajeczki24 } from './bajeczki24.js';
import { premiumsmart } from './premiumsmart.js';
import { serialeVip } from './seriale-vip.js';
import { maxvod } from './maxvod.js';
import { virpe } from './virpe.js';
import { freedisc } from './freedisc.js';
import { cdaHd } from './cda-hd.js';
import { telekino } from './telekino.js';
import { vider } from './vider.js';
import { iitv } from './iitv.js';
import { dokumentalne } from './dokumentalne.js';
import { mm35 } from './mm35.js';

/** All enabled providers. Later batches add entries here. */
export const providers: Provider[] = [
  ekinoTv,
  obejrzyjTo,
  zaluknij,
  cda,
  filman,
  bajeczki24,
  premiumsmart,
  serialeVip,
  maxvod,
  virpe,
  freedisc,
  cdaHd,
  telekino,
  vider,
  iitv,
  dokumentalne,
  mm35,
];
