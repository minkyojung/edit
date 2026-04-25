import type { ComponentType } from 'react'
import { frontmatterSchema, type Entry } from './schema'

type MdxModule = {
  default: ComponentType
  frontmatter: unknown
}

const modules = import.meta.glob<MdxModule>('./posts/*.mdx', { eager: true })

function deriveSlug(filePath: string): string {
  const file = filePath.split('/').pop() ?? filePath
  const base = file.replace(/\.mdx$/, '')
  // strip leading YYYY-MM-DD- prefix if present
  return base.replace(/^\d{4}-\d{2}-\d{2}-/, '')
}

export const entries: Entry[] = Object.entries(modules)
  .map(([filePath, mod]) => {
    const parsed = frontmatterSchema.safeParse(mod.frontmatter)
    if (!parsed.success) {
      throw new Error(
        `Invalid frontmatter in ${filePath}: ${parsed.error.message}`,
      )
    }
    return {
      ...parsed.data,
      slug: deriveSlug(filePath),
      Component: mod.default,
    }
  })
  .filter((e) => !e.draft)
  .sort((a, b) => (a.date < b.date ? 1 : -1))

export function findEntry(slug: string): Entry | undefined {
  return entries.find((e) => e.slug === slug)
}
