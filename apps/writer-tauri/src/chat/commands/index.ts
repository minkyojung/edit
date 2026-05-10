// Builds the in-memory registry of built-in commands by glob-importing
// every .md file under ./builtin/ as a raw string at build time.
//
// User-authored commands (loaded later from a user data dir at run time)
// will go through the same parseCommand() entrypoint and merge into the
// same map — for now there's only the built-in set.

import { CommandParseError, parseCommand } from './loader'
import type { LoadedCommand } from './types'

// Vite glob import: pulls every .md under builtin/ into the bundle as
// raw text. `eager` so we don't pay an async cost on first slash.
const RAW = import.meta.glob('./builtin/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const COMMANDS = new Map<string, LoadedCommand>()

for (const [path, raw] of Object.entries(RAW)) {
  try {
    const cmd = parseCommand(raw, path)
    if (COMMANDS.has(cmd.name)) {
      console.warn(`[commands] duplicate name "${cmd.name}" — ${path} ignored`)
      continue
    }
    COMMANDS.set(cmd.name, cmd)
  } catch (err) {
    if (err instanceof CommandParseError) {
      console.error(`[commands] failed to load ${path}:`, err.message)
    } else {
      throw err
    }
  }
}

/** All loaded commands, in the order they appeared in the bundle. */
export function listCommands(): LoadedCommand[] {
  return Array.from(COMMANDS.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Look up a command by its slash name (no leading `/`). */
export function getCommand(name: string): LoadedCommand | undefined {
  return COMMANDS.get(name)
}

export { renderBody, CommandRenderError } from './render'
export { resolveKind, KINDS } from './registry'
export type {
  LoadedCommand,
  CommandKind,
  CommandKindId,
  CommandScope,
  CommandRenderContext,
} from './types'
