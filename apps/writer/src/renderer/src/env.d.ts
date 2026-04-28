interface Window {
  agent: {
    trigger: (text: string) => void
    onChunk: (cb: (text: string) => void) => void
    onDone: (cb: () => void) => void
  }
  wiki: {
    read: () => Promise<string>
    save: (markdown: string) => Promise<void>
  }
  auth: {
    status: () => Promise<'ok' | 'not-installed' | 'not-logged-in'>
    login: () => Promise<'ok' | 'not-installed' | 'not-logged-in'>
  }
}
