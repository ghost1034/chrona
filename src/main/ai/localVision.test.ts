import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildLocalVisionStoryboards,
  calculateGrayscaleTransitionScores,
  selectRepresentativeFrameIndexes
} from './localVision'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('local vision adaptive sampling', () => {
  it('caps a 181-frame batch while retaining endpoints, minute anchors, and major transition pairs', () => {
    const capturedAts = Array.from({ length: 181 }, (_, index) => 1_700_000_005 + index * 10)
    const scores = capturedAts.map(() => 0)
    scores[15] = 1
    scores[90] = 0.9
    const selected = selectRepresentativeFrameIndexes(capturedAts, scores)

    expect(selected.length).toBeLessThanOrEqual(48)
    expect(selected[0]).toBe(0)
    expect(selected.at(-1)).toBe(180)
    expect(selected).toEqual([...selected].sort((a, b) => a - b))
    expect(selected).toEqual(expect.arrayContaining([14, 15, 89, 90]))

    for (let boundary = Math.ceil(capturedAts[0]! / 60) * 60; boundary <= capturedAts.at(-1)!; boundary += 60) {
      const nearest = capturedAts.reduce((best, value, index) =>
        Math.abs(value - boundary) < Math.abs(capturedAts[best]! - boundary) ? index : best, 0)
      expect(selected).toContain(nearest)
    }
  })

  it('handles stable, rapidly changing, sparse, and short sequences', () => {
    const stableTimes = Array.from({ length: 181 }, (_, index) => 10_000 + index * 10)
    const stable = selectRepresentativeFrameIndexes(stableTimes, stableTimes.map(() => 0))
    const rapid = selectRepresentativeFrameIndexes(stableTimes, stableTimes.map((_, index) => index))
    expect(stable.length).toBeLessThan(rapid.length)
    expect(rapid).toHaveLength(48)
    expect(selectRepresentativeFrameIndexes([0, 120, 360], [0, 0.5, 0.2])).toEqual([0, 1, 2])
    expect(selectRepresentativeFrameIndexes([100, 110], [0, 0])).toEqual([0, 1])
  })

  it('normalizes ultrawide inputs and renders labeled 960x540 storyboards', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chrona-storyboards-'))
    temporaryDirectories.push(directory)
    const paths = [path.join(directory, 'wide.jpg'), path.join(directory, 'tall.jpg')]
    await sharp({ create: { width: 2400, height: 180, channels: 3, background: '#f00' } }).jpeg().toFile(paths[0]!)
    await sharp({ create: { width: 180, height: 2400, channels: 3, background: '#00f' } }).jpeg().toFile(paths[1]!)

    const scores = await calculateGrayscaleTransitionScores(paths)
    expect(scores[1]).toBeGreaterThan(0)
    const storyboards = await buildLocalVisionStoryboards(paths.map((filePath, index) => ({
      index: 40 + index,
      capturedAt: index,
      filePath
    })))
    expect(storyboards).toHaveLength(1)
    const bytes = Buffer.from(storyboards[0]!.split(',')[1]!, 'base64')
    await expect(sharp(bytes).metadata()).resolves.toMatchObject({ width: 960, height: 540, format: 'jpeg' })
  })
})
