import type { Provider } from '../types.js';
import { ekinoTv } from './ekino-tv.js';
import { obejrzyjTo } from './obejrzyj-to.js';
import { zaluknij } from './zaluknij.js';

/** All enabled providers (batch 1). Later batches add entries here. */
export const providers: Provider[] = [ekinoTv, obejrzyjTo, zaluknij];
