import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SKILLS,
  DEFAULT_COMMANDS,
  DEFAULT_AGENTS,
  DEFAULT_CLAUDE_MD,
} from './index'

// Guards the bundled-defaults loader: the `.md` files are globbed + parsed at
// build time, so these assert the content downstream seeders depend on.
describe('bundled defaults', () => {
  it('loads the undo skill with its (ai) grep', () => {
    const undo = DEFAULT_SKILLS.find((s) => s.name === 'undo-ai-change')
    expect(undo).toBeDefined()
    expect(undo!.description).toContain('Reverse')
    expect(undo!.body).toContain("git log --grep='(ai):'")
  })

  it('ships only the organize routine (chat-to-wiki / daily-ingest are now inline brains)', () => {
    expect(DEFAULT_COMMANDS.map((c) => c.name)).toEqual(['organize'])
    const organize = DEFAULT_COMMANDS.find((c) => c.name === 'organize')!
    expect(organize.body).toContain('$ARGUMENTS')
    // Role-based now (no wiki/daily hardcoding; time axis is the system timeline)
    expect(organize.body).toContain('knowledge base')
    expect(organize.body).not.toContain('daily/')
  })

  it('ships only the default agent role (starter roles removed)', () => {
    expect(DEFAULT_AGENTS.map((a) => a.name)).toEqual(['default'])
  })

  it('loads CLAUDE.md with the Preferences section inlined', () => {
    expect(DEFAULT_CLAUDE_MD).toContain('# Wiki Maintainer')
    expect(DEFAULT_CLAUDE_MD).toContain('## Preferences')
    expect(DEFAULT_CLAUDE_MD).not.toContain('PREFERENCES_SECTION')
  })

  it('CLAUDE.md now owns the proactive-memory + undo nudges (moved off the persona)', () => {
    expect(DEFAULT_CLAUDE_MD).toContain('second brain')
    expect(DEFAULT_CLAUDE_MD).toContain('undo-ai-change')
    // the chat persona no longer restates them
    const persona = DEFAULT_AGENTS.find((a) => a.name === 'default')!.body
    expect(persona).not.toContain('second brain')
    expect(persona).not.toContain('undo-ai-change')
  })
})
