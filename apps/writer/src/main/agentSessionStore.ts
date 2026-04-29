import { app } from 'electron'
import { readFile, writeFile, unlink } from 'fs/promises'
import { join } from 'path'

type Stored = { sessionId: string }

function path(): string {
  return join(app.getPath('userData'), 'agent-session.json')
}

export async function load(): Promise<string | null> {
  try {
    const raw = await readFile(path(), 'utf8')
    const parsed = JSON.parse(raw) as Stored
    return parsed.sessionId || null
  } catch {
    return null
  }
}

export async function save(sessionId: string): Promise<void> {
  await writeFile(path(), JSON.stringify({ sessionId }), 'utf8')
}

export async function clear(): Promise<void> {
  try {
    await unlink(path())
  } catch {
    // already absent
  }
}
