import { describe, expect, it } from 'vitest'
import { classifyAsset, isAttachmentFile } from './attachments'

describe('isAttachmentFile', () => {
  it('accepts ordinary non-md files', () => {
    expect(isAttachmentFile('inbox/photo.png')).toBe(true)
    expect(isAttachmentFile('doc.pdf')).toBe(true)
    expect(isAttachmentFile('notes/clip.mp4')).toBe(true)
  })

  it('rejects markdown notes (they have their own rows)', () => {
    expect(isAttachmentFile('wiki/Tom.md')).toBe(false)
  })

  it('rejects dot-dirs and dot-files', () => {
    expect(isAttachmentFile('.git/config')).toBe(false)
    expect(isAttachmentFile('inbox/.DS_Store')).toBe(false)
  })

  it('rejects app sidecars and atomic-write temps', () => {
    expect(isAttachmentFile('wiki/Tom.meta.json')).toBe(false)
    expect(isAttachmentFile('wiki/Tom.marks.json')).toBe(false)
    expect(isAttachmentFile('wiki/Tom.ydoc')).toBe(false)
    expect(isAttachmentFile('wiki/Tom.md.tmp')).toBe(false)
  })
})

describe('classifyAsset', () => {
  it('classifies by extension, case-insensitive', () => {
    expect(classifyAsset('a.PNG')).toBe('image')
    expect(classifyAsset('a.jpeg')).toBe('image')
    expect(classifyAsset('report.pdf')).toBe('pdf')
    expect(classifyAsset('song.mp3')).toBe('audio')
    expect(classifyAsset('clip.MOV')).toBe('video')
    expect(classifyAsset('data.json')).toBe('text')
    expect(classifyAsset('notes.txt')).toBe('text')
  })

  it('falls back to other for unknown / extensionless', () => {
    expect(classifyAsset('archive.zip')).toBe('other')
    expect(classifyAsset('Makefile')).toBe('other')
  })

  it('uses the last dot for multi-dot names', () => {
    expect(classifyAsset('my.backup.png')).toBe('image')
  })
})
