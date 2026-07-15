// "Connections" settings panel. The single home for account/connection management —
// Claude and GitHub connect/disconnect. The profile dropdown only *shows* the current
// identities; managing them happens here, so settings stay the one place connections live.
//
// Auth state comes from the same hooks the sidebar uses; the connect flow is triggered
// through the shared connect-dialog stores (the dialogs themselves stay mounted in the
// sidebar). Because each useClaudeAuth/useGitHubAuth call holds its own state, we refresh
// when a connect dialog closes — otherwise this panel would still read "Not connected"
// right after a successful connect.

import { useEffect, useRef } from 'react'
import { IconSparkles, IconBrandGithub, IconBrandGoogle } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { useClaudeAuth } from '@/hooks/useClaudeAuth'
import { useGitHubAuth } from '@/hooks/useGitHubAuth'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useConnectDialog } from '@/stores/connectDialog'
import { useConnectGitHubDialog } from '@/stores/connectGitHubDialog'
import { SettingRow } from '../SettingRow'

/** Refresh `refresh()` whenever `open` transitions true → false (a connect
 * dialog just closed, possibly after a successful connect). */
function useRefreshOnDialogClose(open: boolean, refresh: () => void) {
  const prev = useRef(open)
  useEffect(() => {
    if (prev.current && !open) refresh()
    prev.current = open
  }, [open, refresh])
}

export function ConnectionsSettings() {
  const { account, refresh, disconnect } = useClaudeAuth()
  const {
    account: githubAccount,
    refresh: refreshGithub,
    disconnect: disconnectGithub,
  } = useGitHubAuth()
  const {
    account: googleAccount,
    connecting: googleConnecting,
    connect: connectGoogle,
    disconnect: disconnectGoogle,
  } = useGoogleAuth()

  // Google connects in one loopback round-trip (no dialog/paste), so it's driven
  // straight from the hook here rather than through a connect-dialog store.
  const signInGoogle = () => {
    void connectGoogle().catch((e) => console.error('[connections] google sign-in failed', e))
  }

  const connectOpen = useConnectDialog((s) => s.open)
  const openConnect = useConnectDialog((s) => s.setOpen)
  const githubConnectOpen = useConnectGitHubDialog((s) => s.open)
  const openGithubConnect = useConnectGitHubDialog((s) => s.setOpen)

  useRefreshOnDialogClose(connectOpen, refresh)
  useRefreshOnDialogClose(githubConnectOpen, refreshGithub)

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Connections</h2>

      <SettingRow
        title="Google"
        description={
          googleAccount.connected
            ? [googleAccount.name, googleAccount.email].filter(Boolean).join(' · ') || 'Connected'
            : 'Sign in with Google to personalize your workspace.'
        }
      >
        {googleAccount.connected ? (
          <Button variant="outline" size="sm" onClick={() => void disconnectGoogle()}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={signInGoogle} disabled={googleConnecting}>
            <IconBrandGoogle size={16} stroke={1.5} />
            {googleConnecting ? 'Waiting…' : 'Connect'}
          </Button>
        )}
      </SettingRow>

      <SettingRow
        title="Claude"
        description={
          account.connected
            ? (account.email ?? 'Connected')
            : 'Connect your Claude account to use the assistant.'
        }
      >
        {account.connected ? (
          <Button variant="outline" size="sm" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={() => openConnect(true)}>
            <IconSparkles size={16} stroke={1.5} />
            Connect
          </Button>
        )}
      </SettingRow>

      <SettingRow
        title="GitHub"
        description={
          githubAccount.connected
            ? (githubAccount.login ?? 'Connected')
            : 'Connect GitHub to sync your vault.'
        }
      >
        {githubAccount.connected ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void disconnectGithub()}
          >
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={() => openGithubConnect(true)}>
            <IconBrandGithub size={16} stroke={1.5} />
            Connect
          </Button>
        )}
      </SettingRow>
    </section>
  )
}
