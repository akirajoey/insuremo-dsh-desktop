import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_LOCALE = /^(?:Base|en(?:[-_].*)?|zh(?:[-_].*)?)\.lproj$/iu

/**
 * Keep the UI locale contract small after electron-builder has laid out the
 * signed app. This runs before signing; it never touches runtime package
 * resources and is a no-op for non-Darwin targets.
 */
export async function pruneLocales(context) {
  if (context.electronPlatformName !== 'darwin') return
  const contents = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
  const roots = [join(contents, 'Resources'), join(contents, 'Frameworks')]
  let removed = 0
  removed += pruneRoot(roots[0], false)
  removed += pruneRoot(roots[1], true)
  if (removed > 0) console.log(JSON.stringify({ localePrune: true, removed }))
}

export default pruneLocales

function pruneRoot(root, deep) {
  if (!existsSync(root)) return 0
  let removed = 0
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    if (/\.lproj$/iu.test(name) && !KEEP_LOCALE.test(name)) {
      rmSync(path, { recursive: true, force: true })
      removed += 1
    } else if (deep) {
      removed += pruneRoot(path, true)
    }
  }
  return removed
}
