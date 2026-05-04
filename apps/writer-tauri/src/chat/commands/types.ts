// Slash command type system.
//
// A slash command is loaded from a markdown file (frontmatter + body).
// The frontmatter declares SDK options (model, effort, ...) and a `kind`
// pointing to one of the renderers in ./kinds. The body is the system
// prompt, with `{{document}}` / `{{selection}}` / `$ARGUMENTS` slots that
// the loader substitutes at execution time.
//
// Built-in commands ship as bundled .md resources; user-defined commands
// can be added later from a user data dir (same shape, same loader).

import type { ChatEffort, ChatModel } from '@/chat/types'

/** The three output shapes the app currently understands. New shapes need
 * a registry entry (UI + tools); user .md files can only reference the
 * ones the app provides. */
export type CommandKindId = 'chat-message' | 'document-edit' | 'review-comments'

/** Where the command pulls source text from when substituting variables.
 * `none` skips substitution entirely; `selection` errors out cleanly when
 * nothing is selected (no silent fallback to document — intent unclear). */
export type CommandScope = 'document' | 'selection' | 'none'

/** Parsed + validated command definition straight from the .md file. The
 * body is still raw — variable substitution happens at run time so the
 * latest document/selection is captured. */
export interface LoadedCommand {
  /** Slash name (no leading `/`). Lowercase, kebab-case. */
  name: string
  /** Shown in the palette; surface to LLM later if we add skills. */
  description: string
  kind: CommandKindId
  model?: ChatModel
  effort?: ChatEffort
  /** Hint shown in the palette/input as placeholder text. */
  argumentHint?: string
  scope: CommandScope
  /** Raw markdown body — pre-substitution. */
  body: string
}

/** Run-time context passed to render() — captures the editor state at
 * the moment the command fired. */
export interface CommandRenderContext {
  document: string
  selection: string
  args: string
}

/** A kind owns the contract: which relay tools it activates and how the
 * tool calls / final text get rendered in the chat panel. The actual
 * render component lives in the chat panel; this registry entry just
 * declares the metadata. */
export interface CommandKind {
  id: CommandKindId
  /** Relay tools the sidecar should expose for commands of this kind. */
  relayTools: string[]
}
