/**
 * Read and write the DPI (dots per inch) recorded in an image file's header.
 *
 * DPI is metadata, not pixels. It tells a printer or a layout program how large
 * to print the pixels that are already there, so changing it adds no detail and
 * barely changes the file size. Everything here therefore works on raw bytes and
 * never decodes or re-encodes the image: the pixel data comes out byte-identical
 * and EXIF survives untouched. (Going through a canvas would lose both, see the
 * note about `imageOrientation` in lib/local-image-convert.ts.)
 *
 * JPEG records density in two places and real readers disagree about which wins:
 *   - the JFIF APP0 segment (units, X density, Y density)
 *   - EXIF XResolution / YResolution / ResolutionUnit, which is what Photoshop
 *     and Windows Explorer report
 * Both are written whenever both are present, so no two programs disagree.
 *
 * PNG records it once, in the pHYs chunk, as pixels per metre.
 *
 * WebP has no standard density field at all, so it is rejected rather than
 * silently accepted and returned unchanged.
 */

export type DpiFormat = "jpeg" | "png"

export interface DpiInfo {
  /** Horizontal DPI, rounded. 0 when the file records none. */
  x: number
  /** Vertical DPI, rounded. 0 when the file records none. */
  y: number
  /** Which header the value came from. "none" means the file declares no density. */
  source: "jfif" | "exif" | "phys" | "none"
}

/** Thrown for inputs this module deliberately does not handle. */
export class UnsupportedDpiFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsupportedDpiFormatError"
  }
}

const INCH_IN_METRES = 0.0254

/** Lowest and highest DPI the UI accepts. Outside this range the value is meaningless. */
export const MIN_DPI = 1
export const MAX_DPI = 9600

// --- format sniffing ---------------------------------------------------------

function isJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && PNG_SIG.every((v, i) => b[i] === v)
}

/**
 * Identify the container, or explain why it is not supported. Detection is by
 * magic bytes, never by file extension or the browser-supplied MIME type.
 */
export function detectDpiFormat(buf: ArrayBuffer): DpiFormat {
  const b = new Uint8Array(buf)
  if (isJpeg(b)) return "jpeg"
  if (isPng(b)) return "png"
  if (b.length > 12 && String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP") {
    throw new UnsupportedDpiFormatError(
      "WebP has no standard DPI field, so there is nothing to set. Convert it to JPG or PNG first."
    )
  }
  throw new UnsupportedDpiFormatError("Only JPG and PNG files carry a DPI value this tool can change.")
}

// --- JPEG --------------------------------------------------------------------

interface JpegSegment { marker: number; start: number; dataStart: number; dataEnd: number }

/**
 * Walk the JPEG marker segments up to the start of scan. Entropy-coded data
 * follows SOS and must not be parsed as markers.
 */
function jpegSegments(b: Uint8Array): JpegSegment[] {
  const out: JpegSegment[] = []
  let i = 2 // skip SOI
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) break
    const marker = b[i + 1]
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    if (marker === 0xda || marker === 0xd9) break // SOS / EOI: stop before entropy data
    const len = (b[i + 2] << 8) | b[i + 3]
    if (len < 2) break
    out.push({ marker, start: i, dataStart: i + 4, dataEnd: i + 2 + len })
    i += 2 + len
  }
  return out
}

function isJfifApp0(b: Uint8Array, seg: JpegSegment): boolean {
  if (seg.marker !== 0xe0 || seg.dataEnd - seg.dataStart < 14) return false
  const d = seg.dataStart
  return b[d] === 0x4a && b[d + 1] === 0x46 && b[d + 2] === 0x49 && b[d + 3] === 0x46 && b[d + 4] === 0x00
}

function isExifApp1(b: Uint8Array, seg: JpegSegment): boolean {
  if (seg.marker !== 0xe1 || seg.dataEnd - seg.dataStart < 14) return false
  const d = seg.dataStart
  return (
    b[d] === 0x45 && b[d + 1] === 0x78 && b[d + 2] === 0x69 && b[d + 3] === 0x66 &&
    b[d + 4] === 0x00 && b[d + 5] === 0x00
  )
}

function readJfifDpi(b: Uint8Array, seg: JpegSegment): DpiInfo | null {
  const d = seg.dataStart
  const units = b[d + 7]
  const view = new DataView(b.buffer, b.byteOffset)
  const x = view.getUint16(d + 8)
  const y = view.getUint16(d + 10)
  if (units === 0 || x === 0 || y === 0) return null // 0 = aspect ratio only, no real density
  const k = units === 2 ? 2.54 : 1 // 2 = dots per cm
  return { x: Math.round(x * k), y: Math.round(y * k), source: "jfif" }
}

interface TiffResolution {
  be: boolean
  xOff: number | null
  yOff: number | null
  unitOff: number | null
  view: DataView
}

/**
 * Locate the three resolution tags inside a TIFF block, given the offset of its
 * byte-order mark. Returns absolute offsets into `b` so callers can patch in
 * place. Only IFD0 is searched, which is where every writer puts them.
 *
 * Shared by JPEG (the EXIF APP1 segment, after its "Exif\0\0" prefix) and PNG
 * (the eXIf chunk, which holds a bare TIFF block with no prefix).
 */
function findTiffResolution(b: Uint8Array, tiff: number): TiffResolution | null {
  if (tiff + 8 > b.length) return null
  const be = b[tiff] === 0x4d && b[tiff + 1] === 0x4d
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49
  if (!be && !le) return null
  const view = new DataView(b.buffer, b.byteOffset)
  const u16 = (o: number) => view.getUint16(o, !be)
  const u32 = (o: number) => view.getUint32(o, !be)
  if (u16(tiff + 2) !== 0x002a) return null

  const ifd0 = tiff + u32(tiff + 4)
  if (ifd0 + 2 > b.length) return null
  const count = u16(ifd0)
  let xOff: number | null = null
  let yOff: number | null = null
  let unitOff: number | null = null

  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > b.length) break
    const tag = u16(entry)
    if (tag === 0x011a || tag === 0x011b) {
      // RATIONAL: the value field holds an offset, relative to the TIFF header.
      const at = tiff + u32(entry + 8)
      if (at + 8 <= b.length) { if (tag === 0x011a) xOff = at; else yOff = at }
    } else if (tag === 0x0128) {
      unitOff = entry + 8 // SHORT: stored inline in the value field
    }
  }
  if (xOff === null && yOff === null) return null
  return { be, xOff, yOff, unitOff, view }
}

/** Offset of the TIFF block inside an EXIF APP1 segment, past its "Exif\0\0" prefix. */
const exifTiffStart = (seg: JpegSegment) => seg.dataStart + 6

/** Overwrite the resolution tags a `findTiffResolution` result points at. */
function patchTiffResolution(out: Uint8Array, f: TiffResolution, dpi: number): void {
  const w = new DataView(out.buffer, out.byteOffset)
  const put = (o: number | null) => {
    if (o === null) return
    w.setUint32(o, dpi, !f.be)
    w.setUint32(o + 4, 1, !f.be)
  }
  put(f.xOff)
  put(f.yOff)
  if (f.unitOff !== null) w.setUint16(f.unitOff, 2, !f.be) // 2 = inches
}

function readTiffDpi(f: TiffResolution | null): DpiInfo | null {
  if (!f || f.xOff === null) return null
  const { be, view } = f
  const unit = f.unitOff === null ? 2 : view.getUint16(f.unitOff, !be)
  if (unit === 1) return null // 1 = no absolute unit, the value is only a ratio
  const rational = (o: number) => {
    const num = view.getUint32(o, !be)
    const den = view.getUint32(o + 4, !be)
    return den === 0 ? 0 : num / den
  }
  const k = unit === 3 ? 2.54 : 1 // 3 = per centimetre
  const x = rational(f.xOff) * k
  const y = f.yOff === null ? x : rational(f.yOff) * k
  if (x <= 0) return null
  return { x: Math.round(x), y: Math.round(y), source: "exif" }
}

/** Build a complete 18-byte JFIF APP0 segment (marker included) for `dpi`. */
function buildJfifApp0(dpi: number): Uint8Array {
  const s = new Uint8Array(18)
  const v = new DataView(s.buffer)
  s[0] = 0xff; s[1] = 0xe0
  v.setUint16(2, 16) // segment length, excluding the marker
  s[4] = 0x4a; s[5] = 0x46; s[6] = 0x49; s[7] = 0x46; s[8] = 0x00 // "JFIF\0"
  s[9] = 1; s[10] = 1 // version 1.1
  s[11] = 1 // units: dots per inch
  v.setUint16(12, dpi)
  v.setUint16(14, dpi)
  s[16] = 0; s[17] = 0 // no embedded thumbnail
  return s
}

function setJpegDpi(b: Uint8Array, dpi: number): Uint8Array {
  const segments = jpegSegments(b)
  const out = new Uint8Array(b) // copy; the input is never mutated
  const view = new DataView(out.buffer)

  const jfif = segments.find((s) => isJfifApp0(b, s))
  if (jfif) {
    out[jfif.dataStart + 7] = 1 // units: dots per inch
    view.setUint16(jfif.dataStart + 8, dpi)
    view.setUint16(jfif.dataStart + 10, dpi)
  }

  // Photoshop and Windows read EXIF, so keep it in step when it is present.
  const exif = segments.find((s) => isExifApp1(b, s))
  if (exif) {
    const f = findTiffResolution(out, exifTiffStart(exif))
    if (f) patchTiffResolution(out, f, dpi)
  }

  if (jfif) return out

  // No JFIF segment: insert one directly after SOI. APP0 must come first, so any
  // existing APP1 shifts along behind it.
  const seg = buildJfifApp0(dpi)
  const grown = new Uint8Array(out.length + seg.length)
  grown.set(out.subarray(0, 2), 0)
  grown.set(seg, 2)
  grown.set(out.subarray(2), 2 + seg.length)
  return grown
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 as PNG defines it, over the chunk type plus its data. */
export function pngCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface PngChunk { type: string; start: number; dataStart: number; length: number; end: number }

function pngChunks(b: Uint8Array): PngChunk[] {
  const out: PngChunk[] = []
  const view = new DataView(b.buffer, b.byteOffset)
  let i = 8
  while (i + 8 <= b.length) {
    const length = view.getUint32(i)
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7])
    const end = i + 12 + length
    if (end > b.length) break
    out.push({ type, start: i, dataStart: i + 8, length, end })
    if (type === "IEND") break
    i = end
  }
  return out
}

const dpiToPpu = (dpi: number) => Math.round(dpi / INCH_IN_METRES)
const ppuToDpi = (ppu: number) => Math.round(ppu * INCH_IN_METRES)

function readPngDpi(b: Uint8Array): DpiInfo | null {
  const chunks = pngChunks(b)
  const phys = chunks.find((c) => c.type === "pHYs")
  if (!phys || phys.length !== 9) {
    // No pHYs, but a PNG written by libvips or Photoshop may still declare a
    // resolution inside its eXIf chunk.
    const exif = chunks.find((c) => c.type === "eXIf")
    return exif ? readTiffDpi(findTiffResolution(b, exif.dataStart)) : null
  }
  const view = new DataView(b.buffer, b.byteOffset)
  const unit = b[phys.dataStart + 8]
  if (unit !== 1) return null // 0 = unknown unit, the values are only a ratio
  const x = ppuToDpi(view.getUint32(phys.dataStart))
  const y = ppuToDpi(view.getUint32(phys.dataStart + 4))
  if (x <= 0) return null
  return { x, y, source: "phys" }
}

/** Build a complete pHYs chunk: length, type, data and CRC. */
function buildPhys(dpi: number): Uint8Array {
  const chunk = new Uint8Array(21)
  const v = new DataView(chunk.buffer)
  v.setUint32(0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // "pHYs"
  v.setUint32(8, dpiToPpu(dpi))
  v.setUint32(12, dpiToPpu(dpi))
  chunk[16] = 1 // unit: metre
  v.setUint32(17, pngCrc32(chunk.subarray(4, 17)))
  return chunk
}

/**
 * Rewrite the resolution inside a PNG eXIf chunk, if it has one, and fix that
 * chunk's CRC. libvips reads eXIf in preference to pHYs, so a PNG written by
 * sharp or Photoshop keeps reporting its old DPI unless this is done too.
 */
function patchPngExif(out: Uint8Array, dpi: number): void {
  const exif = pngChunks(out).find((c) => c.type === "eXIf")
  if (!exif) return
  const f = findTiffResolution(out, exif.dataStart)
  if (!f) return
  patchTiffResolution(out, f, dpi)
  const v = new DataView(out.buffer, out.byteOffset)
  v.setUint32(exif.dataStart + exif.length, pngCrc32(out.subarray(exif.start + 4, exif.dataStart + exif.length)))
}

function setPngDpi(b: Uint8Array, dpi: number): Uint8Array {
  const chunks = pngChunks(b)
  const existing = chunks.find((c) => c.type === "pHYs")

  if (existing && existing.length === 9) {
    const out = new Uint8Array(b)
    const v = new DataView(out.buffer)
    v.setUint32(existing.dataStart, dpiToPpu(dpi))
    v.setUint32(existing.dataStart + 4, dpiToPpu(dpi))
    out[existing.dataStart + 8] = 1
    // The data changed, so the chunk's CRC has to be recomputed over type + data.
    v.setUint32(existing.dataStart + 9, pngCrc32(out.subarray(existing.start + 4, existing.dataStart + 9)))
    patchPngExif(out, dpi)
    return out
  }

  // pHYs has to sit before the first IDAT; straight after IHDR is always valid.
  const ihdr = chunks.find((c) => c.type === "IHDR")
  if (!ihdr) throw new UnsupportedDpiFormatError("This PNG is missing its header chunk and cannot be edited.")
  const chunk = buildPhys(dpi)
  const out = new Uint8Array(b.length + chunk.length)
  out.set(b.subarray(0, ihdr.end), 0)
  out.set(chunk, ihdr.end)
  out.set(b.subarray(ihdr.end), ihdr.end + chunk.length)
  patchPngExif(out, dpi)
  return out
}

// --- public API --------------------------------------------------------------

/**
 * Read the DPI a file declares. `source: "none"` means the file records no
 * density, which is the usual case for screenshots and web images; programs then
 * fall back to their own default, normally 72 or 96.
 */
export function readDpi(buf: ArrayBuffer): DpiInfo {
  const b = new Uint8Array(buf)
  const format = detectDpiFormat(buf)
  if (format === "png") return readPngDpi(b) ?? { x: 0, y: 0, source: "none" }
  const segments = jpegSegments(b)
  const jfif = segments.find((s) => isJfifApp0(b, s))
  if (jfif) {
    const d = readJfifDpi(b, jfif)
    if (d) return d
  }
  const exif = segments.find((s) => isExifApp1(b, s))
  if (exif) {
    const d = readTiffDpi(findTiffResolution(b, exifTiffStart(exif)))
    if (d) return d
  }
  return { x: 0, y: 0, source: "none" }
}

/**
 * Return a copy of the file with its DPI set. Pixel data is never touched, so
 * the image is bit-for-bit the same picture at a different print size.
 */
export function setDpi(buf: ArrayBuffer, dpi: number): ArrayBuffer {
  if (!Number.isFinite(dpi) || dpi < MIN_DPI || dpi > MAX_DPI) {
    throw new RangeError(`DPI must be between ${MIN_DPI} and ${MAX_DPI}.`)
  }
  const rounded = Math.round(dpi)
  const b = new Uint8Array(buf)
  const out = detectDpiFormat(buf) === "png" ? setPngDpi(b, rounded) : setJpegDpi(b, rounded)
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

/** Pixel dimensions needed to print `inches` at `dpi`. Used by the resample mode. */
export function pixelsForPrintSize(inches: number, dpi: number): number {
  return Math.max(1, Math.round(inches * dpi))
}

/** Physical print size, in inches, of `pixels` at `dpi`. */
export function printSizeInches(pixels: number, dpi: number): number {
  return dpi > 0 ? pixels / dpi : 0
}
