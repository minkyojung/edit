/**
 * Barrel for Stage 2 fixtures. Tests iterate `externalEditFixtures` so
 * adding a new fixture is a one-line edit here.
 */

export { externalEditParaphrase } from './external-edit-paraphrase.js'
export { externalEditPrefixAdded } from './external-edit-prefix-added.js'
export { externalEditRewritten } from './external-edit-rewritten.js'
export { externalEditTypoFix } from './external-edit-typo-fix.js'
export { externalEditUnrelatedLine } from './external-edit-unrelated-line.js'

import { externalEditParaphrase } from './external-edit-paraphrase.js'
import { externalEditPrefixAdded } from './external-edit-prefix-added.js'
import { externalEditRewritten } from './external-edit-rewritten.js'
import { externalEditTypoFix } from './external-edit-typo-fix.js'
import { externalEditUnrelatedLine } from './external-edit-unrelated-line.js'

export const externalEditFixtures = [
  externalEditUnrelatedLine,
  externalEditPrefixAdded,
  externalEditTypoFix,
  externalEditParaphrase,
  externalEditRewritten,
]
