// Adapter from a sidecar `chat/edit-pending` payload to the unified
// `pendingChangesStore` shape. The payload arrives whenever the
// sidecar's host-applies MCP tools (`propose_edit` / `propose_write`
// / `propose_multi_edit`) run; the LLM already saw the tool succeed
// (those tools return immediately) and our job is just to queue the
// proposal so the inline review widget on the target page can show
// the diff + Keep/Reject.
//
// Returns null when the mapping can't succeed (unknown tool, file
// path that doesn't resolve to a doc in the catalog). The chat
// listener logs the miss; no decision surface is wired up for
// unmappable proposals, so the LLM's "queued" answer becomes a no-op
// on the host side. Falls into the "rare edge case" bucket — the
// vast majority of LLM Edit/Write calls target catalog docs.
//
// One mapping miss IS recoverable: a `propose_write` to a wiki path
// that doesn't exist yet (the model is creating a brand-new page).
// `materializeChatNewWikiPage` handles that — it creates the page (so
// it gets a real slug) and returns a PendingChange staging the body,
// mirroring ingest's `materializeNewPageProposals`. The chat listener
// falls through to it when the pure mapper returns null.

import type { PendingChange, PendingEdit } from '@/state/pendingChangesStore'
import type { KnownDoc } from '@/state/docsStore'
import { pathForDoc } from '@/lib/docPaths'
import { createCustomWikiPage, createGenericNote } from '@/state/wikiService'
import { getDefaultNoteFolder } from '@/state/settingsStore'
import { stripDuplicateTitleHeading } from '@/lib/markdownText'
import { splitFrontmatter } from '@/lib/frontmatter'
import { applyEditsToText } from '@/lib/pendingDiff'

export interface ChatEditPendingPayload {
  runId: string
  pendingId: string
  toolName: string
  input: Record<string, unknown>
}

interface MapContext {
  knownDocs: KnownDoc[]
  vaultPath: string | null
  /** Optional thread id for the chat run, surfaced in the Review
   * Panel later. Pass undefined when not available. */
  threadId?: string
  /** The user message that triggered this run. A chat edit has no
   * AI-supplied rationale, so this is its "why" in the Review panel —
   * "this change exists because you asked: …". Omitted when unknown
   * (e.g. one-shot prompts with no history). */
  userRequest?: string
}

/** Map a sidecar pending-edit payload into a PendingChange ready to
 * push into `pendingChangesStore`. Returns null when the mapping
 * fails — caller is expected to fall through to the legacy
 * PendingEditsBar path so the user still has a decision surface. */
export function mapChatEditToPendingChange(
  payload: ChatEditPendingPayload,
  ctx: MapContext,
): Omit<PendingChange, 'status' | 'decidedAt' | 'viewedAt'> | null {
  const filePath = readString(payload.input.file_path)
  if (!filePath) {
    console.warn('[map] miss: no file_path', { toolName: payload.toolName })
    return null
  }

  const slug = resolveSlugForVaultPath(filePath, ctx.knownDocs, ctx.vaultPath)
  if (!slug) {
    // For a brand-new `propose_write` this miss is EXPECTED — the caller falls through
    // to materializeChatNewWikiPage which creates the page. For `propose_edit` /
    // `propose_multi_edit` (toolName Edit/MultiEdit) there is NO such recovery, so a
    // miss here is the "create-then-edit in one turn" bug. Log the edit's file_path +
    // the catalog paths we matched against so a path MISMATCH (b) is distinguishable
    // from a NOT-YET-CREATED note (a).
    const getDoc = (s: string) => ctx.knownDocs.find((d) => d.slug === s)
    console.warn('[map] miss: slug unresolved', {
      toolName: payload.toolName,
      filePath,
      knownPaths: ctx.knownDocs
        .filter((d) => !d.archivedAt)
        .map((d) => pathForDoc(d, getDoc))
        .filter(Boolean),
    })
    return null
  }

  // System pages (system:log, system:index, system:conventions, ...)
  // are host-managed. We deterministically build their bodies — the
  // LLM has no business writing to them directly. If a chat
  // propose_write targets one, drop the proposal: the LLM's reply
  // already claimed "queued for user review" so nothing visible
  // breaks, and the host's own per-accept side-effects (e.g.
  // appendToSystemLog from the applier) keep the page up to date.
  const targetDoc = ctx.knownDocs.find((d) => d.slug === slug)
  if (targetDoc?.type.startsWith('system:')) {
    console.warn(
      '[toPendingChange] dropping LLM write to system page',
      filePath,
      'kind',
      targetDoc.type,
    )
    return null
  }

  const edits = buildEditsForTool(payload.toolName, payload.input)
  if (edits.length === 0) {
    console.warn('[map] miss: no edits built', {
      toolName: payload.toolName,
      inputKeys: Object.keys(payload.input),
    })
    return null
  }

  return {
    id: payload.pendingId,
    source: 'chat',
    pageSlug: slug,
    // One LLM run = one groupId so the user can later batch-reject
    // every staged edit from this turn. Distinct from `pendingId`
    // (per-tool-call) and `threadId` (per-conversation).
    groupId: payload.runId,
    createdAt: Date.now(),
    edits,
    // Model-supplied `reason` → recorded as the commit body on Keep.
    reason: readString(payload.input.reason).trim() || undefined,
    context: {
      threadId: ctx.threadId,
      runId: payload.runId,
      // Surface the triggering user request as the change's rationale
      // ("Why" in the Review panel). Chat edits have no other grounding;
      // this is what the user asked for, which is exactly the answer to
      // "why is this change here?". Trimmed empty → omitted.
      rationale: ctx.userRequest?.trim() || undefined,
    },
  }
}

/** Strip a leading YAML frontmatter block from AI-supplied whole-document
 * content, keeping body only. The model reads notes via the built-in Read
 * tool, which exposes the on-disk `---` block (slug/type/createdAt …), and
 * often echoes it back into `propose_write` content. Those fields would
 * otherwise render as literal body text AND get re-wrapped by the flush
 * writer (double frontmatter on disk). The metadata is dropped, not merged:
 * the catalog (`KnownDoc`) is the source of truth for slug/type, so an
 * echoed block is at best redundant and at worst a slug clobber.
 *
 * No-op when there's no `---` block (splitFrontmatter returns body === raw).
 * Apply ONLY to whole-document content (Write `content`, new-note body) —
 * never to an Edit's `old_string` / `new_string` fragment, which carries no
 * frontmatter and would be corrupted by a false match. */
function normalizeAiBody(raw: string): string {
  return splitFrontmatter(raw).body
}

/** The content to seed a brand-new file with, derived from whichever write-side
 * tool the model used. `Write` carries the whole body in `content`; `Edit` /
 * `MultiEdit` carry it in `new_string` (nothing to replace in a file that doesn't
 * exist yet, so the new text IS the body). '' for other tools.
 *
 * Frontmatter is stripped here (whole-document boundary) so an echoed `---`
 * block never reaches the staged body — see {@link normalizeAiBody}. */
function newFileContentFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Write') return normalizeAiBody(readString(input.content))
  if (toolName === 'Edit') return normalizeAiBody(readString(input.new_string))
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : []
    return edits
      .map((e) => readString((e as { new_string?: unknown }).new_string))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Create a brand-new note for a chat write-side tool whose target path doesn't
 * resolve to an existing doc, then return a PendingChange staging its body for review.
 *
 * Placement follows the FOLDER the model put in `file_path` (governed by CLAUDE.md):
 * a `wiki/` path becomes a real wiki page (so it shows in the index and `[[links]]`
 * resolve); any other folder is a generic note placed there; a bare filename falls back
 * to the configured default folder (settings `defaultNoteFolder`, default 'inbox'). The
 * note is born empty (so it exists in the catalog + sidebar and can host a staged
 * change); the body sits in the review queue until the user Keeps.
 *
 * (Function name is legacy — kept so the caller in agent/chat/index.ts is untouched.)
 *
 * Handles any write-side tool whose path doesn't resolve — `Write` (body in
 * `content`) and `Edit`/`MultiEdit` (body in `new_string`) — so an edit to a
 * not-yet-created file is staged, not dropped. Returns null when there's no usable
 * body, the path already resolves, or note creation fails. */
export async function materializeChatNewWikiPage(
  payload: ChatEditPendingPayload,
  ctx: MapContext,
): Promise<Omit<PendingChange, 'status' | 'decidedAt' | 'viewedAt'> | null> {
  const filePath = readString(payload.input.file_path)
  if (!filePath) return null
  const content = newFileContentFor(payload.toolName, payload.input)
  if (!content.trim()) return null

  const relative = toVaultRelative(filePath, ctx.vaultPath)
  if (!relative.endsWith('.md')) return null

  // Belt-and-suspenders: if the path already resolves to a live doc this isn't a
  // creation (the pure mapper owns it). Guards against a duplicate.
  if (resolveSlugForVaultPath(filePath, ctx.knownDocs, ctx.vaultPath)) return null

  // Split the model's path into folder + filename. The folder is the model's
  // routing decision (governed by CLAUDE.md); the filename is always its own.
  const parts = relative.split('/')
  const name = (parts.pop() ?? '').replace(/\.md$/, '').trim()
  if (!name) return null
  const folder = parts.join('/')

  // The note's title comes from its filename (the create helpers set it from `name`),
  // decoupled from the body — so we DON'T keep a leading `# name` heading that would
  // render the title twice. Strip only that duplicate; a different leading heading is
  // real content.
  const { body: stagedBody, removed } = stripDuplicateTitleHeading(content, name)
  if (removed) {
    console.log('[chat] dropped duplicate title heading from new note body', { name })
  }
  // Route by the chosen folder: a `wiki/` path becomes a real wiki page (so it lands in
  // the index and links resolve); any other folder is a generic note placed there; a
  // bare filename falls back to the default folder.
  const slug =
    folder === 'wiki'
      ? await createCustomWikiPage(name)
      : await createGenericNote(name, folder || getDefaultNoteFolder())
  if (!slug) return null

  return {
    id: payload.pendingId,
    source: 'chat',
    // This proposal just created the note (empty) to host its body — so a
    // reject can archive the empty note instead of leaving an orphan.
    createdNewNote: true,
    pageSlug: slug,
    groupId: payload.runId,
    createdAt: Date.now(),
    edits: [
      {
        id: crypto.randomUUID(),
        kind: 'add',
        anchorBefore: '',
        after: stagedBody,
      },
    ],
    // Model-supplied `reason` → recorded as the commit body on Keep.
    reason: readString(payload.input.reason).trim() || undefined,
    context: {
      threadId: ctx.threadId,
      runId: payload.runId,
      rationale: ctx.userRequest?.trim() || undefined,
    },
  }
}

/** Vault-relative or absolute path → catalog slug. Returns null when
 * no doc matches. Handles the three path shapes the SDK can emit:
 *   - absolute under the active vault root
 *   - absolute under a symlinked vault path that resolves to the same
 *     vault (basename-anchored fallback)
 *   - already-relative (some hosts hand it back that way) */
function resolveSlugForVaultPath(
  filePath: string,
  knownDocs: KnownDoc[],
  vaultPath: string | null,
): string | null {
  const relative = toVaultRelative(filePath, vaultPath)
  if (!relative) return null
  const getDoc = (s: string) => knownDocs.find((d) => d.slug === s)
  for (const doc of knownDocs) {
    if (doc.archivedAt) continue
    const docPath = pathForDoc(doc, getDoc)
    if (docPath && docPath === relative) return doc.slug
  }
  return null
}

/** Normalise the SDK's `file_path` argument to a vault-relative path.
 * Mirrors `PendingEditsBar.toVaultRelative` — same prefix-strip with
 * a basename fallback for symlinked vault hosts. Kept inline rather
 * than imported to keep the chat → store adapter self-contained;
 * unifying the helpers is a Phase F cleanup. */
export function toVaultRelative(filePath: string, vaultPath: string | null): string {
  if (vaultPath) {
    const root = vaultPath.endsWith('/') ? vaultPath : vaultPath + '/'
    if (filePath.startsWith(root)) return filePath.slice(root.length)
  }
  for (const dir of ['daily/', 'wiki/', 'writing/', '_system/']) {
    const idx = filePath.indexOf('/' + dir)
    if (idx !== -1) return filePath.slice(idx + 1)
  }
  // Could be a brand-new file outside the catalog (Write tool) — the
  // caller falls back to PendingEditsBar in that case.
  return filePath
}

/** Build the line-level edits this tool call carries. Each built-in
 * write-side tool has a different input shape:
 *
 *   - Edit       → one `replace` edit (old_string → new_string)
 *   - Write      → one `replace` edit (whole-doc swap; before unknown
 *                  client-side until we read the file, so the
 *                  decoration plugin treats this as a whole-page
 *                  banner rather than a line-level chip)
 *   - MultiEdit  → an array of `replace` edits, one per entry
 *   - NotebookEdit — not mapped; jupyter cells aren't part of the
 *                  vault's markdown model. Returns [] so the caller
 *                  falls back to the legacy bar.
 *
 * `anchorBefore` for chat: '' (placeholder). The decoration plugin
 * for `replace` kind uses `before` directly to locate the edit in the
 * doc — anchorBefore stays the documented sentinel and is unused on
 * the chat path. */
function buildEditsForTool(
  toolName: string,
  input: Record<string, unknown>,
): PendingEdit[] {
  if (toolName === 'Edit') {
    const oldString = readString(input.old_string)
    const newString = readString(input.new_string)
    if (!oldString) return []
    return [
      {
        id: crypto.randomUUID(),
        kind: 'replace',
        anchorBefore: '',
        before: oldString,
        after: newString,
      },
    ]
  }
  if (toolName === 'Write') {
    // Whole-document boundary: strip any echoed frontmatter so the `---`
    // block doesn't land in the body (preview + applied doc + disk).
    const content = normalizeAiBody(readString(input.content))
    return [
      {
        id: crypto.randomUUID(),
        kind: 'replace',
        anchorBefore: '',
        // `before` left undefined — Write replaces the whole file and
        // the renderer can read the current disk state if it needs
        // the pre-state for a diff.
        after: content,
      },
    ]
  }
  if (toolName === 'MultiEdit') {
    const raw = input.edits
    if (!Array.isArray(raw)) return []
    const out: PendingEdit[] = []
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const oldString = readString(e.old_string)
      const newString = readString(e.new_string)
      if (!oldString) continue
      out.push({
        id: crypto.randomUUID(),
        kind: 'replace',
        anchorBefore: '',
        before: oldString,
        after: newString,
      })
    }
    return out
  }
  return []
}

/** Re-derive the intended body when a SECOND (or later) write-side tool call
 * in one turn targets a file already staged as a new note THIS turn (e.g.
 * Write creates it, then Edit refines it) — the race `materializeRace.test.ts`
 * reproduces without coordination. `newFileContentFor` is wrong here: it
 * assumes "nothing exists yet" (Edit's `new_string` IS the whole body), which
 * only holds for the very FIRST call. For a follow-up call there IS a staged
 * body (from the prior call this turn) to edit against, so this reuses
 * `buildEditsForTool` — the same existing-doc replace semantics
 * (Edit → replace old_string→new_string, Write → whole-doc replace,
 * MultiEdit → sequential replaces) — applied via the applier's own
 * `applyEditsToText`, so there is exactly one implementation of "how an edit
 * lands," not a second, divergent one.
 *
 * Returns `currentBody` unchanged when the tool's edit doesn't apply (e.g. an
 * Edit whose `old_string` isn't found in the staged body) — the caller can
 * detect this via `=== currentBody` and surface it instead of silently
 * "succeeding" with nothing changed. */
export function mergeEditIntoStagedBody(
  currentBody: string,
  toolName: string,
  input: Record<string, unknown>,
): string {
  return applyEditsToText(currentBody, buildEditsForTool(toolName, input))
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
