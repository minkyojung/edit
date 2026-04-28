/**
 * Spike B — verify claude-agent-sdk can call a custom MCP tool
 * that fetches a proof-sdk wiki page.
 *
 * Throwaway. Run with: pnpm --filter writer tsx scripts/spike-b.ts
 *
 * Prerequisite: proof-sdk server on :4000 (PROOF_SHARE_MARKDOWN_AUTH_MODE=none)
 */
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const PROOF_URL = 'http://localhost:4000'

async function createWikiDoc(): Promise<{ slug: string; token: string }> {
  const res = await fetch(`${PROOF_URL}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: `# 사용자 글쓰기 스타일

- 짧은 문장을 선호함
- 불필요한 수식어를 제거함
- 직접적인 표현을 좋아함`,
      title: 'belief',
      role: 'editor',
      ownerId: 'human:user'
    })
  })
  const data = await res.json()
  return { slug: data.slug, token: data.accessToken }
}

async function readWiki(slug: string, token: string): Promise<string> {
  const res = await fetch(`${PROOF_URL}/documents/${slug}/state`, {
    headers: { 'x-share-token': token }
  })
  const data = await res.json()
  return data.markdown as string
}

async function main(): Promise<void> {
  console.log('[spike-b] creating wiki doc...')
  const { slug, token } = await createWikiDoc()
  console.log(`[spike-b] created slug=${slug}`)

  const wikiServer = createSdkMcpServer({
    name: 'wiki',
    version: '0.0.1',
    tools: [
      tool(
        'read_belief',
        '사용자의 글쓰기 스타일/취향이 담긴 belief 위키 페이지를 읽는다. 글 교열 시작 전에 반드시 이 도구를 호출해서 사용자 스타일을 확인하라.',
        { _placeholder: z.string().optional() },
        async () => {
          const md = await readWiki(slug, token)
          console.log('[spike-b] tool called: read_belief')
          return { content: [{ type: 'text', text: md }] }
        }
      )
    ]
  })

  let toolCalled = false
  let assistantText = ''

  const q = query({
    prompt: '아래 글을 교열해줘. 시작 전에 반드시 read_belief 도구로 사용자 스타일을 확인해라.\n\n글:\n"매우 정말로 굉장히 빠른 속도로 달려가는 자동차가 있었습니다."',
    options: {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'You are a Korean copyeditor. Use the read_belief tool to check user style preferences before suggesting edits.'
      },
      mcpServers: { wiki: wikiServer },
      allowedTools: ['mcp__wiki__read_belief'],
      permissionMode: 'bypassPermissions',
      tools: ['mcp__wiki__read_belief']
    }
  })

  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('[spike-b] session started, tools:', msg.tools)
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          toolCalled = true
          console.log('[spike-b] tool_use:', block.name, JSON.stringify(block.input))
        }
        if (block.type === 'text') {
          assistantText += block.text
        }
      }
    }
    if (msg.type === 'result') {
      console.log('---')
      console.log('[spike-b] DONE.')
      console.log('[spike-b] tool called:', toolCalled)
      console.log('[spike-b] final answer:')
      console.log(assistantText)
      break
    }
  }
}

main().catch((err) => {
  console.error('[spike-b error]', err)
  process.exit(1)
})
