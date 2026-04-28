import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { access } from 'fs/promises'

export type AuthStatus = 'ok' | 'not-installed' | 'not-logged-in'

const CLAUDE_BIN = join(homedir(), '.claude', 'local', 'claude')

async function claudeInstalled(): Promise<boolean> {
  try {
    await access(CLAUDE_BIN)
    return true
  } catch {
    return false
  }
}

function runClaude(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { timeout: 5000 }, (err, stdout) => {
      resolve({ code: err ? (err.code as number) ?? 1 : 0, stdout })
    })
  })
}

export async function checkAuth(): Promise<AuthStatus> {
  if (!(await claudeInstalled())) return 'not-installed'

  const { code, stdout } = await runClaude(['auth', 'status'])
  if (code !== 0) return 'not-logged-in'

  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: boolean }
    return parsed.loggedIn ? 'ok' : 'not-logged-in'
  } catch {
    return 'not-logged-in'
  }
}

export function runLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(CLAUDE_BIN, ['auth', 'login'], { timeout: 120000 }, (err) => {
      if (err) reject(err)
      else resolve()
    })
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
  })
}
