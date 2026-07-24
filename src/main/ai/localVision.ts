import sharp from 'sharp'

export type LocalVisionFrame = {
  index: number
  capturedAt: number
  filePath: string
}

const STORYBOARD_WIDTH = 960
const STORYBOARD_HEIGHT = 540
const PANEL_WIDTH = STORYBOARD_WIDTH / 2
const PANEL_HEIGHT = STORYBOARD_HEIGHT / 2

export const LOCAL_VISION_MAX_SELECTED_FRAMES = 45

export function calculateLocalVisionFrameBudget(
  capturedAts: number[],
  maxFrames = LOCAL_VISION_MAX_SELECTED_FRAMES
): number {
  if (capturedAts.length === 0 || maxFrames <= 0) return 0
  const limit = Math.max(1, Math.floor(maxFrames))
  if (capturedAts.length === 1 || limit === 1) return 1
  const anchors = collectAnchorIndexes(capturedAts)
  const durationSeconds = Math.max(0, capturedAts.at(-1)! - capturedAts[0]!)
  return Math.min(capturedAts.length, limit, anchors.size + Math.ceil(durationSeconds / 120))
}

/**
 * Selects endpoints, minute anchors, and the strongest adjacent visual changes.
 * The transition reserve grows by one frame for every two minutes of evidence,
 * while the hard cap keeps a 30-minute batch within four overlapping 12-frame
 * requests.
 */
export function selectRepresentativeFrameIndexes(
  capturedAts: number[],
  transitionScores: number[],
  maxFrames = LOCAL_VISION_MAX_SELECTED_FRAMES
): number[] {
  if (capturedAts.length === 0 || maxFrames <= 0) return []

  const limit = Math.max(1, Math.floor(maxFrames))
  const lastIndex = capturedAts.length - 1
  if (limit === 1) return [0]

  const endpoints = new Set([0, lastIndex])
  const minuteAnchors: number[] = []
  const firstBoundary = Math.ceil(capturedAts[0]! / 60) * 60
  const lastTs = capturedAts[lastIndex]!
  for (let boundary = firstBoundary; boundary <= lastTs; boundary += 60) {
    const nearest = findNearestTimestampIndex(capturedAts, boundary)
    if (!endpoints.has(nearest) && minuteAnchors.at(-1) !== nearest) minuteAnchors.push(nearest)
  }

  const selected = new Set(endpoints)
  const anchorCapacity = Math.max(0, limit - selected.size)
  for (const index of chooseEvenly(minuteAnchors, anchorCapacity)) selected.add(index)

  const durationAwareLimit = calculateLocalVisionFrameBudget(capturedAts, limit)
  if (capturedAts.length <= durationAwareLimit) return capturedAts.map((_, index) => index)

  const transitions = Array.from({ length: Math.max(0, capturedAts.length - 1) }, (_, offset) => {
    const afterIndex = offset + 1
    return { afterIndex, score: Number(transitionScores[afterIndex] ?? 0) }
  }).filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.afterIndex - b.afterIndex)

  for (const transition of transitions) {
    const pair = [transition.afterIndex - 1, transition.afterIndex]
    const missing = pair.filter((index) => !selected.has(index))
    if (missing.length === 0) continue
    if (selected.size + missing.length > durationAwareLimit) continue
    for (const index of missing) selected.add(index)
    if (selected.size === durationAwareLimit) break
  }

  return [...selected].sort((a, b) => a - b)
}

function collectAnchorIndexes(capturedAts: number[]): Set<number> {
  const lastIndex = capturedAts.length - 1
  const anchors = new Set([0, lastIndex])
  const firstBoundary = Math.ceil(capturedAts[0]! / 60) * 60
  const lastTs = capturedAts[lastIndex]!
  for (let boundary = firstBoundary; boundary <= lastTs; boundary += 60) {
    anchors.add(findNearestTimestampIndex(capturedAts, boundary))
  }
  return anchors
}

export async function calculateGrayscaleTransitionScores(filePaths: string[]): Promise<number[]> {
  const pixels = await Promise.all(
    filePaths.map((filePath) =>
      sharp(filePath)
        .rotate()
        .resize({ width: 64, height: 36, fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer()
    )
  )
  return pixels.map((current, index) => {
    if (index === 0) return 0
    const previous = pixels[index - 1]!
    const length = Math.min(previous.length, current.length)
    if (length === 0) return 0
    let total = 0
    for (let pixel = 0; pixel < length; pixel++) total += Math.abs(current[pixel]! - previous[pixel]!)
    return total / (length * 255)
  })
}

export async function buildLocalVisionStoryboards(frames: LocalVisionFrame[]): Promise<string[]> {
  const storyboards: string[] = []
  for (let start = 0; start < frames.length; start += 4) {
    const group = frames.slice(start, start + 4)
    const composites: Array<{ input: Buffer; left: number; top: number }> = []
    for (let panelIndex = 0; panelIndex < group.length; panelIndex++) {
      const frame = group[panelIndex]!
      const left = (panelIndex % 2) * PANEL_WIDTH
      const top = Math.floor(panelIndex / 2) * PANEL_HEIGHT
      const image = await sharp(frame.filePath)
        .rotate()
        .resize({
          width: PANEL_WIDTH,
          height: PANEL_HEIGHT,
          fit: 'contain',
          background: { r: 20, g: 22, b: 26 }
        })
        .png()
        .toBuffer()
      composites.push({ input: image, left, top })
      composites.push({ input: frameLabelSvg(frame.index), left: left + 8, top: top + 8 })
    }
    const jpeg = await sharp({
      create: {
        width: STORYBOARD_WIDTH,
        height: STORYBOARD_HEIGHT,
        channels: 3,
        background: { r: 20, g: 22, b: 26 }
      }
    }).composite(composites).jpeg({ quality: 78 }).toBuffer()
    storyboards.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
  }
  return storyboards
}

function frameLabelSvg(index: number) {
  const label = `FRAME_${index}`
  return Buffer.from(
    `<svg width="150" height="34" xmlns="http://www.w3.org/2000/svg">` +
      '<rect width="150" height="34" rx="5" fill="#000" fill-opacity="0.82"/>' +
      `<text x="9" y="23" font-family="monospace" font-size="18" font-weight="700" fill="#fff">${label}</text>` +
    '</svg>'
  )
}

function findNearestTimestampIndex(values: number[], target: number): number {
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid]! < target) low = mid + 1
    else high = mid
  }
  if (low === 0) return 0
  const before = low - 1
  return target - values[before]! <= values[low]! - target ? before : low
}

function chooseEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return []
  if (items.length <= count) return items
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]!]
  const selected: T[] = []
  for (let index = 0; index < count; index++) {
    selected.push(items[Math.round(index * (items.length - 1) / (count - 1))]!)
  }
  return selected
}
