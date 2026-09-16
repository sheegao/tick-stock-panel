import type { MarketSnapshotRow } from '@/lib/api'

export type StCategory = 'st' | 'star-st'

export interface StStock extends MarketSnapshotRow {
  stCategory: StCategory
}

export interface StDistributionBin {
  key: string
  label: string
  count: number
  tone: 'up' | 'down' | 'flat'
}

export interface StAnalysis {
  stocks: StStock[]
  total: number
  stCount: number
  starStCount: number
  pricedCount: number
  upCount: number
  downCount: number
  flatCount: number
  unknownChangeCount: number
  avgChangePct: number | null
  medianChangePct: number | null
  totalAmount: number
  avgTurnoverRate: number | null
  totalFloatMarketCap: number
  distribution: StDistributionBin[]
  limitUpCount: number
  limitDownCount: number
  brokenLimitUpCount: number
  limitDownRecoveryCount: number
  limitUpStocks: StStock[]
  limitDownStocks: StStock[]
  brokenLimitUpStocks: StStock[]
  emotionScore: number
  emotionLabel: '冰点' | '偏冷' | '中性' | '偏暖' | '高涨'
  momentum20Count: number
  avgMomentum20: number | null
  medianMomentum20: number | null
  momentum20Leaders: StStock[]
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function classifyStName(name: string | null | undefined): StCategory | null {
  const normalized = String(name ?? '').trim().toUpperCase().replaceAll('＊', '*')
  if (normalized.includes('*ST')) return 'star-st'
  if (normalized.includes('ST')) return 'st'
  return null
}

export function filterStStocks(rows: MarketSnapshotRow[]): StStock[] {
  return rows.flatMap(row => {
    const stCategory = classifyStName(row.name)
    return stCategory ? [{ ...row, stCategory }] : []
  })
}

function buildDistribution(values: number[]): StDistributionBin[] {
  const bins: StDistributionBin[] = [
    { key: 'down-5', label: '≤ -5%', count: 0, tone: 'down' },
    { key: 'down-2', label: '-5% ~ -2%', count: 0, tone: 'down' },
    { key: 'down-0', label: '-2% ~ 0', count: 0, tone: 'down' },
    { key: 'flat', label: '平盘', count: 0, tone: 'flat' },
    { key: 'up-2', label: '0 ~ 2%', count: 0, tone: 'up' },
    { key: 'up-5', label: '2% ~ 5%', count: 0, tone: 'up' },
    { key: 'up-over-5', label: '≥ 5%', count: 0, tone: 'up' },
  ]

  for (const value of values) {
    const index = value <= -0.05
      ? 0
      : value < -0.02
        ? 1
        : value < 0
          ? 2
          : value === 0
            ? 3
            : value < 0.02
              ? 4
              : value < 0.05
                ? 5
                : 6
    bins[index].count += 1
  }
  return bins
}

export function buildStAnalysis(rows: MarketSnapshotRow[]): StAnalysis {
  const stocks = filterStStocks(rows)
  const changes = stocks.map(row => finiteNumber(row.change_pct)).filter((value): value is number => value != null)
  const turnoverRates = stocks.map(row => finiteNumber(row.turnover_rate)).filter((value): value is number => value != null)

  const upCount = changes.filter(value => value > 0).length
  const downCount = changes.filter(value => value < 0).length
  const flatCount = changes.filter(value => value === 0).length
  const limitUpStocks = stocks.filter(row => row.signal_limit_up === true)
  const limitDownStocks = stocks.filter(row => row.signal_limit_down === true)
  const brokenLimitUpStocks = stocks.filter(row => row.signal_broken_limit_up === true)
  const limitDownRecoveryCount = stocks.filter(row => row.signal_limit_down_recovery === true).length
  const momentum20Leaders = stocks
    .filter(row => finiteNumber(row.momentum_20d) != null)
    .sort((a, b) => (finiteNumber(b.momentum_20d) ?? 0) - (finiteNumber(a.momentum_20d) ?? 0))
  const momentum20Values = momentum20Leaders.map(row => finiteNumber(row.momentum_20d) as number)

  const breadthScore = changes.length ? (upCount + flatCount * 0.5) / changes.length : 0.5
  const averageChangeScore = Math.max(0, Math.min(1, 0.5 + (average(changes) ?? 0) / 0.1))
  const limitBalanceScore = (limitUpStocks.length + 1) / (limitUpStocks.length + limitDownStocks.length + 2)
  const emotionScore = Math.round((breadthScore * 0.5 + averageChangeScore * 0.3 + limitBalanceScore * 0.2) * 100)
  const emotionLabel = emotionScore < 25
    ? '冰点'
    : emotionScore < 40
      ? '偏冷'
      : emotionScore < 55
        ? '中性'
        : emotionScore < 70
          ? '偏暖'
          : '高涨'

  return {
    stocks,
    total: stocks.length,
    stCount: stocks.filter(row => row.stCategory === 'st').length,
    starStCount: stocks.filter(row => row.stCategory === 'star-st').length,
    pricedCount: changes.length,
    upCount,
    downCount,
    flatCount,
    unknownChangeCount: stocks.length - changes.length,
    avgChangePct: average(changes),
    medianChangePct: median(changes),
    totalAmount: stocks.reduce((sum, row) => sum + (finiteNumber(row.amount) ?? 0), 0),
    avgTurnoverRate: average(turnoverRates),
    totalFloatMarketCap: stocks.reduce((sum, row) => sum + (finiteNumber(row.float_market_cap) ?? 0), 0),
    distribution: buildDistribution(changes),
    limitUpCount: limitUpStocks.length,
    limitDownCount: limitDownStocks.length,
    brokenLimitUpCount: brokenLimitUpStocks.length,
    limitDownRecoveryCount,
    limitUpStocks,
    limitDownStocks,
    brokenLimitUpStocks,
    emotionScore,
    emotionLabel,
    momentum20Count: momentum20Values.length,
    avgMomentum20: average(momentum20Values),
    medianMomentum20: median(momentum20Values),
    momentum20Leaders,
  }
}
