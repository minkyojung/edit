import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARTIFACT_CSP,
  buildArtifactSrcdoc,
  buildArtifactThemeCss,
} from './artifactDocument'

const NONCE = 'test-nonce-123'

function build(html: string, nonce = NONCE) {
  return buildArtifactSrcdoc({ html, nonce, themeCss: ':root{--foreground:rgb(0,0,0);}' })
}

describe('buildArtifactSrcdoc — CSP enforcement', () => {
  it('places the CSP meta as the first child of <head>', () => {
    const out = build('<div>hi</div>')
    expect(out).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`,
    )
  })

  it('locks down network and nested frames in the CSP', () => {
    expect(ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(ARTIFACT_CSP).toContain("frame-src 'none'")
    expect(ARTIFACT_CSP).toContain("default-src 'none'")
    // inline scripts allowed (opaque origin makes this safe) but NOT eval
    expect(ARTIFACT_CSP).toContain("script-src 'unsafe-inline'")
    expect(ARTIFACT_CSP).not.toContain('unsafe-eval')
  })
})

describe('buildArtifactSrcdoc — defensive sanitation', () => {
  it('strips an AI-authored CSP meta so ours stays authoritative', () => {
    const out = build(
      '<meta http-equiv="Content-Security-Policy" content="default-src *"><div>x</div>',
    )
    expect(out).not.toContain('default-src *')
    // ours is still present
    expect(out).toContain(ARTIFACT_CSP)
  })

  it('strips an AI-authored <base> tag', () => {
    const out = build('<base href="http://evil.example"><div>x</div>')
    expect(out).not.toContain('http://evil.example')
    expect(out).toContain('<base target="_blank">')
  })

  it('strips an AI-authored viewport meta (ours is authoritative)', () => {
    const out = build('<meta name="viewport" content="width=99"><div>x</div>')
    expect(out).not.toContain('width=99')
  })
})

describe('buildArtifactSrcdoc — full-document flattening', () => {
  it('keeps <head> styles and body content but emits a single <body>', () => {
    const out = build(
      '<!DOCTYPE html><html><head><style>.k{color:red}</style></head><body><div>cell</div></body></html>',
    )
    expect(out).toContain('.k{color:red}') // head style preserved
    expect(out).toContain('<div>cell</div>') // body content preserved
    // exactly one html/body wrapper (ours); the input's structural tags were
    // flattened away rather than duplicated
    expect(out.match(/<body>/g)).toHaveLength(1)
    expect(out.match(/<html>/g)).toHaveLength(1)
  })

  it('passes a bare fragment through unchanged', () => {
    const out = build('<p>just a fragment</p>')
    expect(out).toContain('<p>just a fragment</p>')
  })
})

describe('buildArtifactSrcdoc — height reporter', () => {
  it('injects the reporter after body content (last before </body>)', () => {
    const out = build('<div id="marker">content</div>')
    expect(out).toContain("source:'artifact-frame'")
    expect(out.indexOf('artifact-frame')).toBeGreaterThan(out.indexOf('id="marker"'))
  })

  it('JSON-encodes the nonce so quotes cannot break out of the script', () => {
    const out = build('<div>x</div>', 'a"b\'c')
    expect(out).toContain(JSON.stringify('a"b\'c')) // "a\"b'c"
    // the raw unencoded nonce must not appear as a bare token
    expect(out).not.toContain('=a"b\'c;')
  })
})

describe('buildArtifactThemeCss', () => {
  afterEach(() => vi.restoreAllMocks())

  it('emits a :root block of resolved rgb() tokens plus the font stack', () => {
    // jsdom cannot resolve var()/oklch, so stub the browser color/font readout.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      color: 'rgb(1, 2, 3)',
      fontFamily: 'Pretendard, sans-serif',
    } as unknown as CSSStyleDeclaration)

    const css = buildArtifactThemeCss()
    expect(css.startsWith(':root{')).toBe(true)
    expect(css).toContain('--foreground:rgb(1, 2, 3);')
    expect(css).toContain('--art-font-sans:Pretendard, sans-serif;')
  })
})
