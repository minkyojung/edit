// U12 Layer A — the role-indirection verification.
//
// U11 moved the knowledge-base + capture folders out of hard-coded paths
// into user settings that are injected into the system prompt every turn.
// This pins the contract the settings depend on: whatever folder the user
// configures actually reaches the model in its instructions, and changing
// the setting changes the instruction. (Whether the model then OBEYS is
// Layer B — observed in dogfood, not assertable here.)

import { describe, expect, it } from 'vitest'
import {
  attachedFilesBlock,
  composeSystemBlocks,
  currentNoteBlock,
  referencedFilesBlock,
  selectionBlock,
  viewingFileBlock,
  type SystemBlocksArgs,
} from './systemPrompt'

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

// Per-turn file context (the open note, attachments, @-mentions) must NOT live
// in the system prompt: a persistent thread freezes its system prompt at the
// first turn, so anything added on a later turn would never reach the model
// there. They ride the USER message via the block helpers below. These tests
// pin that channel so a future refactor can't quietly move them back into the
// frozen system prompt.
describe('per-turn file context rides the user message, not the system prompt', () => {
  it('composeSystemBlocks never emits ATTACHED / REFERENCED file blocks', () => {
    const out = text(composeSystemBlocks(args({ vaultRoot: '/v', appendDocument: false })))
    expect(out).not.toContain('--- ATTACHED FILES ---')
    expect(out).not.toContain('--- REFERENCED FILES ---')
  })

  // Once the note went per-turn, a frozen VIEWING FILE block would contradict
  // it outright — both answer "where is the user" and the model can't tell
  // which is stale.
  it('composeSystemBlocks never emits the VIEWING FILE block', () => {
    const out = text(composeSystemBlocks(args({ vaultRoot: '/v' })))
    expect(out).not.toContain('--- VIEWING FILE ---')
  })

  // A selection changes on every drag, so a frozen one is wrong even more
  // often than a frozen note was.
  it('composeSystemBlocks never emits the SELECTION block', () => {
    const out = text(composeSystemBlocks(args({ vaultRoot: '/v' })))
    expect(out).not.toContain('--- SELECTION ---')
  })

  // The regression this whole change exists to prevent: the open note used to
  // ride the (frozen) system prompt, so a thread started on note A kept telling
  // the model "the current note is A" forever — even after the user moved to B.
  it('composeSystemBlocks never names the open note', () => {
    const out = text(
      composeSystemBlocks(
        args({ vaultRoot: '/v', appendDocument: true, docForPrompt: 'BODY' }),
      ),
    )
    expect(out).not.toContain('--- CURRENT NOTE ---')
    expect(out).not.toContain('--- CURRENT FILE ---')
  })

  it('attachedFilesBlock renders the paths and Read instruction; empty → ""', () => {
    expect(attachedFilesBlock([])).toBe('')
    const block = attachedFilesBlock(['.octave/attachments/abc/report.pdf'])
    expect(block).toContain('--- ATTACHED FILES ---')
    expect(block).toContain('`.octave/attachments/abc/report.pdf`')
    expect(block).toContain('Read')
  })

  it('referencedFilesBlock inlines a present body and tells the model to Read an absent one', () => {
    expect(referencedFilesBlock([])).toBe('')
    const inlined = referencedFilesBlock([{ path: 'wiki/A.md', body: 'BODY_TEXT' }])
    expect(inlined).toContain('--- REFERENCED FILES ---')
    expect(inlined).toContain('BODY_TEXT')
    const readIt = referencedFilesBlock([{ path: 'wiki/B.md' }])
    expect(readIt).toContain('`wiki/B.md` — Read this exact path')
  })
})

describe('currentNoteBlock', () => {
  it('names the note on every turn, with or without a body', () => {
    const withBody = currentNoteBlock('wiki/A.md', 'BODY_TEXT')
    expect(withBody).toContain('--- CURRENT NOTE ---')
    expect(withBody).toContain('`wiki/A.md`')
    expect(withBody).toContain('BODY_TEXT')

    const pathOnly = currentNoteBlock('wiki/A.md')
    expect(pathOnly).toContain('--- CURRENT NOTE ---')
    expect(pathOnly).toContain('`wiki/A.md`')
    expect(pathOnly).not.toContain('BODY_TEXT')
  })

  // Two different reasons the body can be absent, and claiming the wrong one
  // either sends the model to re-Read what it has, or lets it answer about a
  // note whose text it was never given.
  it('says the body is unchanged only when it really was sent earlier', () => {
    expect(currentNoteBlock('wiki/A.md', undefined, true)).toContain('has not changed')
  })

  it('claims nothing about content when the body rode another channel', () => {
    // e.g. a slash command that rendered {{document}} into its own prompt.
    const block = currentNoteBlock('wiki/A.md', undefined, false)
    expect(block).toContain('`wiki/A.md`')
    expect(block).not.toContain('has not changed')
    expect(block).not.toContain('content')
  })

  // A session is append-only: earlier turns' blocks stay in the history naming
  // whatever note was open THEN. Since we can't retract them, each block has to
  // date itself and claim precedence, or the model sees N competing
  // present-tense claims about which note is current.
  it('dates itself and supersedes earlier copies', () => {
    const block = currentNoteBlock('wiki/A.md', 'BODY')
    expect(block).toContain('As of this message')
    expect(block).toContain('out of date')
    expect(block).toContain('stale')
  })

  // Riding the user message means the text is subject to prompt-injection
  // defenses: imperative, out-of-band-sounding instructions can get surfaced to
  // the user instead of acted on. Keep it stating facts.
  it('reads as statements, not as commands to the model', () => {
    const block = currentNoteBlock('wiki/A.md', 'BODY')
    expect(block).not.toMatch(/\bYou (must|should|will)\b/)
    expect(block).not.toMatch(/\btarget it\b/i)
  })

  it('returns "" for an empty path', () => {
    expect(currentNoteBlock('')).toBe('')
  })
})

describe('viewingFileBlock', () => {
  it('names the file every turn', () => {
    const block = viewingFileBlock('papers/paper.pdf')
    expect(block).toContain('--- VIEWING FILE ---')
    expect(block).toContain('`papers/paper.pdf`')
  })

  it('dates itself and supersedes an earlier file OR note', () => {
    const block = viewingFileBlock('papers/paper.pdf')
    expect(block).toContain('As of this message')
    expect(block).toContain('out of date')
    // Must supersede a stale CURRENT NOTE too, not just an older file — the two
    // blocks both answer "where is the user", so whichever is older has to lose.
    expect(block).toMatch(/file or note/i)
  })

  it('reads as statements, not as commands to the model', () => {
    const block = viewingFileBlock('papers/paper.pdf')
    expect(block).not.toMatch(/\bYou (must|should|will)\b/)
    expect(block).not.toMatch(/\bUse the Read tool\b/)
    expect(block).not.toMatch(/\bdon't try to edit\b/i)
  })

  it('still tells the model the contents are absent and readable', () => {
    const block = viewingFileBlock('papers/paper.pdf')
    expect(block).toContain('not included here')
    expect(block).toContain('Read')
  })

  it('returns "" when no file is open', () => {
    expect(viewingFileBlock(null)).toBe('')
    expect(viewingFileBlock(undefined)).toBe('')
    expect(viewingFileBlock('')).toBe('')
  })
})

describe('selectionBlock', () => {
  it('sends the selected text verbatim', () => {
    const block = selectionBlock('the quick brown fox')
    expect(block).toContain('--- SELECTION ---')
    expect(block).toContain('the quick brown fox')
  })

  // Same append-only problem as the note: a selection from turn 1 is still
  // sitting in the history when the user drags a new one on turn 6.
  it('dates itself and supersedes earlier selections', () => {
    const block = selectionBlock('passage')
    expect(block).toContain('As of this message')
    expect(block).toContain('out of date')
  })

  it('reads as statements, not as commands to the model', () => {
    const block = selectionBlock('passage')
    expect(block).not.toMatch(/\bYou (must|should|will)\b/)
    expect(block).not.toMatch(/\bfocus on it\b/i)
  })

  // It used to promise "the full document follows for context" — true only
  // while the doc rode the system prompt right behind it. For an open note it
  // no longer does, so the block must not claim otherwise.
  it('does not promise that the document follows', () => {
    expect(selectionBlock('passage')).not.toContain('follows for context')
  })

  it('returns "" for empty or whitespace-only selections', () => {
    expect(selectionBlock(null)).toBe('')
    expect(selectionBlock(undefined)).toBe('')
    expect(selectionBlock('')).toBe('')
    expect(selectionBlock('   \n  ')).toBe('')
  })
})
