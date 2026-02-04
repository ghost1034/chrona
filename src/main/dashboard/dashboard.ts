import type { StorageService } from '../storage/storage'
import type { DashboardStatsDTO } from '../../shared/dashboard'
import { computeDashboardStats } from '../../shared/stats'

export class DashboardService {
  private readonly storage: StorageService

  constructor(opts: { storage: StorageService }) {
    this.storage = opts.storage
  }

  async getStats(opts: {
    scopeStartTs: number
    scopeEndTs: number
    includeSystem?: boolean
  }): Promise<DashboardStatsDTO> {
    const cardsRaw = await this.storage.fetchCardsInRange({
      startTs: opts.scopeStartTs,
      endTs: opts.scopeEndTs,
      includeSystem: true
    })

    const cards = cardsRaw.map((r: any) => ({
      id: Number(r.id),
      startTs: Number(r.start_ts),
      endTs: Number(r.end_ts),
      category: String(r.category ?? ''),
      title: String(r.title ?? ''),
      subcategory: r.subcategory ?? null
    }))

    const reviewSegments = await this.storage.fetchReviewSegmentsInRange({
      startTs: opts.scopeStartTs,
      endTs: opts.scopeEndTs
    })

    return computeDashboardStats({
      scopeStartTs: opts.scopeStartTs,
      scopeEndTs: opts.scopeEndTs,
      cards,
      reviewSegments,
      includeSystem: opts.includeSystem ?? false
    })
  }
}
