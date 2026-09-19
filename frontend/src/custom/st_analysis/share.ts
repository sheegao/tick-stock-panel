import type { StAnnouncementsResponse } from '@/lib/api'
import { fmtPct } from '@/lib/format'
import type { StAnalysis } from './model'

export type ReportLimit = 5 | 10 | 20
export interface StDailyReport {
  marketDate: string
  announcementDate: string
  total: number
  emotion: string
  breadth: string
  limits: string
  average: string
  rankings: { days: 5 | 10 | 20; count: number; rows: { name: string; symbol: string; value: number }[] }[]
  notices: { name: string; symbol: string; title: string; category: string; url: string | null }[]
  announcementSummary: string
  retrievedAt: string | null
  warnings: string[]
}

const clean = (value: string | null | undefined) => String(value ?? '').replace(/[\r\n\t]/g, ' ').trim()
const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null

export function buildStDailyReport(
  asOf: string | null, analysis: StAnalysis, announcements: StAnnouncementsResponse | undefined,
  limit: ReportLimit, announcementError?: string,
): StDailyReport {
  const warnings: string[] = []
  if (!analysis.pricedCount) warnings.push('缺少有效涨跌幅，情绪分数不可用于判断。')
  if (announcements && announcements.date !== asOf) warnings.push('行情与公告日期不同，历史公告不代表当日行情。')
  if (announcements?.partial) warnings.push('公告采集不完整，可能遗漏披露。')
  if (announcements?.stale) warnings.push('公告源刷新失败，当前为旧档案，请核对采集时间。')
  if (announcements?.history_warning) warnings.push('部分历史 ST 身份按公告时简称识别，尚未完整核验。')
  if (announcementError) warnings.push('公告查询失败，所附公告档案可能不是最新结果。')
  const important = (announcements?.items ?? []).filter(item => item.importance !== 'low')
  return {
    marketDate: clean(asOf) || '未加载', announcementDate: announcements ? clean(announcements.date) : '未加载',
    total: analysis.total,
    emotion: analysis.pricedCount ? `${analysis.emotionScore}/100 · ${analysis.emotionLabel}` : '数据不足',
    breadth: `上涨 ${analysis.upCount} / 下跌 ${analysis.downCount} / 平盘 ${analysis.flatCount} / 缺数据 ${analysis.unknownChangeCount}`,
    limits: `涨停 ${analysis.limitUpCount} / 跌停 ${analysis.limitDownCount} / 炸板 ${analysis.brokenLimitUpCount} / 翘板 ${analysis.limitDownRecoveryCount}`,
    average: `${fmtPct(analysis.avgChangePct)} · 中位 ${fmtPct(analysis.medianChangePct)}`,
    // Only public market fields enter the export; never serialize raw snapshot rows.
    rankings: ([5, 10, 20] as const).map(days => ({ days, count: analysis.momentumRanks[days].count,
      rows: analysis.momentumRanks[days].leaders.slice(0, limit).map(stock => ({
        name: clean(stock.name) || clean(stock.symbol), symbol: clean(stock.symbol),
        value: finite(stock[`momentum_${days}d`]) as number,
      })),
    })),
    notices: important.slice(0, 10).map(item => ({
      name: clean(item.name), symbol: clean(item.symbol), title: clean(item.title), category: clean(item.category),
      url: item.url?.startsWith('https://static.cninfo.com.cn/') ? item.url : null,
    })),
    announcementSummary: !announcements ? (announcementError ? '公告查询失败，未附公告。' : '公告未加载，未附公告。')
      : important.length ? `已加载的重要公告 ${important.length} 条，节选前 ${Math.min(10, important.length)} 条。`
        : '已加载档案中未发现标题规则识别的重要公告，不代表不存在风险。',
    retrievedAt: announcements?.retrieved_at ?? null, warnings,
  }
}

export function reportText(report: StDailyReport): string {
  const lines = [`ST 板块观察｜${report.marketDate}`, '#ST观察#', '', `行情日期：${report.marketDate}`, `ST 标的：${report.total} 只`,
    `情绪温度：${report.emotion}`, report.breadth, report.limits, `平均涨跌：${report.average}`]
  for (const ranking of report.rankings) {
    lines.push('', `近 ${ranking.days} 个交易日涨幅榜（有效 ${ranking.count} 只）`)
    if (!ranking.rows.length) lines.push('历史窗口不足，暂无有效数据。')
    ranking.rows.forEach((stock, index) => lines.push(`${index + 1}. ${stock.name}（${stock.symbol}） ${fmtPct(stock.value)}`))
  }
  lines.push('', `公告日期：${report.announcementDate}`, report.announcementSummary)
  report.notices.forEach((notice, index) => {
    lines.push(`${index + 1}. ${notice.name}（${notice.symbol}）｜${notice.category}｜${notice.title}`)
    if (notice.url) lines.push(`原文：${notice.url}`)
  })
  if (report.retrievedAt) lines.push(`公告采集时间：${report.retrievedAt}`)
  if (report.warnings.length) lines.push('', '数据提示：', ...report.warnings.map(warning => `- ${warning}`))
  lines.push('', '口径：ST 按行情快照简称识别；涨幅为前复权收盘价 / N 根日线前收盘价 − 1，停牌缺记录不补造日线；盘中可能未收盘。情绪为盘面启发式指标，公告重要性按标题规则识别。',
    '来源：TSP 已同步行情、巨潮资讯公告。以上仅为数据观察，不构成投资建议；重要事项请核对公告原文。')
  return lines.join('\n')
}

export function drawReportImage(canvas: HTMLCanvasElement, report: StDailyReport): void {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法生成图片，请复制文案。')
  const ctx = context
  const rowCount = Math.max(...report.rankings.map(ranking => ranking.rows.length), 1)
  canvas.width = 1320
  canvas.height = 430 + rowCount * 56 + report.warnings.length * 54
  const font = '"Microsoft YaHei", "PingFang SC", sans-serif'
  ctx.fillStyle = '#0d1424'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  function text(value: string, x: number, y: number, size = 22, color = '#e7edf7', maxWidth?: number) {
    ctx.font = `${size}px ${font}`
    ctx.fillStyle = color
    if (maxWidth === undefined) ctx.fillText(value, x, y)
    else ctx.fillText(value, x, y, maxWidth)
  }
  text('ST 板块观察', 40, 58, 34)
  text(`行情 ${report.marketDate} · ST ${report.total} 只 · TSP`, 40, 94, 20, '#9aacc5')
  text(`情绪 ${report.emotion}     平均涨跌 ${report.average}`, 40, 140, 24, '#ffd477')
  text(report.breadth, 40, 179, 22)
  text(report.limits, 40, 215, 22)
  report.rankings.forEach((ranking, column) => {
    const left = 40 + column * 424
    text(`近 ${ranking.days} 个交易日`, left, 272, 26)
    text(`有效 ${ranking.count} 只 · 展示 ${ranking.rows.length} 只`, left, 302, 18, '#9aacc5')
    if (!ranking.rows.length) text('历史窗口不足', left, 350, 20, '#9aacc5')
    ranking.rows.forEach((stock, index) => {
      const y = 345 + index * 56
      ctx.fillStyle = '#263146'
      ctx.fillRect(left, y + 30, 394, 1)
      text(`${index + 1}. ${stock.name}`, left, y, 22, '#e7edf7', 258)
      text(stock.symbol, left + 26, y + 24, 15, '#9aacc5')
      text(fmtPct(stock.value), left + 274, y, 22, stock.value > 0 ? '#ff7777' : stock.value < 0 ? '#54d6a5' : '#9aacc5', 120)
    })
  })
  let y = 350 + rowCount * 56
  report.warnings.forEach(warning => {
    text(`提示：${warning}`, 40, y, 20, '#ffd477', 1240)
    y += 54
  })
  text(`公告日期 ${report.announcementDate} · 公告摘要与原文链接见配套文案`, 40, y, 18, '#9aacc5')
  text('前复权 / N 根日线口径 · 盘中可能未收盘 · ST 简称标记口径 · 不构成投资建议', 40, y + 32, 18, '#9aacc5')
}

export async function downloadReportImage(canvas: HTMLCanvasElement, date: string): Promise<void> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG 生成失败，请重试。')), 'image/png'))
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `TSP-ST-${date.replace(/[^0-9-]/g, '') || 'undated'}.png`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }
}
