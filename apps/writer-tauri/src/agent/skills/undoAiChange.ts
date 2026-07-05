// Seed body for the `undo-ai-change` skill — the agent-driven "undo what you
// just did" procedure. Progressive disclosure: the always-on prompt only
// carries a one-line nudge (freeChat.ts); this full protocol loads only when
// the skill activates (the user regrets or asks to undo an AI change).
//
// Reuses existing rails, no new infra: every AI edit is already an `ai-edit:`
// git checkpoint, Bash/git is in the chat toolset, propose_edit routes through
// the review flow, and the vault watcher reloads reverted files.

export const UNDO_SKILL_DESCRIPTION =
  'Reverse a recent change YOU made to the vault — a chat edit, a wiki append, or an organize move — when the user regrets it or asks to undo/revert. NOT for reverting the user’s own writing.'

export const UNDO_SKILL_BODY = `Every change you apply is committed as an \`ai-edit:\` checkpoint, so undoing one is a targeted git revert — never a blunt reset, and never touching the user's own commits.

1. **Find the checkpoint.** Run \`git log --grep='ai-edit:' -n 10 --format='%h %ci %s'\`. Pick the one the user means: the most recent by default, or match their words to a subject ("the organize", "what you added to [[Tom]]"). Confirm with \`git show <sha> --stat\` before touching anything.

2. **Show, don't surprise.** In one or two plain sentences, say what undoing restores ("This removes the three lines I appended to [[Tom]] and the link I created"). Never dump a raw diff at the user.

3. **Clean revert.** If the user hasn't touched those lines since, \`git revert --no-edit <sha>\`. It's non-destructive — it records a new inverse commit, so the undo is itself undoable, and the editor reloads the file automatically.

4. **Overlap — reconcile, don't clobber.** If the user edited the same place after your change (a plain \`git revert\` would conflict), do NOT leave conflict markers in their note and do NOT mechanically strip just your lines — that can leave the passage reading oddly. Instead: \`git revert --abort\` to restore the clean state, then READ the current text, work out what it should read like with your change removed but the user's edit kept, and propose_edit that smoothly-reconciled version for them to review. Let them decide; never overwrite their words.

5. **Confirm** what you undid, in one line.

Guardrails: only ever revert \`ai-edit:\` commits; one checkpoint at a time; if you can't clearly tell which change the user means, ask before reverting anything.`
