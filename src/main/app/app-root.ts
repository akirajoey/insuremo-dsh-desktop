import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

let cachedRoot: string | undefined

/**
 * Locate the application root (the directory containing package.json) by
 * walking up from this module. Works from the source tree (src/main/**),
 * the build output (out/main/**), and test files alike.
 */
export function appRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot
  let dir = import.meta.dirname
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('application root not found')
}
