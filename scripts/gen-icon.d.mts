export declare const ICON_SOURCE: string
export declare const ICON_SOURCE_SHA256: string
export declare const ICON_SOURCE_ARCHIVE: string
export declare const ICON_SOURCE_ARCHIVE_SHA256: string
export declare const ICON_SOURCE_SIZE: number
export declare const ICON_PNG_SIZE: number
export declare const ICO_LADDER: number[]
export declare const ICON_DERIVATIVE_SHA256: Record<number, string>
export declare function sha256(bytes: Buffer): string
export declare function pngInfo(bytes: Buffer): { width: number; height: number; bitDepth: number; colorType: number; compression: number; filter: number; interlace: number }
export declare function pngSize(bytes: Buffer): { width: number; height: number }
export declare function decodePngPixels(bytes: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Buffer }
export declare function pngAlphaAt(bytes: Buffer, x: number, y: number): number
export declare function verifyDesignAssets(): { sourceBytes: Buffer; ladder: Record<number, Buffer>; sourceSha256: string; archiveSha256: string }
export declare function assembleIco(entries: Array<{ size: number; bytes: Buffer }>): Buffer
