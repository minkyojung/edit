import { z } from 'zod'

export const TAGS = ['new', 'improved', 'fixed', 'api'] as const
export type Tag = (typeof TAGS)[number]

export const frontmatterSchema = z.object({
  title: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  description: z.string().min(1).max(200),
  tags: z.array(z.enum(TAGS)).default([]),
  author: z
    .object({
      name: z.string(),
      avatar: z.string().optional(),
    })
    .optional(),
  image: z.string().optional(),
  draft: z.boolean().default(false),
})

export type Frontmatter = z.infer<typeof frontmatterSchema>

export type Entry = Frontmatter & {
  slug: string
  Component: React.ComponentType
}
