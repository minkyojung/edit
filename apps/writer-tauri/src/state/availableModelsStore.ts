// Models the signed-in account can actually use, fetched once from the sidecar
// (query.supportedModels()). The PromptInput model picker intersects its
// built-in CHAT_MODELS list against this so models the account has no access to
// (e.g. region-gated ones) stay hidden.
//
// Purely additive: `models` is null until a successful load, and any failure
// leaves it null. Consumers fall back to the full built-in list when it's null,
// so the picker keeps working even if the fetch never succeeds.

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type { ModelInfo } from '@/chat/types'

interface AvailableModelsState {
  /** Account-accessible models, or null when not yet loaded / load failed. */
  models: ModelInfo[] | null
  loading: boolean
  /** Fetch the list once. No-ops while in flight or after a success; a prior
   * failure (e.g. no token yet at boot) leaves `models` null so a later call
   * retries. */
  load: () => Promise<void>
}

export const useAvailableModelsStore = create<AvailableModelsState>((set, get) => ({
  models: null,
  loading: false,
  load: async () => {
    if (get().loading || get().models) return
    set({ loading: true })
    try {
      const res = await invoke<{ models?: ModelInfo[] }>('claude_list_models')
      const models = Array.isArray(res?.models) ? res.models.filter((m) => m?.value) : []
      set({ models: models.length > 0 ? models : null, loading: false })
    } catch (err) {
      console.warn('[availableModels] load failed; falling back to built-in list', err)
      set({ loading: false })
    }
  },
}))
