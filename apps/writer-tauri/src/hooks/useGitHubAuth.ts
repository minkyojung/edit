import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface GitHubAccount {
  connected: boolean
  login: string | null
}

/** Mirrors useClaudeAuth: reads connection status from the rust side,
 * exposes refresh + disconnect. The token itself never leaves rust. */
export function useGitHubAuth() {
  const [account, setAccount] = useState<GitHubAccount>({
    connected: false,
    login: null,
  })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const acc = await invoke<GitHubAccount>('get_github_account')
      setAccount(acc)
    } catch (e) {
      console.error('[githubAuth] refresh failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    await invoke('disconnect_github')
    await refresh()
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { account, loading, refresh, disconnect }
}
