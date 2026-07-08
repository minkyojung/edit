import { describe, expect, it } from 'vitest'
import { planFolderMove } from './folderMove'

describe('planFolderMove', () => {
  it('moves a nested folder into another folder (leaf name kept)', () => {
    expect(planFolderMove('a/b', 'c')).toEqual({ kind: 'move', newPath: 'c/b' })
  })

  it('moves a folder to the vault root (empty destParent)', () => {
    expect(planFolderMove('a/b', '')).toEqual({ kind: 'move', newPath: 'b' })
  })

  it('rejects dropping a folder onto itself', () => {
    expect(planFolderMove('a/b', 'a/b')).toEqual({ kind: 'reject' })
  })

  it('rejects dropping a folder into its own descendant', () => {
    expect(planFolderMove('a', 'a/b')).toEqual({ kind: 'reject' })
    expect(planFolderMove('wiki', 'wiki/Projects/2026')).toEqual({ kind: 'reject' })
  })

  it('no-ops when the folder already sits under that parent', () => {
    expect(planFolderMove('a/b', 'a')).toEqual({ kind: 'noop' })
  })

  it('no-ops when a root folder is dropped back on the root', () => {
    expect(planFolderMove('a', '')).toEqual({ kind: 'noop' })
  })

  it('does NOT reject a sibling whose name prefixes the dragged path', () => {
    // 'a' is not a descendant of 'a/b' — the `/` boundary matters so
    // `ab` / `a-b` style siblings aren't mistaken for children.
    expect(planFolderMove('a/b', 'ab')).toEqual({ kind: 'move', newPath: 'ab/b' })
  })
})
