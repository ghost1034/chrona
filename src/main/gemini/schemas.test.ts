import { describe, expect, test } from 'vitest'
import { buildCardGenerationResponseSchema } from './schemas'

describe('buildCardGenerationResponseSchema', () => {
  test('restricts subcategories to configured names or null', () => {
    const schema = buildCardGenerationResponseSchema(['Work', 'Personal'], {
      Work: ['Coding'],
      Personal: ['Exercise']
    })

    expect(schema.properties.cards.items.properties.subcategory).toEqual({
      type: ['string', 'null'],
      enum: ['Coding', 'Exercise', null],
      description: 'Must be null or one of the configured subcategories for the selected category.'
    })
  })

  test('only permits null when no subcategories exist', () => {
    const schema = buildCardGenerationResponseSchema(['Work'])

    expect(schema.properties.cards.items.properties.subcategory).toEqual({
      type: 'null',
      description: 'No subcategories are configured, so this must be null.'
    })
  })
})
