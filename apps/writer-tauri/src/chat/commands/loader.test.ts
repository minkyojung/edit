import { describe, it, expect } from 'vitest'
import { parseCommand, CommandParseError } from './loader'

describe('parseCommand — Claude Code slash-command convention', () => {
  it('imports a body-only file: name from filename, description from first line', () => {
    const cmd = parseCommand('review the code for security problems.\n\nBe specific.', '~/.claude/commands/review.md')
    expect(cmd.name).toBe('review')
    expect(cmd.description).toBe('review the code for security problems.')
    expect(cmd.kind).toBe('chat-message')
    expect(cmd.scope).toBe('none')
    expect(cmd.body).toContain('Be specific.')
  })

  it('strips a leading markdown heading when falling back to the first line', () => {
    const cmd = parseCommand('# Summarize\n\ndo the thing', './builtin/summarize.md')
    expect(cmd.description).toBe('Summarize')
  })

  it('frontmatter still wins for name and description (back-compat)', () => {
    const raw = '---\nname: my-cmd\ndescription: does a thing\nscope: selection\n---\n\nbody'
    const cmd = parseCommand(raw, './builtin/ignored-filename.md')
    expect(cmd.name).toBe('my-cmd')
    expect(cmd.description).toBe('does a thing')
    expect(cmd.scope).toBe('selection')
  })

  it('still fails loudly on an unclosed frontmatter block', () => {
    expect(() => parseCommand('---\nname: broken\n\nbody with no closing fence', 'x.md')).toThrow(
      CommandParseError,
    )
  })

  it('still validates a filename-derived name as kebab-case', () => {
    expect(() => parseCommand('body', './builtin/BadName.md')).toThrow(CommandParseError)
  })

  it('still rejects an invalid enum value loudly', () => {
    const raw = '---\nname: c\nscope: sideways\n---\n\nbody'
    expect(() => parseCommand(raw, 'c.md')).toThrow(CommandParseError)
  })

  it('reads a quoted value that contains a colon', () => {
    const raw = "---\nname: c\nargument-hint: 'format: <lang>'\n---\n\nbody"
    expect(parseCommand(raw, 'c.md').argumentHint).toBe('format: <lang>')
  })

  it('tolerates an unquoted value with a mid-word colon (YAML-valid)', () => {
    // The shared parser accepts `path:thing` (no space after the colon) where
    // the old hand parser demanded quoting; a valid scalar is read as-is.
    const raw = '---\nname: c\nargument-hint: path/to:thing\n---\n\nbody'
    expect(parseCommand(raw, 'c.md').argumentHint).toBe('path/to:thing')
  })
})
