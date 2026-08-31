export declare const FIXTURE_SOURCE_DIR: string
export declare const FIXTURE_PACKAGE_NAME: string
export declare function buildFixtureTar(fixtureDir?: string): Buffer
export declare function ensureTestPluginTgz(targetPath?: string): { path: string; sha256: string; stat: number }
