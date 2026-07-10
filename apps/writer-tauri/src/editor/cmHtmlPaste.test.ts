import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { inCodeContext } from './cmHtmlPaste'

function stateFor(doc: string) {
  return EditorState.create({ doc, extensions: [markdown()] })
}

describe('inCodeContext', () => {
  it('is false in ordinary prose', () => {
    const state = stateFor('hello world')
    expect(inCodeContext(state, 3)).toBe(false)
  })

  it('is true inside a fenced code block', () => {
    const doc = '```\nconst x = 1\n```'
    const state = stateFor(doc)
    // position on the `const x = 1` line
    const pos = doc.indexOf('const') + 2
    expect(inCodeContext(state, pos)).toBe(true)
  })

  it('is true inside inline code', () => {
    const doc = 'use `npm install` here'
    const state = stateFor(doc)
    const pos = doc.indexOf('npm') + 1
    expect(inCodeContext(state, pos)).toBe(true)
  })
})
