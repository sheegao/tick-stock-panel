import { describe, expect, it } from 'vitest'
import type { StAnnouncementsResponse } from '@/lib/api'
import { buildStAnalysis } from './model'
import { buildStDailyReport, reportText } from './share'

const announcements: StAnnouncementsResponse = {
  date: '2026-09-15', items: [], partial: false, cached: true,
  source: { name: '巨潮资讯', url: 'https://www.cninfo.com.cn/' }, retrieved_at: '2026-09-16T18:00:00+08:00',
}

describe('雪球日报', () => {
  it('keeps independent trading windows, units and dates without exposing unrelated fields', () => {
    const analysis = buildStAnalysis([
      { symbol: '000001.SZ', name: 'ST甲', change_pct: 0.05, momentum_5d: 0.12, momentum_10d: -0.02, account_id: 'SECRET', token: 'SECRET' },
      { symbol: '600001.SH', name: '*ST乙', momentum_5d: 0.08, momentum_10d: 0.15 },
    ])
    const report = buildStDailyReport('2026-09-16', analysis, announcements, 5)
    const text = reportText(report)
    expect(text).toContain('行情日期：2026-09-16')
    expect(text).toContain('公告日期：2026-09-15')
    expect(text).toContain('+12.00%')
    expect(text).toContain('-2.00%')
    expect(report.rankings[1].rows[0].name).toBe('*ST乙')
    expect(text).toContain('N 根日线')
    expect(text).not.toContain('SECRET')
    expect(text).toContain('日期不同')
    expect(report.rankings[0].rows[0]).not.toHaveProperty('token')
  })

  it('does not publish a neutral emotion score when no price data exists', () => {
    const report = buildStDailyReport(null, buildStAnalysis([]), undefined, 10)
    expect(report.emotion).toBe('数据不足')
    expect(reportText(report)).toContain('未加载')
    expect(reportText(report)).not.toContain('50/100')
  })

  it('retains completeness, historical evidence and stale warnings and omits ordinary notices', () => {
    const data: StAnnouncementsResponse = { ...announcements, partial: true, stale: true, history_warning: true, items: [
      { id: '1', symbol: '000001', name: 'ST甲', title: '重整进展', category: '重整进展', importance: 'high', url: 'https://static.cninfo.com.cn/finalpage/test.PDF', published_at: null },
      { id: '2', symbol: '000001', name: 'ST甲', title: '普通通知', category: '其他公告', importance: 'low', url: null, published_at: null },
    ] }
    const report = buildStDailyReport('2026-09-15', buildStAnalysis([]), data, 5)
    expect(report.notices).toHaveLength(1)
    expect(reportText(report)).toContain('不完整')
    expect(reportText(report)).toContain('旧档案')
    expect(reportText(report)).toContain('公告时简称')
    expect(reportText(report)).toContain('https://static.cninfo.com.cn/finalpage/test.PDF')
  })

  it('limits candidate lists and distinguishes an empty list from a fetch error', () => {
    const analysis = buildStAnalysis(Array.from({ length: 25 }, (_, i) => ({ symbol: `${i}`, name: `ST${i}`, momentum_5d: i / 100 })))
    expect(buildStDailyReport('2026-09-15', analysis, announcements, 5).rankings[0].rows).toHaveLength(5)
    expect(reportText(buildStDailyReport('2026-09-15', analysis, announcements, 5))).toContain('未发现')
    expect(reportText(buildStDailyReport('2026-09-15', analysis, undefined, 5, '查询失败'))).toContain('查询失败')
  })
})
