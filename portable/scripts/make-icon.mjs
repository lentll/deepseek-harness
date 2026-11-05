/**
 * Build `build/icon.ico` from the project's icon source.
 *
 * Windows accepts PNG-compressed entries inside an ICO container, which keeps
 * the file small and avoids a raster encoder dependency beyond the resampler.
 *
 * Usage: node scripts/make-icon.mjs <source.png> [output.ico]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const source = process.argv[2] ?? 'F:\\WorkBuddyData\\workspace\\deepseek-harness-master\\apps\\desktop\\resources\\icon-windows.png'
const output = process.argv[3] ?? path.join(projectRoot, 'build', 'icon.ico')

if (!fs.existsSync(source)) {
  console.error(`[icon] missing source: ${source}`)
  process.exit(1)
}

/** Entry sizes Windows picks from; 256 is the modern shell icon. */
const SIZES = [256, 128, 64, 48, 32, 16]

/**
 * Pack PNG buffers into an ICO container.
 * @param {{size: number, data: Buffer}[]} images - square PNGs, largest first.
 * @returns {Buffer} the ICO file bytes.
 */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((image, index) => {
    const entry = index * 16
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry)
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1)
    directory.writeUInt8(0, entry + 2)
    directory.writeUInt8(0, entry + 3)
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })

  return Buffer.concat([header, directory, ...images.map((image) => image.data)])
}

const images = []
for (const size of SIZES) {
  const data = await sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
  images.push({ size, data })
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, buildIco(images))
console.log(`[icon] wrote ${output} (${SIZES.join(', ')} px, ${(fs.statSync(output).size / 1024).toFixed(0)} KB)`)
