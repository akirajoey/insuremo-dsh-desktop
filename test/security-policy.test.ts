import { describe, expect, it } from 'vitest'
import {
  ABOUT_CONTENT_SECURITY_POLICY,
  authorizeIpc,
  decideNavigation,
} from '../src/main/security/policy'

const sender = {}
const frame = {}
const context = {
  sender,
  expectedSender: sender,
  senderFrame: frame,
  mainFrame: frame,
  frameUrl: 'file:///app/out/renderer/about/index.html',
  expectedUrl: 'file:///app/out/renderer/about/index.html',
  capability: 'about:read',
  expectedCapability: 'about:read',
  destroyed: false,
}

describe('IPC authorization', () => {
  it('accepts only the expected main-frame capability', () => {
    expect(authorizeIpc(context)).toBe(true)
  })

  it.each([
    ['wrong sender', { sender: {} }],
    ['wrong frame', { senderFrame: {} }],
    ['subframe', { senderFrame: null }],
    ['wrong URL', { frameUrl: 'file:///app/other.html' }],
    ['wrong capability', { capability: 'runtime:restart' }],
    ['destroyed window', { destroyed: true }],
  ])('rejects %s', (_label, change) => {
    expect(authorizeIpc({ ...context, ...change })).toBe(false)
  })
})

describe('navigation policy', () => {
  it('allows only the exact application page', () => {
    expect(decideNavigation(context.expectedUrl, context.expectedUrl)).toBe('allow')
    expect(decideNavigation('file:///app/out/renderer/other.html', context.expectedUrl)).toBe('deny')
  })

  it('opens external HTTPS in the system browser', () => {
    expect(decideNavigation('https://example.test/docs', context.expectedUrl)).toBe('external')
    expect(decideNavigation('http://example.test/docs', context.expectedUrl)).toBe('deny')
  })
})

describe('content security policy', () => {
  it('denies object, frame, ancestor embedding, and remote scripts', () => {
    expect(ABOUT_CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
    expect(ABOUT_CONTENT_SECURITY_POLICY).toContain("frame-src 'none'")
    expect(ABOUT_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
    expect(ABOUT_CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(ABOUT_CONTENT_SECURITY_POLICY).not.toContain('script-src \'self\' http:')
  })
})
