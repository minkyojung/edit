// Tombstones for user-deleted agent assets (skills / routines / agents).
//
// seedSkills / seedRoutines / seedAgents re-create the built-in defaults on
// every boot when their file is missing (idempotent-by-existence). Without a
// record of what the user deliberately deleted, a deleted default would
// resurrect on the next launch — unnatural ("I deleted it, why is it back?").
// This module keeps a small list of deleted vault-relative paths so seeding can
// skip them. All three seeded kinds tombstone on delete; a user-created skill
// that was never a default also records a harmless entry no seeder checks.
//
// Stored in the vault (`_system/agent/.deleted.json`) so the record travels
// with the vault (git, other machines), matching "the vault is the single
// source of truth".

import { readVaultFile, writeVaultFile } from '@/lib/vault'

const TOMBSTONE_REL = '_system/agent/.deleted.json'

/** The vault-relative paths the user has deleted. Empty on a fresh vault or
 * read/parse error (fail-open: a lost tombstone only means a default may
 * re-seed, never data loss). */
export async function readTombstones(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readVaultFile(TOMBSTONE_REL))
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    )
  } catch {
    return new Set()
  }
}

/** Record `rel` as user-deleted so the boot seeders skip re-creating it.
 * Idempotent — a path already tombstoned is a no-op. */
export async function addTombstone(rel: string): Promise<void> {
  const dead = await readTombstones()
  if (dead.has(rel)) return
  dead.add(rel)
  await writeVaultFile(TOMBSTONE_REL, JSON.stringify([...dead], null, 2))
}
