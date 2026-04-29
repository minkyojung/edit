declare module '*.svg' {
  const url: string
  export default url
}

interface Window {
  agent: {
    trigger: (text: string) => void
    onChunk: (cb: (text: string) => void) => void
    onDone: (cb: () => void) => void
    onError: (cb: (msg: string) => void) => void
  }
  wiki: {
    read: () => Promise<string>
    save: (markdown: string) => Promise<void>
  }
  auth: {
    status: () => Promise<'ok' | 'not-installed' | 'not-logged-in'>
    login: () => Promise<'ok' | 'not-installed' | 'not-logged-in'>
    oauthStatus: () => Promise<'authenticated' | 'unauthenticated'>
    oauthStart: () => Promise<void>
    oauthComplete: (code: string) => Promise<void>
    logout: () => Promise<void>
    onChanged: (cb: (status: 'authenticated' | 'unauthenticated') => void) => void
  }
  server: {
    onError: (cb: () => void) => void
  }
  doc: {
    collabSession: () => Promise<{ collabWsUrl: string; token: string; slug: string }>
  }
  marks: {
    accept: (markId: string) => Promise<void>
    reject: (markId: string) => Promise<void>
  }
}
