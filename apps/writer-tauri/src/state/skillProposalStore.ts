// Skill proposals — the chat agent's `propose_skill` tool routes here.
//
// Deliberately separate from `pendingChangesStore`: a skill is agent
// infrastructure (a SKILL.md under `_system/agent/skills/`, loaded via the
// SDK plugins path), NOT a wiki document. The doc-edit store assumes a real
// page handle (`handles[pageSlug].bodyMarkdown`) and prunes entries whose
// slug has no live doc — both of which would break a skill entry. So skills
// get their own tiny store + apply path: on accept we just write the file.

import { create } from 'zustand'
import { writeVaultFile } from '@/lib/vault'
import { composeFrontmatter } from '@/lib/frontmatter'

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
  status: 'pending' | 'accepted' | 'rejected'
}

/** Folder-safe form of the skill name. The model is told to send a kebab
 * id, but sanitise defensively so a stray space / slash can't escape the
 * skills directory or make an unreadable path. */
function skillDirName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  )
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
    const dir = skillDirName(p.name)
    const rel = `_system/agent/skills/${dir}/SKILL.md`
    const md = composeFrontmatter({ name: dir, description: p.description }, p.body)
    try {
      await writeVaultFile(rel, md)
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
