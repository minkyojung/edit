// Unit tests for the caller side of thread-title generation. The sidecar side —
// what the model actually returns, and whether two back-to-back new chats both
// get a title — is covered by driving a real sidecar
// (sidecar/scripts/verify-thread-title.mjs); this covers the two things that
// live only here.
//
// 1. THE REQUEST CONTRACT. The title prompt and its one-shot tool constraints
//    belong to the sidecar's title mode, because neither works without the
//    other: sent from this side with no toolset constraint, the model got the
//    full claude_code preset and answered the message instead of titling it. So
//    this side must send only the message. A systemPrompt re-added here would
//    silently split the policy in two again — nothing would error, the titles
//    would just start coming back wrong.
//
// 2. WHAT COUNTS AS NO TITLE. `null` is the caller's signal to use
//    `fallbackTitle`, so the boundary between "a title" and "nothing usable"
//    decides whether a tab reads "New chat". Blank and whitespace-only model
//    output must both resolve null, not empty string.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type AnyCb = (e: { payload: unknown }) => void
const listeners = new Map<string, AnyCb[]>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: AnyCb) => {
    const arr = listeners.get(name) ?? []
    arr.push(cb)
    listeners.set(name, arr)
    return () => {
      listeners.set(name, (listeners.get(name) ?? []).filter((c) => c !== cb))
    }
  }),
}))

type TitlePayload = { args: Record<string, unknown> }
const invoke = vi.fn(async (_cmd: string, _payload: TitlePayload) => ({ accepted: true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const { generateThreadTitle, fallbackTitle } = await import('@/agent/generateThreadTitle')

const fire = (name: string, payload: unknown) => {
  for (const cb of listeners.get(name) ?? []) cb({ payload })
}
/** The runId the module minted for the in-flight call. Read off the invoke it
 *  just made rather than guessed, so the event filtering is exercised for real. */
const activeRunId = (): string => String(invoke.mock.calls.at(-1)![1].args.runId)

/** Drives one generation to settlement: start it, wait for the invoke, stream
 *  `text` as the assistant answer, then end the run. */
async function generate(message: string, text: string | null): Promise<string | null> {
  // Wait for THIS call's invoke, not just any — the module invokes after its
  // listeners register, so a test doing two generations in a row would
  // otherwise read the previous run's id and fire events nobody is listening for.
  const before = invoke.mock.calls.length
  const p = generateThreadTitle(message)
  await vi.waitFor(() => expect(invoke.mock.calls.length).toBeGreaterThan(before))
  const runId = activeRunId()
  if (text !== null) {
    fire('claude:event', {
      runId,
      event: { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    })
  }
  fire('claude:done', { runId, stopReason: 'end_turn' })
  return p
}

beforeEach(() => {
  listeners.clear()
  invoke.mockClear()
})

describe('generateThreadTitle — request contract', () => {
  it('sends only the message; the title policy stays in the sidecar', async () => {
    await generate('오늘 회의록 정리해줘', '회의록 정리하기')

    expect(invoke).toHaveBeenCalledTimes(1)
    const [cmd, payload] = invoke.mock.calls[0]
    expect(cmd).toBe('claude_title')
    // Exactly these keys — an added `systemPrompt`/`builtinTools`/`maxTurns`
    // here is the policy splitting in two, which is the failure this pins.
    expect(Object.keys(payload.args).sort()).toEqual(['model', 'prompt', 'runId'])
    expect(payload.args.prompt).toBe('오늘 회의록 정리해줘')
  })

  it('trims the message before sending, and sends nothing at all when it is blank', async () => {
    await generate('  회의록 정리해줘  ', '회의록 정리하기')
    expect(invoke.mock.calls[0][1].args.prompt).toBe('회의록 정리해줘')

    invoke.mockClear()
    expect(await generateThreadTitle('   ')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('generateThreadTitle — what reaches the tab', () => {
  it('takes the title as-is when the model behaves', async () => {
    expect(await generate('오늘 회의록 정리해줘', '회의록 정리하기')).toBe('회의록 정리하기')
  })

  it('keeps only the first line when the model answers instead of titling', async () => {
    // The shape verify-thread-title now rejects at the source. This is the
    // caller's last line of defence, not its plan.
    const answer = '회의록 정리하기\n\n먼저 파일 경로를 알려주세요:\n1. 어디에 있나요?'
    expect(await generate('오늘 회의록 정리해줘', answer)).toBe('회의록 정리하기')
  })

  it('strips wrapping quotes and collapses whitespace', async () => {
    expect(await generate('a', '"회의록   정리하기"')).toBe('회의록 정리하기')
  })

  it('truncates past 30 characters rather than letting a sentence into the tab', async () => {
    const long = 'Refactoring the authentication module and its tests'
    const got = await generate('refactor auth', long)
    expect(got).toBe('Refactoring the authentication…')
    expect(got!.length).toBe(31) // 30 chars + the ellipsis
  })

  it('resolves null — not an empty string — when there is nothing usable', async () => {
    // null is what makes the caller reach for fallbackTitle. An empty string
    // would pass its `??` check and set the thread's title to ''.
    expect(await generate('a', null)).toBeNull()
    expect(await generate('a', '   \n  ')).toBeNull()
  })

  it('resolves null when the run errors', async () => {
    const p = generateThreadTitle('오늘 회의록 정리해줘')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    fire('claude:error', { runId: activeRunId(), code: 'RATE_LIMIT', message: 'rate limited' })
    expect(await p).toBeNull()
  })

  it('ignores events belonging to another run on the shared channel', async () => {
    // Both sidecars emit on `claude:*`; runId is the only demux.
    const p = generateThreadTitle('오늘 회의록 정리해줘')
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled())
    fire('claude:event', {
      runId: 'someone-elses-run',
      event: { type: 'assistant', message: { content: [{ type: 'text', text: 'wrong title' }] } },
    })
    fire('claude:done', { runId: activeRunId(), stopReason: 'end_turn' })
    expect(await p).toBeNull()
  })
})

describe('fallbackTitle', () => {
  it('names the thread from the message when generation gives nothing', () => {
    expect(fallbackTitle('  오늘   회의록 정리해줘 ')).toBe('오늘 회의록 정리해줘')
  })

  it('stays inside the same 30-character budget', () => {
    expect(fallbackTitle('a'.repeat(40))).toBe('a'.repeat(30) + '…')
  })
})
