import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'src/main/runtime/wrapper.cjs')
const target = join(root, 'out/main/wrapper.cjs')
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(`runtime wrapper copied: ${target}`)
