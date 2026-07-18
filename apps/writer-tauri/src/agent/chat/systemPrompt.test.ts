// U12 Layer A — the role-indirection verification.
//
// U11 moved the knowledge-base + capture folders out of hard-coded paths
// into user settings that are injected into the system prompt every turn.
// This pins the contract the settings depend on: whatever folder the user
// configures actually reaches the model in its instructions, and changing
// the setting changes the instruction. (Whether the model then OBEYS is
// Layer B — observed in dogfood, not assertable here.)

import { describe, expect, it } from 'vitest'
import { composeSystemBlocks, type SystemBlocksArgs } from './systemPrompt'

/** Minimal valid args → a stable cacheable-prefix-only prompt (no
 * dynamic suffix, so no boundary sentinel). Override per test. */
function args(overrides: Partial<SystemBlocksArgs> = {}): SystemBlocksArgs {
  return {
    docForPrompt: '',
    systemBody: 'PERSONA',
    ctx: { selfProfile: '', claudeMd: '', preferences: '' },
    appendDocument: false,
    ...overrides,
  }
}

/** Flatten the string | string[] result for substring assertions. */
function text(result: string | string[]): string {
  return Array.isArray(result) ? result.join('\n\n') : result
}

describe('composeSystemBlocks — role folders reach the prompt', () => {
  it('injects the configured knowledge-base and capture folders', () => {
    const out = text(
      composeSystemBlocks(args({ knowledgeBaseFolder: 'wiki', captureFolder: 'inbox' })),
    )
    expect(out).toContain('--- KNOWLEDGE BASE ---')
    expect(out).toContain('The knowledge base is `wiki/`')
    expect(out).toContain('--- CAPTURE FOLDER ---')
    expect(out).toContain('The capture folder is `inbox/`')
  })

  it('changes the instruction when the setting changes', () => {
    const out = text(
      composeSystemBlocks(
        args({ knowledgeBaseFolder: 'notes', captureFolder: 'clippings' }),
      ),
    )
    expect(out).toContain('The knowledge base is `notes/`')
    expect(out).toContain('The capture folder is `clippings/`')
    // The old default must NOT leak through once the user re-points it.
    expect(out).not.toContain('The knowledge base is `wiki/`')
  })

  it('tells the model the setting is authoritative over the CLAUDE.md schema', () => {
    const out = text(composeSystemBlocks(args({ knowledgeBaseFolder: 'notes' })))
    expect(out).toContain('THIS setting wins')
  })

  it('omits the knowledge-base block when no folder is configured', () => {
    const out = text(composeSystemBlocks(args({ knowledgeBaseFolder: null })))
    expect(out).not.toContain('--- KNOWLEDGE BASE ---')
  })
})

// Cache-stability contract: the per-user GROWING blocks (self-profile,
// preferences — the compound loop appends to these) must sit AFTER the
// app/vault-static blocks in the cacheable prefix, so an append only
// invalidates the small trailer, not the large static core. See the ordering
// note in composeSystemBlocks.
describe('composeSystemBlocks — growing blocks ordered last (cache stability)', () => {
  it('places SELF PROFILE / PREFERENCES after the static CLAUDE.md + folder blocks', () => {
    const result = composeSystemBlocks(
      args({
        ctx: { selfProfile: 'PROFILE_FACTS', claudeMd: 'CLAUDE_SCHEMA', preferences: 'PREFS' },
        knowledgeBaseFolder: 'wiki',
        captureFolder: 'inbox',
        vaultRoot: '/v',
      }),
    )
    const blocks = Array.isArray(result) ? result : [result]
    const idx = (needle: string) => blocks.findIndex((b) => b.includes(needle))

    // Every static block must precede the first growing block.
    expect(idx('CLAUDE_SCHEMA')).toBeGreaterThanOrEqual(0)
    expect(idx('CLAUDE_SCHEMA')).toBeLessThan(idx('--- SELF PROFILE ---'))
    expect(idx('--- KNOWLEDGE BASE ---')).toBeLessThan(idx('--- SELF PROFILE ---'))
    expect(idx('--- CAPTURE FOLDER ---')).toBeLessThan(idx('--- SELF PROFILE ---'))
    // Persona stays first of all.
    expect(idx('PERSONA')).toBe(0)
  })
})
