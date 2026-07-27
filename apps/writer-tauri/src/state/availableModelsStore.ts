// What models this app can offer, from two independent sources.
//
//   • `models` — the Claude Agent SDK's session-init handshake
//     (query.supportedModels(), via the sidecar). Reports what the signed-in
//     ACCOUNT may use, and carries capability flags the catalog doesn't
//     (notably supportsFastMode). It lags a model release by days.
//   • `catalog` — GET /v1/models (via the Rust anthropic_list_models command).
//     Authoritative and current: it listed Opus 5 on release day, while the
//     handshake above still described Opus as 4.8.
//
// Both are PURELY ADDITIVE. Each starts null and stays null on failure, and
// consumers fall back to the built-in CHAT_MODELS list, so the picker keeps
// working with no token, no network, or an API change.
//
// The catalog is cached to localStorage on every success and read back
// synchronously at store creation, so a model discovered in a previous session
// is still offered while offline — otherwise going offline would silently
// demote the user back to the list this binary shipped with.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { ModelInfo } from '@/chat/types'
import type { ModelEntry } from '@/chat/modelCatalog'

const CATALOG_CACHE_KEY = 'writer-tauri:model-catalog'

/** Last-known-good catalog. Any parse/shape problem yields null rather than
 * throwing — a corrupt cache must not take the app down at import time. */
function readCachedCatalog(): ModelEntry[] | null {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const entries = parsed.filter(
      (e): e is ModelEntry => typeof (e as ModelEntry)?.id === 'string',
    )
    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}

function writeCachedCatalog(entries: ModelEntry[]): void {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(entries))
  } catch {
    // Quota or a locked-down webview — the catalog still works this session.
  }
}

interface AvailableModelsState {
  /** Account-accessible models per the SDK handshake, or null when not yet
   * loaded / load failed. */
  models: ModelInfo[] | null
  /** Authoritative catalog, or null when never fetched and nothing cached. */
  catalog: ModelEntry[] | null
  loading: boolean
  /** Fetch both sources once. Each is guarded independently, so a failure in
   * one doesn't block the other, and a prior failure (e.g. no token yet at
   * boot) leaves that source null so a later call retries it. */
  load: () => Promise<void>
}

export const useAvailableModelsStore = create<AvailableModelsState>((set, get) => ({
  models: null,
  catalog: readCachedCatalog(),
  loading: false,
  load: async () => {
    if (get().loading) return
    set({ loading: true })

    // Independent on purpose: the sidecar path needs a live sidecar + token,
    // the catalog path needs only the token. Either can succeed alone.
    const handshake = get().models
      ? Promise.resolve()
      : invoke<{ models?: ModelInfo[] }>('claude_list_models')
          .then((res) => {
            const models = Array.isArray(res?.models) ? res.models.filter((m) => m?.value) : []
            if (models.length > 0) set({ models })
          })
          .catch((err) => {
            console.warn('[availableModels] handshake failed; using built-in list', err)
          })

    const catalog = invoke<ModelEntry[]>('anthropic_list_models')
      .then((entries) => {
        const list = Array.isArray(entries) ? entries.filter((e) => e?.id) : []
        // An empty list is the no-token case, not a catalog of zero models —
        // keep whatever was cached rather than blanking it.
        if (list.length > 0) {
          set({ catalog: list })
          writeCachedCatalog(list)
        }
      })
      .catch((err) => {
        console.warn('[availableModels] catalog fetch failed; using cache/built-in', err)
      })

    await Promise.all([handshake, catalog])
    set({ loading: false })
  },
}))
