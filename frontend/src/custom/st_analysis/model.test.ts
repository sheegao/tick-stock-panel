import { describe, expect, it } from 'vitest'
import type { MarketSnapshotRow } from '@/lib/api'
import {
  buildStAnalysis,
  classifyStName,
  filterStStocks,
} from './model'

describe('ST analysis model', () => {
  it('ranks each 5/10/20 day window independently and excludes null/nonfinite values', () => {
    const analysis = buildStAnalysis([
      { symbol: '1', name: 'ST甲', momentum_5d: 0.2, momentum_10d: -0.1, momentum_20d: null },
      { symbol: '2', name: '*ST乙', momentum_5d: -0.05, momentum_10d: 0.1, momentum_20d: 0.4 },
      { symbol: '3', name: 'ST丙', momentum_5d: Number.NaN, momentum_10d: null },
      { symbol: '4', name: '普通股', momentum_5d: 1 },
    ])
    expect(analysis.momentumRanks[5].leaders.map(row => row.symbol)).toEqual(['1', '2'])
    expect(analysis.momentumRanks[10].leaders.map(row => row.symbol)).toEqual(['2', '1'])
    expect(analysis.momentumRanks[20].count).toBe(1)
    expect(analysis.momentumRanks[5].average).toBeCloseTo(0.075)
    expect(analysis.momentumRanks[10].median).toBe(0)
  })
  it('matches the repository-wide risk-warning name convention', () => {
    expect(classifyStName('ST海王')).toBe('st')
    expect(classifyStName('*ST美丽')).toBe('star-st')
    expect(classifyStName('S*ST测试')).toBe('star-st')
    expect(classifyStName('SST测试')).toBe('st')
    // 与后端 price_limits.is_risk_warning_name 保持一致：名称中含 ST 即风险警示股。
    expect(classifyStName('测试ST科技')).toBe('st')
    expect(classifyStName(null)).toBeNull()
  })

  it('filters the full-market snapshot without changing financial units', () => {
    const rows: MarketSnapshotRow[] = [
      { symbol: '000001.SZ', name: 'ST甲', change_pct: 0.05, turnover_rate: 3.2 },
      { symbol: '000002.SZ', name: '*ST乙', change_pct: -0.05, turnover_rate: 7.8 },
      { symbol: '000003.SZ', name: '普通股份', change_pct: 0.01, turnover_rate: 2.1 },
    ]

    expect(filterStStocks(rows)).toEqual([
      expect.objectContaining({ symbol: '000001.SZ', stCategory: 'st', change_pct: 0.05, turnover_rate: 3.2 }),
      expect.objectContaining({ symbol: '000002.SZ', stCategory: 'star-st', change_pct: -0.05, turnover_rate: 7.8 }),
    ])
  })

  it('aggregates breadth, amount and change distribution with null-safe denominators', () => {
    const analysis = buildStAnalysis([
      { symbol: '1', name: 'ST甲', change_pct: 0.03, amount: 100, turnover_rate: 2 },
      { symbol: '2', name: '*ST乙', change_pct: -0.06, amount: 200, turnover_rate: 4 },
      { symbol: '3', name: 'ST丙', change_pct: null, amount: null, turnover_rate: null },
    ])

    expect(analysis.total).toBe(3)
    expect(analysis.stCount).toBe(2)
    expect(analysis.starStCount).toBe(1)
    expect(analysis.pricedCount).toBe(2)
    expect(analysis.upCount).toBe(1)
    expect(analysis.downCount).toBe(1)
    expect(analysis.flatCount).toBe(0)
    expect(analysis.avgChangePct).toBeCloseTo(-0.015)
    expect(analysis.totalAmount).toBe(300)
    expect(analysis.avgTurnoverRate).toBe(3)
    expect(analysis.distribution.reduce((sum, bin) => sum + bin.count, 0)).toBe(2)
  })

  it('uses authoritative limit flags and a transparent emotion formula', () => {
    const analysis = buildStAnalysis([
      { symbol: '1', name: 'ST甲', change_pct: 0.04, signal_limit_up: true },
      { symbol: '2', name: '*ST乙', change_pct: -0.04, signal_limit_down: true },
      { symbol: '3', name: 'ST丙', change_pct: 0.02, signal_broken_limit_up: true },
    ])

    expect(analysis.limitUpCount).toBe(1)
    expect(analysis.limitDownCount).toBe(1)
    expect(analysis.brokenLimitUpCount).toBe(1)
    expect(analysis.emotionScore).toBe(60)
    expect(analysis.emotionLabel).toBe('偏暖')
  })

  it('ranks 20-trading-day momentum without treating missing values as zero', () => {
    const analysis = buildStAnalysis([
      { symbol: '1', name: 'ST甲', momentum_20d: 0.12 },
      { symbol: '2', name: '*ST乙', momentum_20d: null },
      { symbol: '3', name: 'ST丙', momentum_20d: -0.08 },
    ])

    expect(analysis.momentum20Count).toBe(2)
    expect(analysis.avgMomentum20).toBeCloseTo(0.02)
    expect(analysis.momentum20Leaders.map(row => row.symbol)).toEqual(['1', '3'])
  })
})
