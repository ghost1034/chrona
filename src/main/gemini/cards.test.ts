import { describe, expect, test } from 'vitest'
import { parseAndValidateCardsJson, stripCodeFences } from './cards'

describe('parseAndValidateCardsJson', () => {
  test('parses without clamping and requires overlap', () => {
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
    expect(res.cards[0].startTs).toBe(900)
    expect(res.cards[0].endTs).toBe(2100)
  })

  test('drops cards that do not overlap the window', () => {
    const res = parseAndValidateCardsJson({
      jsonText: JSON.stringify({
        cards: [
          { startTs: 0, endTs: 900, category: 'Work', title: 'Too early' },
          { startTs: 2000, endTs: 2100, category: 'Work', title: 'Touches end only' },
          { startTs: 2100, endTs: 2200, category: 'Work', title: 'Too late' }
        ]
      }),
      windowStartTs: 1000,
      windowEndTs: 2000
    })
    expect(res.cards).toHaveLength(0)
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

  test('only keeps configured subcategories for the card category', () => {
    const res = parseAndValidateCardsJson({
      jsonText: JSON.stringify({
        cards: [
          {
            startTs: 1000,
            endTs: 1100,
            category: 'Work',
            subcategory: 'Coding',
            title: 'Valid'
          },
          {
            startTs: 1100,
            endTs: 1200,
            category: 'Work',
            subcategory: 'Invented',
            title: 'Unknown'
          },
          {
            startTs: 1200,
            endTs: 1300,
            category: 'Work',
            subcategory: 'Exercise',
            title: 'Wrong category'
          }
        ]
      }),
      windowStartTs: 1000,
      windowEndTs: 2000,
      allowedSubcategoriesByCategory: {
        Work: ['Coding'],
        Personal: ['Exercise']
      }
    })

    expect(res.cards.map((card) => card.subcategory)).toEqual(['Coding', null, null])
  })
})

describe('stripCodeFences', () => {
  test('removes fenced json wrapper', () => {
    const s = '```json\n{"cards": []}\n```'
    expect(stripCodeFences(s)).toBe('{"cards": []}')
  })
})
