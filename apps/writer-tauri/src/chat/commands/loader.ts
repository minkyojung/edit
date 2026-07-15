// Parses a slash command's markdown source into LoadedCommand.
//
// We keep the parser tiny and dependency-free: frontmatter is a flat
// `key: value` block delimited by `---`, with two extras:
//   - quoted strings ("hint with: colons")
//   - flow-style arrays ([propose_edit, propose_comment])
// Anything more exotic (nested objects, multiline) is rejected — built-in
// .md files are written by us and don't need YAML's full surface.
//
// Frontmatter is OPTIONAL, following the Claude Code slash-command convention
// so `.claude/commands/*.md` files import as-is: when it's absent, `name` comes
// from the filename and `description` from the first body line. A present-but-
// malformed frontmatter block, or an invalid field value, is still a loud
// load-time error — we relax the *required*-ness, not the validation.

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
    fm = parseFrontmatter(m[1], source)
    body = m[2] ?? ''
  } else if (/^---\r?\n/.test(raw)) {
    // Opened a frontmatter block but never closed it — a real mistake, not a
    // body-only file. Fail loudly rather than swallow the `---` into the body.
    throw new CommandParseError(source, 'malformed frontmatter (opening --- without a closing ---)')
  }

  // Name: frontmatter `name` wins (back-compat); otherwise the filename stem,
  // matching Claude Code where the filename IS the command name.
  const fileStem = source.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? ''
  const name = optionalString(fm, 'name', source) ?? fileStem
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CommandParseError(source, `name "${name}" must be lowercase kebab-case`)
  }

  // Description: frontmatter `description`, else the first non-empty body line
  // (Claude Code's fallback), else the name so it is never empty.
  const description =
    optionalString(fm, 'description', source) ?? firstBodyLine(body) ?? name

  const kindRaw = (fm.kind as string | undefined) ?? 'chat-message'
  if (!KIND_IDS.includes(kindRaw as CommandKindId)) {
    throw new CommandParseError(source, `unknown kind "${kindRaw}"`)
  }
  const kind = kindRaw as CommandKindId

  const model = optionalEnum(fm, 'model', CHAT_MODELS, source) as ChatModel | undefined
  const effort = optionalEnum(fm, 'effort', CHAT_EFFORTS, source) as ChatEffort | undefined

  const scope = (optionalEnum(fm, 'scope', SCOPES, source) as CommandScope | undefined) ?? 'none'

  const argumentHint = optionalString(fm, 'argument-hint', source)

  return { name, description, kind, model, effort, argumentHint, scope, body }
}

// --- internals ---------------------------------------------------------

type FmValue = string | string[]
type FmObject = Record<string, FmValue>

function parseFrontmatter(text: string, source: string): FmObject {
  const out: FmObject = {}
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new CommandParseError(source, `frontmatter line missing ':' → "${line}"`)
    }
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1).trim()
    out[key] = parseValue(rest, source, key)
  }
  return out
}

function parseValue(raw: string, source: string, key: string): FmValue {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map((s) => unquote(s.trim(), source, key))
  }
  return unquote(raw, source, key)
}

function unquote(raw: string, source: string, key: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1)
  }
  if (raw.includes(':')) {
    throw new CommandParseError(
      source,
      `value for "${key}" contains ':' — quote it ("${raw}")`,
    )
  }
  return raw
}

/** First non-empty body line, stripped of a leading markdown heading marker —
 * Claude Code's default command description when frontmatter omits one. */
function firstBodyLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim().replace(/^#+\s*/, '')
    if (t) return t
  }
  return undefined
}

function optionalString(fm: FmObject, key: string, source: string): string | undefined {
  const v = fm[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new CommandParseError(source, `field "${key}" must be a string`)
  }
  return v
}

function optionalEnum<T extends string>(
  fm: FmObject,
  key: string,
  allowed: readonly T[],
  source: string,
): T | undefined {
  const v = fm[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new CommandParseError(source, `field "${key}" must be a string`)
  }
  if (!allowed.includes(v as T)) {
    throw new CommandParseError(
      source,
      `field "${key}" must be one of [${allowed.join(', ')}], got "${v}"`,
    )
  }
  return v as T
}
