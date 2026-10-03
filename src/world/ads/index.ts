// ============================================================
//  ALL THE ADS - one list, in a fixed order
// ------------------------------------------------------------
//  The wide ads, then the tall ones, then the squares. An ad's
//  place in this list is its number everywhere else (the atlas
//  cell it is painted into, the plan that puts it on a billboard).
// ============================================================

import type { AdDef } from './adKit'
import { SQUARE_ADS } from './square'
import { TALL_ADS } from './tall'
import { WIDE_ADS } from './wide'

export const ALL_ADS: readonly AdDef[] = [...WIDE_ADS, ...TALL_ADS, ...SQUARE_ADS]
