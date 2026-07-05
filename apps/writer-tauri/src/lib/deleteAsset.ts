// One delete path for the three agent-asset kinds — skills, routines, agents —
// shared by both entry points (the list pages and the note's ⋯ menu). Keyed by
// the asset's vault-relative path (not a catalog slug): both entry points hold
// the path reliably, and it sidesteps the brief window where a freshly-created
// asset isn't catalogued yet (slug === '').
//
// Asymmetry handled here so callers don't have to: a skill is a FOLDER
// (`skills/<dir>/SKILL.md` + assets), routines / agents are a single `.md`.

import { deleteVaultDir, trashVaultFile } from '@/lib/vault'
import { useDocsStore } from '@/state/docsStore'
import { findSlugByVaultPath } from '@/state/docsStore/helpers'
import { addTombstone } from '@/lib/assetTombstone'

const SKILL_RE = /^_system\/agent\/skills\/[^/]+\/SKILL\.md$/
const ROUTINE_RE = /^_system\/agent\/commands\/[^/]+\.md$/
const AGENT_RE = /^_system\/agent\/agents\/[^/]+\.md$/

/** True when `rel` is a skill / routine / agent file — i.e. the ⋯ menu should
 * route its Delete through {@link deleteAssetByPath} instead of the plain
 * note-trash path. */
export function isAgentAssetPath(rel: string): boolean {
  return SKILL_RE.test(rel) || ROUTINE_RE.test(rel) || AGENT_RE.test(rel)
}

/** Delete a skill / routine / agent by its vault path. Tears it out of the
 * in-memory catalog (closing any open tab), removes it on disk, and tombstones
 * it so the boot seeders don't resurrect a deleted default. No-op-safe: an
 * unknown-shaped path just deletes nothing. */
export async function deleteAssetByPath(rel: string): Promise<void> {
  const isSkill = SKILL_RE.test(rel)
  // All three kinds are now boot-seeded (skills via seedSkills), so all three
  // tombstone on delete — otherwise a deleted default returns on next launch.
  const isAsset = isSkill || ROUTINE_RE.test(rel) || AGENT_RE.test(rel)
  if (!isAsset) return

  // Drop from the catalog FIRST so the flush loop can't re-write the file
  // mid-delete; removeKnownDoc closes the tab + destroys the handle. No-op
  // when the asset isn't catalogued yet (unscanned) — then it's a pure disk
  // delete below.
  const store = useDocsStore.getState()
  const slug = findSlugByVaultPath(store.knownDocs, rel)
  if (slug) store.removeKnownDoc(slug)

  // A skill is a folder (SKILL.md + any assets) → remove the whole dir.
  // Routines / agents are a single file → OS trash (recoverable).
  if (isSkill) {
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    await deleteVaultDir(dir)
  } else {
    await trashVaultFile(rel)
  }

  await addTombstone(rel)
}
