// Vault templates — user-authored `.md` files in the templates folder
// (configurable in settings, default `templates/`) become insertable snippets.
// The same template feeds two surfaces:
//   • editor slash menu (`/`)     — insert the body at the cursor
//   • command palette (⌘K)        — create a whole new note from the body
//
// A template's BODY is the exact markdown inserted; frontmatter is stripped so a
// template can carry its own `.md` metadata without leaking into the target. The
// folder is a plain Obsidian-style convention: nothing scaffolds it, and a
// missing / empty folder simply yields zero templates (no error).

import {
  createVaultFolder,
  listVaultDir,
  readVaultFile,
  vaultFileExists,
  writeVaultFile,
} from '@/lib/vault'
import { splitFrontmatter } from '@/lib/frontmatter'
import { getTemplatesFolder } from '@/state/settingsStore'
import { setTemplateSlashItems, templateSlashItem } from '@/prototypes/slashCommands'

export interface Template {
  /** Filename without `.md` — the label shown in menus. */
  name: string
  /** Markdown body (frontmatter stripped, trimmed). The exact text inserted. */
  body: string
}

/** Read every `.md` in the templates folder, sorted by name. Returns `[]` when
 * no vault is selected, the folder doesn't exist yet, or it holds no templates.
 * Never throws — a broken template folder must not break the editor or palette. */
export async function loadTemplates(): Promise<Template[]> {
  const folder = getTemplatesFolder()
  if (!folder) return [] // no templates folder configured
  let names: string[]
  try {
    names = await listVaultDir(folder)
  } catch {
    // Folder missing (never created) or no vault — no templates yet.
    return []
  }
  const templates: Template[] = []
  for (const file of names) {
    if (!file.endsWith('.md')) continue
    try {
      const raw = await readVaultFile(`${folder}/${file}`)
      templates.push({
        name: file.replace(/\.md$/, ''),
        body: splitFrontmatter(raw).body.trim(),
      })
    } catch {
      // Unreadable template — skip it rather than fail the whole load.
    }
  }
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

/** Load the vault's templates and push them into the slash menu's item list.
 * Called on editor mount so `/` surfaces the current templates. Cheap; safe to
 * call repeatedly. */
export async function refreshTemplateSlashItems(): Promise<void> {
  const templates = await loadTemplates()
  setTemplateSlashItems(templates.map(templateSlashItem))
}

/** Default folder the one-click setup creates. */
export const STARTER_TEMPLATES_FOLDER = 'templates'

const GUIDE_FILENAME = '템플릿 안내.md'

// A single onboarding page: a variable cheatsheet + copyable examples, all
// inside code fences so the tokens stay literal (they read as documentation,
// not values, even if the page itself is inserted). Built line-by-line so the
// ``` fences don't need backtick-escaping inside a JS template literal.
const GUIDE_BODY = [
  '# 템플릿 사용법',
  '',
  '이 폴더(`templates/`)의 `.md` 파일이 템플릿이 됩니다.',
  '에디터에서 `/` 로 커서 위치에 삽입하거나, `⌘K` → "New from template" 로 새 노트를 만들 수 있어요.',
  '',
  '삽입할 때 아래 변수는 자동으로 채워집니다.',
  '',
  '## 쓸 수 있는 변수',
  '```',
  '{{today}}       오늘 날짜        (예: 2026-07-14)',
  '{{tomorrow}}    내일',
  '{{yesterday}}   어제',
  '{{now}}         현재 시각        (예: 09:05)',
  '{{this-week}}   이번 주 월요일',
  '{{next-week}}   다음 주 월요일',
  '{{cursor}}      삽입 후 커서가 놓일 자리',
  '```',
  '',
  '아래 예시를 복사해 새 `.md` 파일로 저장하면 바로 나만의 템플릿이 됩니다.',
  '',
  '## 예시 — 회의록',
  '```markdown',
  '## {{today}} 회의록',
  '',
  '**참석자:** ',
  '**안건:** ',
  '',
  '### 논의',
  '{{cursor}}',
  '',
  '### 결정 / 액션',
  '- ',
  '```',
  '',
  '## 예시 — 할 일',
  '```markdown',
  '## {{today}} 할 일',
  '',
  '- [ ] {{cursor}}',
  '- [ ] ',
  '```',
  '',
  '## 예시 — 주간 계획',
  '```markdown',
  '## 주간 계획',
  '',
  '이번 주: [[{{this-week}}]]',
  '다음 주: [[{{next-week}}]]',
  '',
  '### 목표',
  '{{cursor}}',
  '```',
  '',
].join('\n')

/** One-click setup: create the `templates/` folder and seed the onboarding
 * guide page (skipped if it already exists — never overwrites). Idempotent.
 * The caller points the setting at the folder afterwards. */
export async function seedStarterTemplates(): Promise<void> {
  await createVaultFolder(STARTER_TEMPLATES_FOLDER)
  const guidePath = `${STARTER_TEMPLATES_FOLDER}/${GUIDE_FILENAME}`
  if (!(await vaultFileExists(guidePath))) {
    await writeVaultFile(guidePath, GUIDE_BODY)
  }
}
