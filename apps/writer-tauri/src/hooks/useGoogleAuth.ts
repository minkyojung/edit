import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export interface GoogleAccount {
  connected: boolean
  email: string | null
  name: string | null
  picture: string | null
}

const DISCONNECTED: GoogleAccount = {
  connected: false,
  email: null,
  name: null,
  picture: null,
}

export function useGoogleAuth() {
  const [account, setAccount] = useState<GoogleAccount>(DISCONNECTED)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const acc = await invoke<GoogleAccount>('get_google_account')
      setAccount(acc)
    } catch (e) {
      console.error('[googleAuth] refresh failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // Runs the full loopback sign-in; resolves once the browser round-trip
  // completes and the profile is stored. Returns the connected account.
  const connect = useCallback(async () => {
    setConnecting(true)
    try {
      const acc = await invoke<GoogleAccount>('start_google_oauth')
      setAccount(acc)
      return acc
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    await invoke('disconnect_google')
    await refresh()
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { account, loading, connecting, connect, refresh, disconnect }
}
