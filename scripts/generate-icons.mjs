import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

await mkdir(new URL('../build/', import.meta.url), { recursive: true })
const source = await readFile(new URL('../public/assets/chrona-dial.svg', import.meta.url))
await sharp(source).resize(1024, 1024).png().toFile(fileURLToPath(new URL('../build/icon.png', import.meta.url)))
await sharp(source).resize(256, 256).png().toFile(fileURLToPath(new URL('../build/icon-256.png', import.meta.url)))
