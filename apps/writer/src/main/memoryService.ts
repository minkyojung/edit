import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readBelief, writeBelief } from './wikiService'
import { authedQuery, NotAuthenticatedError } from './claudeRuntime'

const MEMORY_WRITER_PROMPT = `You are a wiki manager for a writing assistant app.
You will receive a copyediting conversation between an AI copyeditor and a user's writing.
Your job: analyze the conversation and update the belief wiki to reflect the user's writing style patterns.

Rules:
- Use read_belief to fetch the current wiki first
- Add newly discovered patterns (things the copyeditor repeatedly flagged)
- Remove or fix contradictions
- Keep entries concise — one bullet per rule
- Do NOT update the wiki if nothing meaningful was learned
- Use write_belief to save changes
- Output in Korean`

async function runMemoryWriter(conversation: string): Promise<void> {
  const wikiServer = createSdkMcpServer({
    name: 'wiki',
    version: '0.0.1',
    tools: [
      tool(
        'read_belief',
        '현재 belief 위키 내용을 읽는다.',
        { _placeholder: z.string().optional() },
        async () => {
          const md = await readBelief()
          console.log('[memory] read_belief called')
          return { content: [{ type: 'text', text: md }] }
        }
      ),
      tool(
        'write_belief',
        '업데이트된 belief 위키 내용을 저장한다. 전체 마크다운을 넘길 것.',
        { markdown: z.string() },
        async ({ markdown }) => {
          await writeBelief(markdown)
          console.log('[memory] write_belief called')
          return { content: [{ type: 'text', text: 'saved' }] }
        }
      )
    ]
  })

  const prompt = `다음 교열 대화를 분석하고 belief 위키를 업데이트해라.\n\n${conversation}`

  const q = authedQuery({
    prompt,
    options: {
      model: 'claude-haiku-4-5',
      systemPrompt: MEMORY_WRITER_PROMPT,
      mcpServers: { wiki: wikiServer },
      allowedTools: ['mcp__wiki__read_belief', 'mcp__wiki__write_belief'],
      permissionMode: 'bypassPermissions',
      tools: ['mcp__wiki__read_belief', 'mcp__wiki__write_belief'],
      settingSources: []
    }
  })

  for await (const msg of q) {
    if (msg.type === 'result') {
      console.log('[memory] done')
      break
    }
  }
}

export function scheduleMemoryUpdate(conversation: string): void {
  runMemoryWriter(conversation).catch((err) => {
    if (err instanceof NotAuthenticatedError) {
      console.log('[memory] skipped — not authenticated')
      return
    }
    console.error('[memory error]', err)
  })
}
