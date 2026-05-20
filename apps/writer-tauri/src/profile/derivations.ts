// Derivations layer — per-section cache of the LLM's output.
//
// Each section the pipeline produces (Voice, Themes, About) is
// written as a standalone JSON file in vault/derivations/. That
// lets us:
//
//   - regenerate a single section without touching the others (the
//     Regenerate UI in Phase 4)
//   - know which source files a derivation was built from, so we
//     can detect "sources changed since this was derived" later
//   - record which model + prompt version produced it, so a future
//     model upgrade can prompt the user to re-derive
//
// The Profile page assembly (Phase 3) reads these files and stitches
// them into the wiki:profile markdown — no derivation text lives
// only in the page body, which means the source of truth stays the
// JSON and the page is a view.

import { readVaultFile, vaultFileExists, writeVaultFile } from '@/lib/vault'
import type { ProfileSectionKey } from './conventions'

const DERIVATIONS_ROOT = 'derivations'

export interface Derivation {
  kind: ProfileSectionKey
  /** ISO timestamp this derivation was produced. */
  derivedAt: string
  /** Anthropic model id used for this derivation. */
  model: string
  /** Vault-relative source file paths fed to the LLM for this run.
   * Lets a later "are sources fresher than derivations?" check
   * compare timestamps without re-reading the JSON content. */
  sourceFiles: string[]
  /** The LLM's text output (section body, no heading). */
  content: string
}

export async function saveDerivation(d: Derivation): Promise<void> {
  const relPath = pathFor(d.kind)
  await writeVaultFile(relPath, JSON.stringify(d, null, 2) + '\n')
}

export async function readDerivation(
  kind: ProfileSectionKey,
): Promise<Derivation | null> {
  const relPath = pathFor(kind)
  if (!(await vaultFileExists(relPath))) return null
  try {
    const raw = await readVaultFile(relPath)
    const parsed = JSON.parse(raw) as Derivation
    if (parsed.kind !== kind) {
      console.warn('[profile] derivation kind mismatch', {
        path: relPath,
        expected: kind,
        got: parsed.kind,
      })
      return null
    }
    return parsed
  } catch (err) {
    console.warn('[profile] derivation parse failed', { relPath, err })
    return null
  }
}

/** Read all three derivations at once. Any missing entry returns null
 * in its slot — callers (the profile assembler) handle partial state
 * by including only the sections that exist. */
export async function readAllDerivations(): Promise<
  Record<ProfileSectionKey, Derivation | null>
> {
  const [voice, themes, about] = await Promise.all([
    readDerivation('voice'),
    readDerivation('themes'),
    readDerivation('about'),
  ])
  return { voice, themes, about }
}

function pathFor(kind: ProfileSectionKey): string {
  return `${DERIVATIONS_ROOT}/${kind}.json`
}
