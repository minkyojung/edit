import { app } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export type ModelId = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type AgentSettings = {
  model: ModelId
  effort: Effort
}

export const DEFAULT_SETTINGS: AgentSettings = {
  model: 'claude-haiku-4-5',
  effort: 'low'
}

export const MODEL_EFFORTS: Record<ModelId, Effort[]> = {
  'claude-haiku-4-5': ['low', 'medium', 'high'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max']
}

function path(): string {
  return join(app.getPath('userData'), 'agent-settings.json')
}

function normalize(raw: Partial<AgentSettings> | null): AgentSettings {
  const model: ModelId =
    raw?.model && raw.model in MODEL_EFFORTS ? raw.model : DEFAULT_SETTINGS.model
  const allowed = MODEL_EFFORTS[model]
  const effort: Effort = raw?.effort && allowed.includes(raw.effort) ? raw.effort : 'low'
  return { model, effort }
}

export async function load(): Promise<AgentSettings> {
  try {
    const raw = await readFile(path(), 'utf8')
    return normalize(JSON.parse(raw) as Partial<AgentSettings>)
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function save(s: AgentSettings): Promise<void> {
  const normalized = normalize(s)
  await writeFile(path(), JSON.stringify(normalized), 'utf8')
}
