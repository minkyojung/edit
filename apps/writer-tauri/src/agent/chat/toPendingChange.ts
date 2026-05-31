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
import { createCustomWikiPage } from '@/state/wikiService'

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
  if (!filePath) return null

  const slug = resolveSlugForVaultPath(filePath, ctx.knownDocs, ctx.vaultPath)
  if (!slug) return null

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
  if (edits.length === 0) return null

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

/** Create a brand-new wiki page for a chat `propose_write` whose target
 * path doesn't resolve to an existing doc, then return a PendingChange
 * staging its body for review. Mirrors ingest's
 * `materializeNewPageProposals`: the page is born with just its H1
 * title (so it exists in the catalog, shows in the sidebar, and can
 * host a staged change), and the body sits in the review queue until
 * the user Keeps it.
 *
 * Returns null when this isn't a new-wiki-page write — wrong tool
 * (only whole-file `propose_write`/`Write` creates pages; Edit /
 * MultiEdit target existing text, where a missing target is a real
 * miss), a non-wiki path (daily / writing have date / parent placement
 * rules this path doesn't model), no body, or an already-resolvable
 * path — and when page creation itself fails. The caller then falls
 * through to the existing "unmappable" warning. */
export async function materializeChatNewWikiPage(
  payload: ChatEditPendingPayload,
  ctx: MapContext,
): Promise<Omit<PendingChange, 'status' | 'decidedAt' | 'viewedAt'> | null> {
  if (payload.toolName !== 'Write') return null
  const filePath = readString(payload.input.file_path)
  const content = readString(payload.input.content)
  if (!filePath || !content.trim()) return null

  const relative = toVaultRelative(filePath, ctx.vaultPath)
  if (!relative.startsWith('wiki/') || !relative.endsWith('.md')) return null

  // Belt-and-suspenders: if the path already resolves to a live doc
  // this isn't a creation (the pure mapper owns it). Guards against a
  // duplicate page if this ever runs for a resolvable path.
  if (resolveSlugForVaultPath(filePath, ctx.knownDocs, ctx.vaultPath)) return null

  const name = relative.slice('wiki/'.length).replace(/\.md$/, '').trim()
  if (!name) return null

  // Seed the page with its H1 title only — the title-mirror reads the
  // first block as the page name, so the heading must be present before
  // any body lands (else the first Kept body line would become the
  // title). Stage the rest for review; drop a leading H1 in the model's
  // content so the seeded title isn't duplicated.
  const stagedBody = stripLeadingH1(content)
  const slug = await createCustomWikiPage(name, `# ${name}`)
  if (!slug) return null

  return {
    id: payload.pendingId,
    source: 'chat',
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
    context: {
      threadId: ctx.threadId,
      runId: payload.runId,
      rationale: ctx.userRequest?.trim() || undefined,
    },
  }
}

/** Drop a leading level-1 heading line (plus one trailing blank) from a
 * markdown body. Used when seeding a new page's title separately from
 * its staged body so the H1 doesn't render twice. */
function stripLeadingH1(md: string): string {
  const lines = md.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i >= lines.length || !/^#\s+/.test(lines[i])) return md
  lines.splice(0, i + 1)
  if (lines.length > 0 && lines[0].trim() === '') lines.shift()
  return lines.join('\n')
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
function toVaultRelative(filePath: string, vaultPath: string | null): string {
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
    const content = readString(input.content)
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

function readString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
