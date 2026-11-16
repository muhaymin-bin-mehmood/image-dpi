# image-dpi

Read and set the DPI of JPEG and PNG files straight from their bytes. Zero dependencies. Works in the browser and in Node. The image is never decoded or re-encoded, so the pixel data stays byte-identical and EXIF survives.

Want to check a file without writing code? Use the free [DPI checker](https://batchset.com/tools/dpi-checker), or change the value with the [DPI converter](https://batchset.com/tools/dpi-converter). Both run on this code, in your browser, without uploading the file.

## Install

```bash
npm install image-dpi
```

## Read the DPI

```js
import { readDpi } from "image-dpi"

const buf = await file.arrayBuffer() // browser File, or fs.readFileSync(path).buffer in Node
const { x, y, source } = readDpi(buf)
// { x: 300, y: 300, source: "jfif" }
// source is "jfif", "exif", "phys" or "none" (the file declares no density)
```

## Set the DPI

```js
import { setDpi } from "image-dpi"

const out = setDpi(buf, 300) // returns a new ArrayBuffer, same pixels
```

For JPEG it writes both the JFIF APP0 segment and the EXIF `XResolution` / `YResolution` tags when present, so Photoshop, Windows Explorer and other readers agree. For PNG it writes the `pHYs` chunk (pixels per metre) and patches an `eXIf` resolution if the file has one.

## Print size helpers

```js
import { printSizeInches, pixelsForPrintSize } from "image-dpi"

printSizeInches(1800, 300)   // 6   (inches)
pixelsForPrintSize(2, 300)   // 600 (pixels for 2 inches at 300 DPI)
```

## What it handles

- Format detection by magic bytes, never by file extension or MIME type
- JFIF units 1 (inch) and 2 (cm); units 0 is an aspect ratio only and reads as no DPI
- EXIF in big-endian and little-endian TIFF headers
- PNG `pHYs`, and `eXIf` when `pHYs` is missing
- WebP throws `UnsupportedDpiFormatError`: WebP has no standard density field

## Why DPI does not change quality

DPI only tells a printer how large to print the pixels that are already there. A 1200 × 1800 image is 4 × 6 inches at 300 DPI and 16.7 × 25 inches at 72 DPI. Setting 300 adds no detail; for a sharp print you need enough pixels.

## License

MIT. Built by [BatchSet](https://batchset.com).
