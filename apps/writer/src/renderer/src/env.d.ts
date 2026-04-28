interface Window {
  agent: {
    trigger: (text: string) => void
    onChunk: (cb: (text: string) => void) => void
    onDone: (cb: () => void) => void
  }
}
