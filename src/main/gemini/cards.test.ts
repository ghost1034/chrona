import { describe, expect, test } from 'vitest'
import { parseAndValidateCardsJson, stripCodeFences } from './cards'

describe('parseAndValidateCardsJson', () => {
  test('parses and clamps to window', () => {
    const windowStartTs = 1000
    const windowEndTs = 2000
    const json = {
      cards: [
        {
          startTs: 900,
          endTs: 2100,
          category: 'Work',
          title: 'X',
          summary: 'S'
        }
      ]
    }

    const res = parseAndValidateCardsJson({
      jsonText: JSON.stringify(json),
      windowStartTs,
      windowEndTs
    })
    expect(res.cards).toHaveLength(1)
    expect(res.cards[0].startTs).toBe(1000)
    expect(res.cards[0].endTs).toBe(2000)
  })

  test('filters invalid categories', () => {
    const res = parseAndValidateCardsJson({
      jsonText: JSON.stringify({
        cards: [{ startTs: 1000, endTs: 1100, category: 'System', title: 'Nope' }]
      }),
      windowStartTs: 1000,
      windowEndTs: 2000
    })
    expect(res.cards).toHaveLength(0)
  })
})

describe('stripCodeFences', () => {
  test('removes fenced json wrapper', () => {
    const s = '```json\n{"cards": []}\n```'
    expect(stripCodeFences(s)).toBe('{"cards": []}')
  })
})
