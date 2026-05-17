/**
 * Shared shape for Stage 2 external-edit fixtures.
 *
 * Each fixture pairs an `original` SerializerInput (text + marks as the
 * editor saw them) with an `edited` string (the .md file after an external
 * tool or human typed on it directly). The deserializer reads the edited
 * text + the sidecar produced from the original — that's the lifecycle this
 * stage validates.
 *
 * `expectations` is one row per mark, asserting the resolution status (and
 * optionally the substring the resolved range should cover). Keeping it
 * declarative means tests can iterate the fixture set uniformly instead of
 * a bespoke assertion block per scenario.
 */

import type { SerializerInput } from '../serializer.js'
import type { ResolutionStatus } from '../types.js'

export interface MarkExpectation {
  markId: string
  /** Required status. Tests assert resolved mark matches this exactly. */
  expectedStatus: ResolutionStatus
  /**
   * For `confident`: resolved range must equal this substring exactly.
   * For `degraded`:  resolved range's text must have similarity ≥ threshold
   *                  vs this substring (or vs original quote — tests check both).
   * For `orphaned`:  ignored (range is null).
   */
  expectedRangeText?: string
}

export interface ExternalEditFixture {
  name: string
  description: string
  original: SerializerInput
  edited: string
  expectations: MarkExpectation[]
}
