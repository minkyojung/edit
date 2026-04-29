declare module '*.svg' {
  const url: string
  export default url
}

type AgentModelId = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type AgentSettings = { model: AgentModelId; effort: AgentEffort }

interface Window {
  agent: {
    trigger: (text: string, processedHistory?: unknown[]) => void
    onChunk: (cb: (text: string) => void) => void
    onDone: (cb: () => void) => void
    onError: (cb: (msg: string) => void) => void
    getSettings: () => Promise<AgentSettings>
    setSettings: (s: AgentSettings) => Promise<AgentSettings>
  }
  wiki: {
    read: () => Promise<string>
    save: (markdown: string) => Promise<void>
  }
  auth: {
    oauthStatus: () => Promise<'authenticated' | 'unauthenticated'>
    oauthStart: () => Promise<void>
    oauthComplete: (code: string) => Promise<void>
    logout: () => Promise<void>
    onChanged: (cb: (status: 'authenticated' | 'unauthenticated') => void) => () => void
    onRequired: (cb: () => void) => () => void
  }
  server: {
    onError: (cb: () => void) => void
  }
  doc: {
    collabSession: () => Promise<{ collabWsUrl: string; token: string; slug: string }>
  }
  marks: {
    fetchState: () => Promise<{ marks: Record<string, unknown>; revision?: number } | null>
    accept: (markId: string, by?: string) => Promise<{ success: boolean; status: number; body: unknown }>
    reject: (markId: string, by?: string) => Promise<{ success: boolean; status: number; body: unknown }>
  }
}
