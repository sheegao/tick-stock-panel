import type { ChartMarker } from '@/components/EChartsCandlestick'
import type { Row } from './api'

export function selectRun(runs: { id: string }[], requested: string | null): string {
  return requested ? (runs.some(r => r.id === requested) ? requested : '') : (runs[0]?.id ?? '')
}
export function symbolRows(rows: Row[], symbol: string): Row[] {
  return rows.filter(row => row.symbol === symbol)
}
// A marker denotes a confirmed fill day, not a fill price on adjusted candles.
// Never sum cumulative filled_qty_shares across callbacks.
export function fillMarkers(rows: Row[], symbol: string): ChartMarker[] {
  const markers = new Map<string, ChartMarker>()
  for (const row of symbolRows(rows, symbol)) {
    if (row.event !== 'trade_fill' || !['BUY', 'SELL'].includes(String(row.side))) continue
    if (typeof row.ts_ms !== 'number' || !Number.isFinite(row.ts_ms) || row.ts_ms <= 0) continue
    const stamp = new Date(row.ts_ms)
    if (!Number.isFinite(stamp.getTime())) continue
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(stamp)
    const kind = row.side === 'BUY' ? 'buy' : 'sell'
    markers.set(`${date}:${kind}`, { date, kind, label: kind === 'buy' ? 'AQ买入' : 'AQ卖出' })
  }
  return [...markers.values()].sort((a, b) => a.date.localeCompare(b.date))
}
export function chartRange(day: string | null): { start: string; end: string } | undefined {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const date = new Date(`${day}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return undefined
  date.setUTCDate(date.getUTCDate() - 180)
  return { start: date.toISOString().slice(0, 10), end: day }
}
export function display(value: unknown): string {
  if (value == null || value === '') return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
export function number(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'
}
export function time(value: unknown): string {
  if (value == null || value === '') return '—'
  const date = new Date(typeof value === 'number' ? value : String(value))
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—'
}
