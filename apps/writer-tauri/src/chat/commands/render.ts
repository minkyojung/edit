// Substitutes the document/selection/args slots in a command's body to
// produce the final system prompt sent to the model.
//
// Slot syntax: `{{document}}`, `{{selection}}`, `$ARGUMENTS`. We support
// $ARGUMENTS in addition to {{args}} because Claude Code's command
// standard uses that spelling — keeping compatibility makes user-authored
// .md files portable.

import type { CommandRenderContext, LoadedCommand } from './types'

export class CommandRenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandRenderError'
  }
}

export function renderBody(cmd: LoadedCommand, ctx: CommandRenderContext): string {
  if (cmd.scope === 'selection' && !ctx.selection.trim()) {
    throw new CommandRenderError(
      `/${cmd.name} needs a text selection. Highlight some text first.`,
    )
  }
  return cmd.body
    .replaceAll('{{document}}', ctx.document)
    .replaceAll('{{selection}}', ctx.selection)
    .replaceAll('{{args}}', ctx.args)
    .replaceAll('$ARGUMENTS', ctx.args)
}
