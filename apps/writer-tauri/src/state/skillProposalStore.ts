// Skill proposals — the chat agent's `propose_skill` tool routes here.
//
// Deliberately separate from `pendingChangesStore`: a skill is agent
// infrastructure (a SKILL.md under `_system/agent/skills/`, loaded via the
// SDK plugins path), NOT a wiki document. The doc-edit store assumes a real
// page handle (`handles[pageSlug].bodyMarkdown`) and prunes entries whose
// slug has no live doc — both of which would break a skill entry. So skills
// get their own tiny store + apply path: on accept we just write the file.

import { create } from 'zustand'
import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'
import { composeFrontmatter, mergeFrontmatter } from '@/lib/frontmatter'
import { useDocsStore } from '@/state/docsStore'
import { updateDocBody } from '@/state/docsStore/docBody'
import { findSlugByVaultPath } from '@/state/docsStore/helpers'
import { flushDirty } from '@/lib/docFileSync'

export interface SkillProposal {
  /** Sidecar-minted id, unique per propose_skill call. */
  pendingId: string
  /** The run that produced it (lets the UI group a turn's proposals). */
  runId: string
  /** Skill id — also the folder name under `_system/agent/skills/`. */
  name: string
  /** When-to-use line; becomes the SKILL.md `description` (the match key). */
  description: string
  /** The procedure, markdown; becomes the SKILL.md body. */
  body: string
  /** When the model is revising an existing skill, its exact name (the
   * dedup signal). null for a brand-new skill. Drives the "update vs new"
   * affordance + diff in the tray, and the in-place write target. */
  updates: string | null
  status: 'pending' | 'accepted' | 'rejected'
}

/** Folder-safe form of the skill name. The model is told to send a kebab
 * id, but sanitise defensively so a stray space / slash can't escape the
 * skills directory or make an unreadable path. */
export function skillDirName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  )
}

/** Write a SKILL.md, by whichever route is the sanctioned one for its current
 *  state. A nested `_system/agent/skills/<dir>/SKILL.md` is a scanned, editable
 *  note — scanVault's `system:` rule only matches `_system/<name>.md` at one
 *  level — so it can be open in the editor and it can carry frontmatter this
 *  path knows nothing about.
 *
 *  - **New skill**: nothing on disk, so no doc and no handle. Compose and write.
 *  - **Update, not open**: `mergeFrontmatter`, not `composeFrontmatter` — the
 *    latter emits a whole new block, discarding every key the file had that
 *    isn't in `fields`.
 *  - **Update, open in the editor**: the flush owns disk for a doc with a live
 *    handle. Writing here would be echo-suppressed and then overwritten by the
 *    handle's stale mirror on the next tick — the accepted skill reverts and
 *    the user was told it saved. Body goes through `updateDocBody`; the
 *    description is frontmatter, which that funnel does not own, so it goes
 *    through the property path and the flush emits it. */
async function writeSkillFile(
  rel: string,
  fields: { name: string; description: string },
  body: string,
): Promise<void> {
  if (!(await vaultFileExists(rel))) {
    await writeVaultFile(rel, composeFrontmatter(fields, body))
    return
  }
  const slug = findSlugByVaultPath(useDocsStore.getState().knownDocs, rel)
  if (slug && useDocsStore.getState().handles[slug]) {
    const r = await updateDocBody(slug, () => body)
    if (!r.ok) throw new Error(`updateDocBody refused: ${r.reason}`)
    useDocsStore.getState().setDocProperty(slug, 'description', fields.description)
    void flushDirty()
    return
  }
  await writeVaultFile(rel, mergeFrontmatter(await readVaultFile(rel), fields, body))
}

interface SkillProposalState {
  byId: Record<string, SkillProposal>
  push: (p: Omit<SkillProposal, 'status'>) => void
  /** Write the SKILL.md and mark accepted. Returns false on write failure
   * (the entry stays pending so the user can retry). */
  accept: (pendingId: string) => Promise<boolean>
  reject: (pendingId: string) => void
  pending: () => SkillProposal[]
}

export const useSkillProposalStore = create<SkillProposalState>((set, get) => ({
  byId: {},

  push: (p) =>
    set((s) => ({ byId: { ...s.byId, [p.pendingId]: { ...p, status: 'pending' } } })),

  accept: async (pendingId) => {
    const p = get().byId[pendingId]
    if (!p || p.status !== 'pending') return false
    // On an update, the target folder is the skill being revised — derive
    // the dir from `updates`, not `name`, so the write lands in place even
    // if the proposed name drifted. New skills use their own name.
    const dir = skillDirName(p.updates ?? p.name)
    const rel = `_system/agent/skills/${dir}/SKILL.md`
    const fields = { name: dir, description: p.description }
    try {
      await writeSkillFile(rel, fields, p.body)
    } catch (err) {
      console.warn('[skill] write failed', rel, err)
      return false
    }
    set((s) => ({
      byId: { ...s.byId, [pendingId]: { ...p, status: 'accepted' } },
    }))
    console.log('[skill] saved', rel)
    return true
  },

  reject: (pendingId) =>
    set((s) => {
      const p = s.byId[pendingId]
      if (!p) return s
      return { byId: { ...s.byId, [pendingId]: { ...p, status: 'rejected' } } }
    }),

  pending: () => Object.values(get().byId).filter((p) => p.status === 'pending'),
}))
