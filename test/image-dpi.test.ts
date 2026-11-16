import { describe, it, expect } from "vitest"
import {
  readDpi,
  setDpi,
  detectDpiFormat,
  pngCrc32,
  pixelsForPrintSize,
  printSizeInches,
  UnsupportedDpiFormatError,
} from "../src/index"

// --- fixture builders --------------------------------------------------------
// Real encoders are not available under vitest, so the fixtures are assembled by
// hand. They are structurally valid JPEG and PNG containers: the point of this
// module is byte layout, so hand-built headers test exactly the right thing.

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngChunk(type: string, data: number[]): number[] {
  const body = [...type.split("").map((c) => c.charCodeAt(0)), ...data]
  const len = data.length
  const crc = pngCrc32(Uint8Array.from(body))
  return [
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...body,
    (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff,
  ]
}

const IHDR_DATA = [0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 0] // 4x4, 8-bit RGBA
const IDAT_DATA = [0x78, 0x9c, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]

function physData(ppu: number, unit = 1): number[] {
  return [
    (ppu >>> 24) & 0xff, (ppu >>> 16) & 0xff, (ppu >>> 8) & 0xff, ppu & 0xff,
    (ppu >>> 24) & 0xff, (ppu >>> 16) & 0xff, (ppu >>> 8) & 0xff, ppu & 0xff,
    unit,
  ]
}

function buildPng(opts: { phys?: number; physUnit?: number } = {}): ArrayBuffer {
  const bytes = [
    ...PNG_SIG,
    ...pngChunk("IHDR", IHDR_DATA),
    ...(opts.phys !== undefined ? pngChunk("pHYs", physData(opts.phys, opts.physUnit ?? 1)) : []),
    ...pngChunk("IDAT", IDAT_DATA),
    ...pngChunk("IEND", []),
  ]
  return Uint8Array.from(bytes).buffer
}

const SCAN_TAIL = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56, 0xff, 0xd9]

function jfifApp0(density: number, units = 1): number[] {
  return [
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    1, 1, units,
    (density >> 8) & 0xff, density & 0xff,
    (density >> 8) & 0xff, density & 0xff,
    0, 0,
  ]
}

/**
 * An EXIF APP1 block holding XResolution, YResolution and ResolutionUnit in
 * IFD0, in either byte order.
 */
function exifApp1(dpi: number, bigEndian: boolean): number[] {
  const u16 = (n: number) => (bigEndian ? [(n >> 8) & 0xff, n & 0xff] : [n & 0xff, (n >> 8) & 0xff])
  const u32 = (n: number) =>
    bigEndian
      ? [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
      : [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]

  const entry = (tag: number, type: number, value: number[]) => [...u16(tag), ...u16(type), ...u32(1), ...value]

  const tiff = [
    ...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]),
    ...u16(0x002a),
    ...u32(8), // IFD0 starts 8 bytes into the TIFF block
    ...u16(3), // three entries
    ...entry(0x011a, 5, u32(50)), // XResolution: RATIONAL at TIFF+50
    ...entry(0x011b, 5, u32(58)), // YResolution: RATIONAL at TIFF+58
    ...entry(0x0128, 3, [...u16(2), 0, 0]), // ResolutionUnit: SHORT 2 (inches), inline
    ...u32(0), // no next IFD
    ...u32(dpi), ...u32(1), // XResolution value
    ...u32(dpi), ...u32(1), // YResolution value
  ]

  const data = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff] // "Exif\0\0"
  const len = data.length + 2
  return [0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...data]
}

function buildJpeg(opts: { jfif?: number; jfifUnits?: number; exif?: number; exifBE?: boolean } = {}): ArrayBuffer {
  const bytes = [
    0xff, 0xd8,
    ...(opts.jfif !== undefined ? jfifApp0(opts.jfif, opts.jfifUnits ?? 1) : []),
    ...(opts.exif !== undefined ? exifApp1(opts.exif, opts.exifBE ?? false) : []),
    ...SCAN_TAIL,
  ]
  return Uint8Array.from(bytes).buffer
}

const bytesOf = (b: ArrayBuffer) => Array.from(new Uint8Array(b))
const tail = (b: ArrayBuffer, n: number) => bytesOf(b).slice(-n)

// --- CRC ---------------------------------------------------------------------

describe("PNG CRC", () => {
  it("matches the published constant for an empty IEND chunk", () => {
    // Every PNG ever written ends with this exact CRC, so it anchors the table.
    const iend = Uint8Array.from("IEND".split("").map((c) => c.charCodeAt(0)))
    expect(pngCrc32(iend)).toBe(0xae426082)
  })
})

// --- format detection --------------------------------------------------------

describe("format detection", () => {
  it("identifies JPEG and PNG by magic bytes", () => {
    expect(detectDpiFormat(buildJpeg({ jfif: 72 }))).toBe("jpeg")
    expect(detectDpiFormat(buildPng())).toBe("png")
  })

  it("rejects WebP with an explanation rather than silently doing nothing", () => {
    const webp = Uint8Array.from([
      0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]).buffer
    expect(() => detectDpiFormat(webp)).toThrow(UnsupportedDpiFormatError)
    expect(() => detectDpiFormat(webp)).toThrow(/WebP has no standard DPI field/)
  })

  it("rejects anything else", () => {
    expect(() => detectDpiFormat(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer)).toThrow(
      UnsupportedDpiFormatError
    )
  })
})

// --- JPEG --------------------------------------------------------------------

describe("JPEG DPI", () => {
  it("reads density from an existing JFIF segment", () => {
    expect(readDpi(buildJpeg({ jfif: 300 }))).toEqual({ x: 300, y: 300, source: "jfif" })
  })

  it("converts dots-per-centimetre to DPI when reading", () => {
    // units 2 means per centimetre, so 118/cm is about 300 DPI.
    expect(readDpi(buildJpeg({ jfif: 118, jfifUnits: 2 })).x).toBe(300)
  })

  it("treats units 0 as no density, because it only encodes an aspect ratio", () => {
    expect(readDpi(buildJpeg({ jfif: 1, jfifUnits: 0 })).source).toBe("none")
  })

  it("updates a JFIF segment in place, without changing the file length", () => {
    const src = buildJpeg({ jfif: 72 })
    const out = setDpi(src, 300)
    expect(out.byteLength).toBe(src.byteLength)
    expect(readDpi(out)).toEqual({ x: 300, y: 300, source: "jfif" })
  })

  it("leaves the scan data untouched when it rewrites the header", () => {
    const src = buildJpeg({ jfif: 72 })
    const out = setDpi(src, 600)
    expect(tail(out, SCAN_TAIL.length)).toEqual(SCAN_TAIL)
  })

  it("inserts a JFIF segment after SOI when the file has none", () => {
    const src = buildJpeg({})
    const out = setDpi(src, 300)
    expect(out.byteLength).toBe(src.byteLength + 18)
    expect(readDpi(out)).toEqual({ x: 300, y: 300, source: "jfif" })
    // SOI stays first and the rest of the file follows the new segment unchanged.
    expect(bytesOf(out).slice(0, 2)).toEqual([0xff, 0xd8])
    expect(bytesOf(out).slice(20)).toEqual(bytesOf(src).slice(2))
  })

  it("reads DPI out of EXIF when there is no JFIF segment", () => {
    expect(readDpi(buildJpeg({ exif: 300 }))).toEqual({ x: 300, y: 300, source: "exif" })
  })

  it("reads big-endian (Motorola) EXIF as well as little-endian", () => {
    expect(readDpi(buildJpeg({ exif: 150, exifBE: true }))).toEqual({ x: 150, y: 150, source: "exif" })
  })

  it("prefers JFIF when a file carries both headers", () => {
    expect(readDpi(buildJpeg({ jfif: 72, exif: 300 })).source).toBe("jfif")
  })

  for (const bigEndian of [false, true]) {
    it(`rewrites EXIF resolution so it agrees with JFIF (${bigEndian ? "big" : "little"}-endian)`, () => {
      const src = buildJpeg({ jfif: 72, exif: 72, exifBE: bigEndian })
      const out = setDpi(src, 300)
      expect(readDpi(out)).toEqual({ x: 300, y: 300, source: "jfif" })

      // Strip the JFIF segment and the EXIF block must report 300 on its own,
      // which is what Photoshop and Windows Explorer would show.
      const b = bytesOf(out)
      const exifOnly = Uint8Array.from([0xff, 0xd8, ...b.slice(20)]).buffer
      expect(readDpi(exifOnly)).toEqual({ x: 300, y: 300, source: "exif" })
    })
  }

  it("keeps EXIF in step even when the JFIF segment had to be inserted", () => {
    const src = buildJpeg({ exif: 72 })
    const out = setDpi(src, 300)
    const b = bytesOf(out)
    const exifOnly = Uint8Array.from([0xff, 0xd8, ...b.slice(20)]).buffer
    expect(readDpi(exifOnly)).toEqual({ x: 300, y: 300, source: "exif" })
  })
})

// --- PNG ---------------------------------------------------------------------

describe("PNG DPI", () => {
  it("reads an existing pHYs chunk", () => {
    expect(readDpi(buildPng({ phys: 11811 }))).toEqual({ x: 300, y: 300, source: "phys" })
  })

  it("reports no density when the unit is unknown, because it is only a ratio", () => {
    expect(readDpi(buildPng({ phys: 11811, physUnit: 0 })).source).toBe("none")
  })

  it("reports no density when the file has no pHYs chunk", () => {
    expect(readDpi(buildPng())).toEqual({ x: 0, y: 0, source: "none" })
  })

  it("updates an existing pHYs chunk in place", () => {
    const src = buildPng({ phys: 2835 }) // 72 DPI
    const out = setDpi(src, 300)
    expect(out.byteLength).toBe(src.byteLength)
    expect(readDpi(out)).toEqual({ x: 300, y: 300, source: "phys" })
  })

  it("inserts pHYs after IHDR when the file has none", () => {
    const src = buildPng()
    const out = setDpi(src, 300)
    expect(out.byteLength).toBe(src.byteLength + 21)
    expect(readDpi(out)).toEqual({ x: 300, y: 300, source: "phys" })
    // The chunk lands between IHDR and IDAT, which is where the spec requires it.
    const text = Array.from(new Uint8Array(out))
      .map((c) => String.fromCharCode(c))
      .join("")
    expect(text.indexOf("IHDR")).toBeLessThan(text.indexOf("pHYs"))
    expect(text.indexOf("pHYs")).toBeLessThan(text.indexOf("IDAT"))
  })

  it("leaves the image data untouched", () => {
    const out = setDpi(buildPng({ phys: 2835 }), 600)
    const idat = pngChunk("IDAT", IDAT_DATA)
    const b = bytesOf(out).join(",")
    expect(b).toContain(idat.join(","))
  })

  it("writes a valid CRC on every chunk it touches", () => {
    for (const src of [buildPng(), buildPng({ phys: 2835 })]) {
      const out = new Uint8Array(setDpi(src, 300))
      const view = new DataView(out.buffer)
      let i = 8
      let checked = 0
      while (i + 8 <= out.length) {
        const len = view.getUint32(i)
        const stored = view.getUint32(i + 8 + len)
        expect(pngCrc32(out.subarray(i + 4, i + 8 + len))).toBe(stored)
        checked++
        i += 12 + len
      }
      expect(checked).toBeGreaterThanOrEqual(4) // IHDR, pHYs, IDAT, IEND
    }
  })
})

// --- round trips and guards --------------------------------------------------

describe("round trips", () => {
  const values = [72, 96, 150, 200, 300, 600, 1200]

  it("reads back every common DPI it writes, in both formats", () => {
    for (const dpi of values) {
      expect(readDpi(setDpi(buildJpeg({ jfif: 72 }), dpi)).x, `jpeg ${dpi}`).toBe(dpi)
      expect(readDpi(setDpi(buildPng(), dpi)).x, `png ${dpi}`).toBe(dpi)
    }
  })

  it("is idempotent", () => {
    const once = setDpi(buildPng(), 300)
    const twice = setDpi(once, 300)
    expect(bytesOf(twice)).toEqual(bytesOf(once))
  })

  it("never mutates the buffer it was given", () => {
    const src = buildJpeg({ jfif: 72 })
    const before = bytesOf(src)
    setDpi(src, 300)
    expect(bytesOf(src)).toEqual(before)
  })

  it("refuses values outside the usable range", () => {
    for (const bad of [0, -300, 99999, NaN, Infinity]) {
      expect(() => setDpi(buildPng(), bad), String(bad)).toThrow(RangeError)
    }
  })
})

describe("print size maths", () => {
  it("converts between inches and pixels at a given DPI", () => {
    expect(pixelsForPrintSize(4, 300)).toBe(1200)
    expect(pixelsForPrintSize(8.5, 300)).toBe(2550)
    expect(printSizeInches(1200, 300)).toBe(4)
  })

  it("never returns a zero-pixel image", () => {
    expect(pixelsForPrintSize(0.001, 72)).toBe(1)
  })
})
