import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Shared verified-Workbench artifact locator for tests and electron probes.
 * Never hardcodes a host-absolute path: DSH_WORKBENCH_TGZ overrides for CI,
 * otherwise the sibling checkout's dist-release artifact is used.
 */
export const WORKBENCH_TGZ = process.env.DSH_WORKBENCH_TGZ
  ?? resolve(process.cwd(), '../icomposer-workbench/dist-release/icomposer-workbench-0.1.0.tgz')

export const WORKBENCH_SHA256 = 'b1019017b79782a97b0b980268c2250384446ae5bbed8cb62af41c0754bdc59f'

export function ensureWorkbenchTgz(): string {
  if (!existsSync(WORKBENCH_TGZ)) {
    throw new Error(`verified Workbench artifact not found; set DSH_WORKBENCH_TGZ or build ../icomposer-workbench dist-release`)
  }
  return WORKBENCH_TGZ
}
