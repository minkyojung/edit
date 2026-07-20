// Parses a slash command's markdown source into LoadedCommand.
//
// Frontmatter values are read through the shared YAML parser
// (`parseFrontmatterBlock`); this file owns only the command-specific
// concerns on top of it: detecting an unclosed block and validating each
// field. The consumed fields (name, description, kind, model, effort, scope,
// argument-hint) are all scalars, so the flat string view is exactly right.
//
// Frontmatter is OPTIONAL, following the Claude Code slash-command convention
// so `.claude/commands/*.md` files import as-is: when it's absent, `name` comes
// from the filename and `description` from the first body line. A present-but-
// unclosed frontmatter block, or an invalid field value, is still a loud
// load-time error — we relax the *required*-ness, not the validation.

import { parseFrontmatterBlock } from '@/lib/frontmatter'
import {
  type CommandKindId,
  type CommandScope,
  type LoadedCommand,
} from './types'
import { CHAT_EFFORTS, CHAT_MODELS, type ChatEffort, type ChatModel } from '@/chat/types'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

const KIND_IDS: readonly CommandKindId[] = [
  'chat-message',
  'document-edit',
  'review-comments',
] as const

const SCOPES: readonly CommandScope[] = ['document', 'selection', 'none'] as const

export class CommandParseError extends Error {
  constructor(public readonly source: string, message: string) {
    super(`[${source}] ${message}`)
    this.name = 'CommandParseError'
  }
}

/** Parses a full .md document. `source` is the file path — used both to derive
 * the command name (filename stem) when frontmatter omits it, and as a label in
 * error messages so failures point at the offending file. */
export function parseCommand(raw: string, source: string): LoadedCommand {
  const m = FRONTMATTER_RE.exec(raw)
  let fm: FmObject = {}
  let body = raw
  if (m) {
    fm = parseFrontmatterBlock(m[1])
    body = m[2] ?? ''
  } else if (/^---\r?\n/.test(raw)) {
    // Opened a frontmatter block but never closed it — a real mistake, not a
    // body-only file. Fail loudly rather than swallow the `---` into the body.
    throw new CommandParseError(source, 'malformed frontmatter (opening --- without a closing ---)')
  }

  // Name: frontmatter `name` wins (back-compat); otherwise the filename stem,
  // matching Claude Code where the filename IS the command name.
  const fileStem = source.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? ''
  const name = optionalString(fm, 'name') ?? fileStem
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CommandParseError(source, `name "${name}" must be lowercase kebab-case`)
  }

  // Description: frontmatter `description`, else the first non-empty body line
  // (Claude Code's fallback), else the name so it is never empty.
  const description =
    optionalString(fm, 'description') ?? firstBodyLine(body) ?? name

  const kindRaw = (fm.kind as string | undefined) ?? 'chat-message'
  if (!KIND_IDS.includes(kindRaw as CommandKindId)) {
    throw new CommandParseError(source, `unknown kind "${kindRaw}"`)
  }
  const kind = kindRaw as CommandKindId

  const model = optionalEnum(fm, 'model', CHAT_MODELS, source) as ChatModel | undefined
  const effort = optionalEnum(fm, 'effort', CHAT_EFFORTS, source) as ChatEffort | undefined

  const scope = (optionalEnum(fm, 'scope', SCOPES, source) as CommandScope | undefined) ?? 'none'

  const argumentHint = optionalString(fm, 'argument-hint')

  return { name, description, kind, model, effort, argumentHint, scope, body }
}

// --- internals ---------------------------------------------------------

type FmObject = Record<string, string>

/** First non-empty body line, stripped of a leading markdown heading marker —
 * Claude Code's default command description when frontmatter omits one. */
function firstBodyLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/^#+\s*/, '')
    if (t) return t
  }
  return undefined
}

function optionalString(fm: FmObject, key: string): string | undefined {
  return fm[key]
}

function optionalEnum<T extends string>(
  fm: FmObject,
  key: string,
  allowed: readonly T[],
  source: string,
): T | undefined {
  const v = fm[key]
  if (v === undefined) return undefined
  if (!allowed.includes(v as T)) {
    throw new CommandParseError(
      source,
      `field "${key}" must be one of [${allowed.join(', ')}], got "${v}"`,
    )
  }
  return v as T
}
