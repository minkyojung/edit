/**
 * Thin adapter for proof-sdk's mark plugins.
 *
 * Why this exists:
 *   - proof-sdk publishes its plugin array as `[Attr, $markSchema-tuple,
 *     Attr, $markSchema-tuple, ...]`. Milkdown's `.use()` expects a flat
 *     `MilkdownPlugin[]`. proof-sdk's own editor builds compile under a
 *     looser tsconfig where the mixed array shape passes; under our
 *     strict config the tuple objects don't satisfy MilkdownPlugin
 *     directly.
 *   - proof-sdk's internal `serializeProofMark` helper also has a few
 *     loose-typed signatures (the SerializerState shape doesn't line up
 *     with @milkdown/transformer's strict types). Those checks live in
 *     proof-sdk source, not our code path.
 *
 * The adapter:
 *   1. Imports the canonical mark plugin objects from proof-sdk so the
 *      schema (proofSuggestion's 17 attrs, etc.) is identical to the
 *      server's. No more drift.
 *   2. Flattens + casts to MilkdownPlugin[] so Editor.use() accepts it.
 *
 * If proof-sdk tightens its own types or exposes a pre-flattened
 * plugin export, this file becomes a one-line re-export.
 */

import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { proofMarkPlugins as proofSdkMarkPlugins } from '@proof-sdk/editor/schema/proof-marks'

export const proofMarkPlugins: MilkdownPlugin[] = (
  proofSdkMarkPlugins as unknown as MilkdownPlugin[]
).flat()
