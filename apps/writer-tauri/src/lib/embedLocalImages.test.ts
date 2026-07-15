import { describe, expect, it } from 'vitest'
import { embedLocalImages } from './embedLocalImages'

// The base64 read path needs the Tauri fs runtime + a vault, so it's
// verified in-app. Here we pin the filtering logic: portable srcs must
// be left untouched (and the no-local-images case returns the same
// string so callers can skip a clipboard re-write).
describe('embedLocalImages', () => {
  it('leaves html without images unchanged', async () => {
    const html = '<h2>Title</h2><p>no images here</p>'
    expect(await embedLocalImages(html)).toBe(html)
  })

  it('leaves remote http(s) images untouched', async () => {
    const html = '<p><img src="https://example.com/a.png" alt="x"></p>'
    expect(await embedLocalImages(html)).toBe(html)
  })

  it('leaves data: URIs untouched', async () => {
    const html = '<p><img src="data:image/png;base64,AAAA"></p>'
    expect(await embedLocalImages(html)).toBe(html)
  })
})
