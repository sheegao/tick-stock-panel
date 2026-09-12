import { request } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useEffect, useState } from 'react'
import type { ChartMarker } from '@/components/EChartsCandlestick'

export type Row = Record<string, unknown>
export interface Run {
  id: string; source_run_id: string; label: string; trading_day: string | null
  mode: string; strategy_id: string | null; broker_provider: string | null
  captured_at: string | null; finished_at: string | null; instance_id: string | null
  is_backtest?: boolean; start_day?: string | null; end_day?: string | null
}
export interface Candidate {
  symbol: string; name: string | null; rank: number | null; score: number | null
  selected: boolean | null; priority: number | null; pool_reason: string | null
  last_price: number | null; change_pct: number | null; decision: Row | null; evidence: Row
}
export interface Detail extends Run {
  status: { runtime: string; runtime_age_seconds: number | null; market_age_seconds: number | null
    portfolio_age_seconds: number | null; connection_statuses: Row[] }
  counts: Row; portfolio: Row; positions: Row[]; candidates: Candidate[]; orders: Row[]
  decisions: Row[]; timeline: Row[]; risk_events: Row[]; risk_counts: Record<string, number>
  quotes: Row[]; summary: Row; warnings: string[]; stop_reason: string | null; read_only: boolean
}
const root = '/api/alphaquant'
export type HistoryKind = 'trades' | 'orders' | 'decisions' | 'positions' | 'candidates' | 'signals'
export interface HistoryPage { rows: Row[]; total: number; offset: number; limit: number; complete: boolean; warnings: string[] }
export interface HistoryOverview { metrics: Row; benchmark: Row; comparison: Row | null; monthly_returns: Row[]; curve: Row[]; days: string[]; daily: Row[]; warnings: string[] }
const historyPath = (id: string) => `${root}/runs/${encodeURIComponent(id)}/backtest`
const historyParams = (day: string, symbol: string, offset = 0) => new URLSearchParams({ day, symbol, offset: String(offset), limit: '100' })
export const alphaApi = {
  runs: () => request<{ runs: Run[] }>(`${root}/runs`, { quiet: true }),
  run: (id: string) => request<Detail>(`${root}/runs/${encodeURIComponent(id)}`, { quiet: true }),
  events: (id: string) => `${root}/runs/${encodeURIComponent(id)}/events`,
  review: (id: string) => `${root}/runs/${encodeURIComponent(id)}/review.md`,
  history: (id: string) => request<HistoryOverview>(historyPath(id), { quiet: true, timeoutMs: 60000 }),
  records: (id: string, kind: HistoryKind, day: string, symbol: string, offset: number) => request<HistoryPage>(`${historyPath(id)}/${kind}?${historyParams(day, symbol, offset)}`, { quiet: true, timeoutMs: 60000 }),
  markers: (id: string, symbol: string) => request<{ markers: ChartMarker[]; warnings: string[] }>(`${historyPath(id)}/markers?${new URLSearchParams({ symbol })}`, { quiet: true, timeoutMs: 60000 }),
  historyReport: (id: string) => `${historyPath(id)}/report.json`,
  historyTrades: (id: string, day: string, symbol: string) => `${historyPath(id)}/trades.json?${historyParams(day, symbol)}`,
}
export const useHistory = (id: string) => useQuery({ queryKey: QK.alphaquantBacktest(id), queryFn: () => alphaApi.history(id), enabled: !!id, staleTime: 60000, refetchOnWindowFocus: false, retry: 1 })
export const useHistoryRecords = (id: string, kind: HistoryKind, day: string, symbol: string, offset: number) => useQuery({ queryKey: QK.alphaquantBacktestRecords(id, kind, day, symbol, offset), queryFn: () => alphaApi.records(id, kind, day, symbol, offset), enabled: !!id, staleTime: 60000, refetchOnWindowFocus: false, retry: 1 })
export const useHistoryMarkers = (id: string, symbol: string) => useQuery({ queryKey: QK.alphaquantBacktestMarkers(id, symbol), queryFn: () => alphaApi.markers(id, symbol), enabled: !!id && !!symbol, staleTime: 60000, refetchOnWindowFocus: false, retry: 1 })
export const ObservationAuto = createContext(true)
export const useRuns = (auto = true, enabled = true) => useQuery({ queryKey: QK.alphaquantRuns, queryFn: alphaApi.runs, enabled, refetchInterval: auto ? 15000 : false, refetchOnWindowFocus: auto, refetchOnReconnect: auto, retry: 1 })
export const useRun = (id: string, auto = true) => useQuery({ queryKey: QK.alphaquantRun(id), queryFn: () => alphaApi.run(id), enabled: !!id, refetchInterval: auto ? 3000 : false, refetchOnWindowFocus: auto, refetchOnReconnect: auto, retry: 1 })
export function useRunEvents(id: string, auto: boolean) {
  const qc = useQueryClient()
  const [state, setState] = useState('未连接')
  useEffect(() => {
    if (!id || !auto) { setState('已暂停'); return }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const source = new EventSource(alphaApi.events(id))
    setState('连接中')
    const invalidate = () => {
      if (disposed || timer) return
      timer = setTimeout(() => { timer = undefined; void qc.invalidateQueries({ queryKey: QK.alphaquantRun(id) }) }, 500)
    }
    source.onopen = () => { if (!disposed) setState('推送已连接') }
    source.onerror = () => { if (!disposed) setState('推送重连中 · 轮询补充') }
    source.addEventListener('update', invalidate)
    source.addEventListener('reset', invalidate)
    return () => { disposed = true; source.close(); clearTimeout(timer) }
  }, [id, auto, qc])
  return state
}
