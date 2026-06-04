import { describe, it, expect, vi, beforeEach } from 'vitest'

// Drive pushNow's guards without a real vault/git/network. The stores it
// reads are stubbed (gitStore) or real (syncStore, set directly).
const h = vi.hoisted(() => ({
  headSha: null as string | null,
  invoke: vi.fn(),
  setOpen: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }))
vi.mock('@/state/settingsStore', () => ({ getActiveVaultPath: () => '/vault' }))
vi.mock('@/state/gitStore', () => ({
  useGitStore: {
    getState: () => ({ headSha: h.headSha }),
    subscribe: vi.fn(() => () => {}),
  },
}))
vi.mock('sonner', () => ({ toast: { error: h.toastError } }))
vi.mock('@/stores/connectGitHubDialog', () => ({
  useConnectGitHubDialog: { getState: () => ({ setOpen: h.setOpen }) },
}))

import { pushNow } from './autoPush'
import { useSyncStore } from '@/state/syncStore'

const connected = {
  repoFullName: 'me/vault',
  remoteUrl: 'https://github.com/me/vault.git',
  branch: 'main',
  vaultId: 'v1',
}

beforeEach(() => {
  h.invoke.mockReset()
  h.toastError.mockReset()
  h.headSha = null
  useSyncStore.setState({
    repoFullName: null,
    remoteUrl: null,
    branch: null,
    vaultId: null,
    lastPushedSha: null,
    status: 'idle',
    lastError: null,
  })
})

describe('pushNow guards', () => {
  it('no-ops when no backup is bound', async () => {
    h.headSha = 'new'
    await pushNow()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('no-ops when HEAD is already pushed', async () => {
    useSyncStore.setState({ ...connected, lastPushedSha: 'abc', status: 'connected' })
    h.headSha = 'abc'
    await pushNow()
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('pushes and advances the bookmark when behind', async () => {
    useSyncStore.setState({ ...connected, lastPushedSha: 'old', status: 'connected' })
    h.headSha = 'new'
    h.invoke.mockResolvedValue(undefined)
    await pushNow()
    expect(h.invoke).toHaveBeenCalledWith('vault_push', { vaultPath: '/vault' })
    expect(useSyncStore.getState().lastPushedSha).toBe('new')
    expect(useSyncStore.getState().status).toBe('connected')
  })

  it('marks pending and stays silent on a transient (offline) failure', async () => {
    useSyncStore.setState({ ...connected, lastPushedSha: 'old', status: 'connected' })
    h.headSha = 'new'
    h.invoke.mockRejectedValue('git exit 128: could not resolve host github.com')
    await pushNow()
    expect(useSyncStore.getState().status).toBe('pending')
    expect(h.toastError).not.toHaveBeenCalled()
  })

  it('surfaces a reconnect toast on an auth/scope failure', async () => {
    useSyncStore.setState({ ...connected, lastPushedSha: 'old', status: 'connected' })
    h.headSha = 'new'
    h.invoke.mockRejectedValue('GitHub denied — reconnect to grant repo access.')
    await pushNow()
    expect(useSyncStore.getState().status).toBe('error')
    expect(h.toastError).toHaveBeenCalledTimes(1)
  })

  it('folds concurrent calls into one push (single-flight)', async () => {
    useSyncStore.setState({ ...connected, lastPushedSha: 'old', status: 'connected' })
    h.headSha = 'new'
    let release: () => void = () => {}
    h.invoke.mockReturnValue(
      new Promise<void>((r) => {
        release = () => r()
      }),
    )
    const p1 = pushNow()
    const p2 = pushNow() // sees inFlight → trailing re-run, no second invoke
    release()
    await Promise.all([p1, p2])
    expect(h.invoke).toHaveBeenCalledTimes(1)
  })
})
