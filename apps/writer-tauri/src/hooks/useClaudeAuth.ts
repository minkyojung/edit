import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface ClaudeAccount {
  connected: boolean
  email: string | null
}

export function useClaudeAuth() {
  const [account, setAccount] = useState<ClaudeAccount>({ connected: false, email: null })
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const acc = await invoke<ClaudeAccount>('get_claude_account')
      setAccount(acc)
    } catch (e) {
      console.error('[claudeAuth] refresh failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    await invoke('disconnect_claude')
    await refresh()
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { account, loading, refresh, disconnect }
}
