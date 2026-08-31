/**
 * Shared dev-path needle matcher for the E07/E08 packaged-artifact scans.
 *
 * `/opt/homebrew` uses a strict allowlist: only the complete standard PATH
 * fragments `/opt/homebrew/bin` and `/opt/homebrew/sbin` followed by a
 * separator boundary (any character outside [A-Za-z0-9_-], e.g. `:`, `/`,
 * quote, newline, or end of text) are accepted, so the macOS standard-PATH
 * fallback constants in shipped code do not trip the scan. Every other
 * occurrence — bare `/opt/homebrew`, `/opt/homebrew/lib/node_modules`,
 * `/opt/homebrew/bin-custom`, `/opt/homebrew/binary`, … — is a finding.
 * All other needles are exact substring matches, unchanged.
 */
const HOMEBREW_ALLOWED = ['/opt/homebrew/bin', '/opt/homebrew/sbin']
const BOUNDARY = /[^A-Za-z0-9_-]/

export function textMatchesDevPathNeedle(text, needle) {
  if (needle !== '/opt/homebrew') return text.includes(needle)
  let position = text.indexOf(needle)
  while (position !== -1) {
    const allowed = HOMEBREW_ALLOWED.find(fragment => text.startsWith(fragment, position) && (position + fragment.length === text.length || BOUNDARY.test(text[position + fragment.length])))
    if (allowed === undefined) return true
    position = text.indexOf(needle, position + allowed.length)
  }
  return false
}
