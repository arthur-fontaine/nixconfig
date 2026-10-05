// Thumbnails for terminals without a graphics protocol (Zed's): each cell is
// an upper half block whose foreground is one pixel and background the pixel
// below it, so a tile `columns` wide and `rows` tall shows columns × 2·rows
// pixels.

export type Bitmap = { width: number; height: number; rgba: Uint8Array }

const UPPER_HALF = 0x2580
const DEFAULT_COLOR = 0x01000000

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0))
}

function channel(pixel: number, mask: number): number {
  if (mask === 0) return 255
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  return Math.round((((pixel & mask) >>> shift) * 255) / (mask >>> shift))
}

/** Top-down RGBA pixels from a 24- or 32-bit uncompressed BMP, as `sips -s format bmp` writes it. */
export function parseBmp(base64: string): Bitmap | null {
  const bytes = bytesOf(base64)
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const signedHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  const height = Math.abs(signedHeight)
  if (width <= 0 || height === 0 || (bpp !== 24 && bpp !== 32)) return null

  // BI_RGB (0) is BGR(A); BI_BITFIELDS (3) and BI_ALPHABITFIELDS (6) give masks.
  let masks = { r: 0xff0000, g: 0xff00, b: 0xff, a: 0 }
  if (compression === 3 || compression === 6) {
    masks = {
      r: view.getUint32(54, true),
      g: view.getUint32(58, true),
      b: view.getUint32(62, true),
      a: view.getUint32(14, true) >= 56 ? view.getUint32(66, true) : 0,
    }
  } else if (compression !== 0) {
    return null
  }

  const stride = Math.ceil((width * bpp) / 32) * 4
  if (offset + stride * height > bytes.length) return null
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    // A positive height stores the bottom row first.
    const row = offset + stride * (signedHeight > 0 ? height - 1 - y : y)
    for (let x = 0; x < width; x++) {
      const at = row + (x * bpp) / 8
      const pixel = bpp === 32 ? view.getUint32(at, true) : bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
      const out = (y * width + x) * 4
      rgba[out] = channel(pixel, masks.r)
      rgba[out + 1] = channel(pixel, masks.g)
      rgba[out + 2] = channel(pixel, masks.b)
      rgba[out + 3] = channel(pixel, masks.a)
    }
  }
  return { width, height, rgba }
}

function color(bitmap: Bitmap, x: number, y: number): number {
  const at = (y * bitmap.width + x) * 4
  // Transparent pixels show the terminal's own background.
  if (bitmap.rgba[at + 3] < 128) return DEFAULT_COLOR
  return (bitmap.rgba[at] << 16) | (bitmap.rgba[at + 1] << 8) | bitmap.rgba[at + 2]
}

/** A Raster's `cells` for a bitmap already sized to columns × 2·rows pixels. */
export function halfBlockCells(bitmap: Bitmap, columns: number, rows: number): string | null {
  if (bitmap.width !== columns || bitmap.height !== rows * 2) return null
  const words = new DataView(new ArrayBuffer(columns * rows * 12))
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < columns; x++) {
      const at = (row * columns + x) * 12
      words.setUint32(at, UPPER_HALF, true)
      words.setUint32(at + 4, color(bitmap, x, row * 2), true)
      words.setUint32(at + 8, color(bitmap, x, row * 2 + 1), true)
    }
  }
  const bytes = new Uint8Array(words.buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
