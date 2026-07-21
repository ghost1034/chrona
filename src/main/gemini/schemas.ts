export type JsonSchema = Record<string, any>

export function buildTranscriptionResponseSchema(): JsonSchema {
  return {
    type: 'object',
    propertyOrdering: ['observations', 'detailedTranscription'],
    additionalProperties: false,
    properties: {
      observations: {
        type: 'array',
        items: {
          type: 'object',
          propertyOrdering: ['start', 'end', 'observation', 'appSites'],
          additionalProperties: false,
          properties: {
            start: { type: 'string', description: 'Start timestamp in MM:SS (video time).' },
            end: { type: 'string', description: 'End timestamp in MM:SS (video time).' },
            observation: { type: 'string', description: 'Factual description of what is visible.' },
            appSites: {
              type: ['object', 'null'],
              additionalProperties: false,
              propertyOrdering: ['primary', 'secondary'],
              properties: {
                primary: { type: ['string', 'null'] },
                secondary: { type: ['string', 'null'] }
              },
              required: ['primary', 'secondary']
            }
          },
          required: ['start', 'end', 'observation']
        }
      },
      detailedTranscription: {
        type: ['string', 'null'],
        description: 'Optional longer transcription text.'
      }
    },
    required: ['observations']
  }
}

export function buildCardGenerationResponseSchema(
  allowedCategories: string[],
  allowedSubcategoriesByCategory: Readonly<Record<string, readonly string[]>> = {}
): JsonSchema {
  const cats = Array.from(new Set(allowedCategories.map((c) => String(c ?? '').trim()).filter(Boolean)))
  const subcategories = Array.from(
    new Set(
      cats.flatMap((category) =>
        (allowedSubcategoriesByCategory[category] ?? [])
          .map((subcategory) => String(subcategory ?? '').trim())
          .filter(Boolean)
      )
    )
  )
  return {
    type: 'object',
    propertyOrdering: ['cards'],
    additionalProperties: false,
    properties: {
      cards: {
        type: 'array',
        items: {
          type: 'object',
          propertyOrdering: [
            'startTs',
            'endTs',
            'category',
            'subcategory',
            'title',
            'summary',
            'detailedSummary',
            'appSites'
          ],
          additionalProperties: false,
          properties: {
            startTs: { type: 'integer', description: 'Unix seconds.' },
            endTs: { type: 'integer', description: 'Unix seconds.' },
            category: {
              type: 'string',
              enum: cats,
              description: 'Must be one of the allowed categories.'
            },
            subcategory:
              subcategories.length > 0
                ? {
                    type: ['string', 'null'],
                    enum: [...subcategories, null],
                    description:
                      'Must be null or one of the configured subcategories for the selected category.'
                  }
                : {
                    type: 'null',
                    description: 'No subcategories are configured, so this must be null.'
                  },
            title: { type: 'string' },
            summary: { type: ['string', 'null'] },
            detailedSummary: { type: ['string', 'null'] },
            appSites: {
              type: ['object', 'null'],
              additionalProperties: false,
              propertyOrdering: ['primary', 'secondary'],
              properties: {
                primary: { type: ['string', 'null'] },
                secondary: { type: ['string', 'null'] }
              },
              required: ['primary', 'secondary']
            }
          },
          required: ['startTs', 'endTs', 'category', 'title']
        }
      }
    },
    required: ['cards']
  }
}

export function buildAskResponseSchema(): JsonSchema {
  return {
    type: 'object',
    propertyOrdering: ['answerMarkdown', 'sources', 'followUps'],
    additionalProperties: false,
    properties: {
      answerMarkdown: { type: 'string' },
      sources: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          propertyOrdering: ['type', 'cardId'],
          properties: {
            type: { type: 'string', enum: ['card'] },
            cardId: { type: 'integer' }
          },
          required: ['type', 'cardId']
        }
      },
      followUps: { type: 'array', items: { type: 'string' } }
    },
    required: ['answerMarkdown', 'sources', 'followUps']
  }
}

export function buildJournalDraftSchema(): JsonSchema {
  return {
    type: 'object',
    propertyOrdering: ['intentions', 'notes', 'reflections', 'summary'],
    additionalProperties: false,
    properties: {
      intentions: { type: 'string' },
      notes: { type: 'string' },
      reflections: { type: 'string' },
      summary: { type: 'string' }
    },
    required: ['intentions', 'notes', 'reflections', 'summary']
  }
}
