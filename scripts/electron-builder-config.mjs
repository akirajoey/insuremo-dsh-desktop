import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pruneLocales } from './prune-e07-locales.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const variant = process.env.DSH_DESKTOP_VARIANT ?? 'full'
if (variant !== 'full' && variant !== 'thin') throw new Error(`unsupported DSH_DESKTOP_VARIANT: ${variant}`)
const label = variant === 'full' ? 'Full' : 'Thin'

export default {
  appId: 'com.insuremo.dsh.desktop',
  productName: 'InsureMO DSH Desktop',
  asar: false,
  files: [
    'out/**/*',
    'config/runtime-pins.json',
    'compatibility.json',
    'build/icon.png',
    'build/icon.ico',
    'build/variant-marker.json',
    'package.json',
  ],
  directories: { output: 'release' },
  electronLanguages: ['en', 'zh_CN', 'zh_TW'],
  beforePack: async () => {
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build/variant-marker.json'), JSON.stringify({
      schemaVersion: 1,
      variant,
      appId: 'com.insuremo.dsh.desktop',
      runtimeSource: variant === 'full' ? 'embedded' : 'external',
    }, null, 2) + '\n')
  },
  afterPack: async context => pruneLocales(context),
  artifactName: 'InsureMO DSH Desktop-' + label + '-${version}-${arch}.${ext}',
  mac: {
    hardenedRuntime: true,
    gatekeeperAssess: false,
    extraResources: variant === 'full' ? [{ from: 'packaging/e07/runtime', to: 'dsh-runtime' }] : [],
    target: ['dmg', 'zip'],
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    signAndEditExecutable: true,
    signExts: ['.exe', '.dll', '.node'],
    requestedExecutionLevel: 'asInvoker',
    verifyUpdateCodeSignature: true,
    extraResources: [{ from: 'packaging/e08/runtime', to: 'dsh-runtime' }],
  },
}
