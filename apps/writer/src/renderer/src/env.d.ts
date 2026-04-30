declare module '*.svg' {
  const url: string
  export default url
}

type ChatFile = { url: string; mediaType: string; filename?: string }
type ChatMessage = { role: 'user' | 'assistant'; content: string; files?: ChatFile[] }

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
    chat: (messages: ChatMessage[], documentContext: string | null, model: AgentModelId) => void
    stopChat: () => void
    onChatChunk: (cb: (chunk: string) => void) => () => void
    onChatDone: (cb: () => void) => () => void
    onChatError: (cb: (msg: string) => void) => () => void
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
}
