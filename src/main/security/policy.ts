export const ABOUT_CAPABILITY = 'about:read'

export type IpcAuthorizationContext = {
  sender: object
  expectedSender: object
  senderFrame: object | null
  mainFrame: object
  frameUrl: string
  expectedUrl: string
  capability: string
  expectedCapability: string
  destroyed: boolean
}

export function isExactUrl(candidate: string, expected: string): boolean {
  try {
    return new URL(candidate).href === new URL(expected).href
  } catch {
    return false
  }
}

export function authorizeIpc(context: IpcAuthorizationContext): boolean {
  return !context.destroyed
    && context.sender === context.expectedSender
    && context.senderFrame === context.mainFrame
    && context.capability === context.expectedCapability
    && isExactUrl(context.frameUrl, context.expectedUrl)
}

export type NavigationDecision = 'allow' | 'external' | 'deny'

export function decideNavigation(url: string, expectedUrl: string): NavigationDecision {
  if (isExactUrl(url, expectedUrl)) return 'allow'
  try {
    return new URL(url).protocol === 'https:' ? 'external' : 'deny'
  } catch {
    return 'deny'
  }
}

export const ABOUT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://localhost:*",
].join('; ')
