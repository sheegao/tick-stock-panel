import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  ArrowDownWideNarrow,
  BadgeAlert,
  CalendarDays,
  ExternalLink,
  Flame,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  ThermometerSun,
  WalletCards,
  Zap,
} from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { StockPreviewDialog, toNavItems } from '@/components/StockPreviewDialog'
import { api, type MarketSnapshotRow, type StAnnouncementsResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { fmtBigNum, fmtPct, priceColorClass } from '@/lib/format'
import { QK } from '@/lib/queryKeys'
import { buildStAnalysis, type StCategory, type StStock } from './model'

type CategoryFilter = 'all' | StCategory
type SortMode = 'change' | 'turnover' | 'amount' | 'market-cap'

const categoryLabels: Record<StCategory, string> = {
  st: 'ST',
  'star-st': '*ST',
}

function numberValue(value: unknown, fallback = Number.NEGATIVE_INFINITY): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function percentValue(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`
}

function qualifiedSymbol(code: string): string {
  if (code.includes('.')) return code
  if (code.startsWith('6')) return `${code}.SH`
  if (/^[489]/.test(code)) return `${code}.BJ`
  return `${code}.SZ`
}

function stockSort(mode: SortMode) {
  const field: keyof MarketSnapshotRow = mode === 'change'
    ? 'change_pct'
    : mode === 'turnover'
      ? 'turnover_rate'
      : mode === 'amount'
        ? 'amount'
        : 'float_market_cap'
  return (a: StStock, b: StStock) => numberValue(b[field]) - numberValue(a[field])
}

export function StAnalysisPage() {
  const [category, setCategory] = useState<CategoryFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('change')
  const [search, setSearch] = useState('')
  const [announcementDate, setAnnouncementDate] = useState('')
  const [preview, setPreview] = useState<{ symbol: string; name?: string } | null>(null)

  const snapshot = useQuery({
    queryKey: QK.marketSnapshot,
    queryFn: api.marketSnapshot,
    staleTime: 60_000,
  })
  const analysis = useMemo(() => buildStAnalysis(snapshot.data?.rows ?? []), [snapshot.data?.rows])
  useEffect(() => {
    if (!announcementDate && snapshot.data?.as_of) setAnnouncementDate(snapshot.data.as_of)
  }, [announcementDate, snapshot.data?.as_of])
  const announcements = useQuery({
    queryKey: QK.stAnnouncements(announcementDate),
    queryFn: () => api.stAnnouncements(announcementDate),
    enabled: !!announcementDate,
    staleTime: 15 * 60_000,
  })

  const visibleStocks = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return analysis.stocks
      .filter(row => category === 'all' || row.stCategory === category)
      .filter(row => !keyword || `${row.name ?? ''} ${row.symbol}`.toLowerCase().includes(keyword))
      .sort(stockSort(sortMode))
  }, [analysis.stocks, category, search, sortMode])

  const gainers = useMemo(
    () => [...analysis.stocks].filter(row => row.change_pct != null).sort(stockSort('change')).slice(0, 5),
    [analysis.stocks],
  )
  const losers = useMemo(
    () => [...analysis.stocks].filter(row => row.change_pct != null).sort((a, b) => numberValue(a.change_pct, Number.POSITIVE_INFINITY) - numberValue(b.change_pct, Number.POSITIVE_INFINITY)).slice(0, 5),
    [analysis.stocks],
  )
  const active = useMemo(
    () => [...analysis.stocks].filter(row => row.amount != null).sort(stockSort('amount')).slice(0, 5),
    [analysis.stocks],
  )

  const openStock = useCallback((symbol: string, name?: string) => setPreview({ symbol, name }), [])

  if (snapshot.isLoading) {
    return <div className="flex h-full items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-muted" /></div>
  }

  if (snapshot.isError) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="ST 板块分析" />
        <EmptyState
          icon={AlertTriangle}
          title="ST 板块数据加载失败"
          hint={snapshot.error instanceof Error ? snapshot.error.message : '请检查后端服务和行情数据后重试'}
        />
      </div>
    )
  }

  return (
    <>
      <PageHeader
        title="ST 板块分析"
        subtitle={`${snapshot.data?.as_of ?? '最新'} · 名称标记口径 · ${analysis.total} 只`}
        titleExtra={<span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">风险观察</span>}
        right={(
          <button
            onClick={() => snapshot.refetch()}
            disabled={snapshot.isFetching}
            className="rounded-btn p-1.5 text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50"
            title="刷新全市场快照"
          >
            <RefreshCw className={cn('h-4 w-4', snapshot.isFetching && 'animate-spin')} />
          </button>
        )}
      />

      <main className="min-h-full bg-[radial-gradient(circle_at_10%_0%,rgba(245,158,11,0.10),transparent_28%),radial-gradient(circle_at_88%_5%,rgba(239,68,68,0.08),transparent_30%)] px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-[1440px] space-y-5">
          <div className="flex items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-xs text-secondary">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <p><span className="font-medium text-foreground">统计口径：</span>与系统涨跌停规则保持一致，根据最新全市场快照中证券简称包含的 ST 风险警示标记识别，并区分 ST 与 *ST；页面展示行情事实，不构成风险评级或交易建议。</p>
          </div>

          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <MetricCard icon={BadgeAlert} label="ST 标的" value={analysis.total} hint={`ST ${analysis.stCount} · *ST ${analysis.starStCount}`} tone="amber" />
            <MetricCard icon={TrendingUp} label="平均涨跌" value={<span className={priceColorClass(analysis.avgChangePct)}>{fmtPct(analysis.avgChangePct)}</span>} hint={`中位数 ${fmtPct(analysis.medianChangePct)}`} tone="red" />
            <MetricCard icon={Activity} label="上涨 / 下跌" value={<><span className="text-bull">{analysis.upCount}</span><span className="mx-1 text-muted">/</span><span className="text-bear">{analysis.downCount}</span></>} hint={`平盘 ${analysis.flatCount} · 缺行情 ${analysis.unknownChangeCount}`} tone="blue" />
            <MetricCard icon={WalletCards} label="成交额" value={fmtBigNum(analysis.totalAmount)} hint={`流通市值 ${fmtBigNum(analysis.totalFloatMarketCap)}`} tone="violet" />
            <MetricCard icon={ArrowDownWideNarrow} label="平均换手" value={percentValue(analysis.avgTurnoverRate)} hint={`${analysis.pricedCount} 只具有涨跌幅`} tone="cyan" />
          </section>

          {analysis.total > 0 ? (
            <>
              <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                <BreadthPanel analysis={analysis} />
                <DistributionPanel analysis={analysis} />
              </section>

              <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.8fr_1.2fr]">
                <EmotionPanel analysis={analysis} />
                <LimitPanel analysis={analysis} onOpen={openStock} />
              </section>

              <Momentum20Panel analysis={analysis} onOpen={openStock} />

              <AnnouncementsPanel
                date={announcementDate}
                maxDate={snapshot.data?.as_of ?? undefined}
                onDateChange={setAnnouncementDate}
                data={announcements.data}
                isLoading={announcements.isLoading}
                isFetching={announcements.isFetching}
                error={announcements.error}
                onRefresh={() => announcements.refetch()}
                onOpen={openStock}
              />

              <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <RankingCard icon={TrendingUp} title="涨幅领先" stocks={gainers} metric={row => fmtPct(row.change_pct)} metricClass={row => priceColorClass(row.change_pct)} onOpen={openStock} />
                <RankingCard icon={TrendingDown} title="跌幅靠前" stocks={losers} metric={row => fmtPct(row.change_pct)} metricClass={row => priceColorClass(row.change_pct)} onOpen={openStock} />
                <RankingCard icon={WalletCards} title="成交活跃" stocks={active} metric={row => fmtBigNum(row.amount)} onOpen={openStock} />
              </section>

              <section className="overflow-hidden rounded-2xl border border-border bg-surface/80 shadow-sm backdrop-blur">
                <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-sm font-semibold">ST 个股明细</h2>
                    <p className="mt-0.5 text-[11px] text-muted">当前筛选 {visibleStocks.length} 只，点击名称查看日 K 与分时</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex rounded-btn border border-border bg-base p-0.5">
                      {([['all', '全部'], ['st', 'ST'], ['star-st', '*ST']] as const).map(([value, label]) => (
                        <button key={value} onClick={() => setCategory(value)} className={cn('rounded px-2.5 py-1 text-xs transition-colors', category === value ? 'bg-elevated text-foreground shadow-sm' : 'text-muted hover:text-foreground')}>{label}</button>
                      ))}
                    </div>
                    <label className="relative">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                      <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索名称或代码" className="h-8 w-44 rounded-btn border border-border bg-base pl-8 pr-3 text-xs outline-none focus:border-accent" />
                    </label>
                    <select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} className="h-8 rounded-btn border border-border bg-base px-2 text-xs outline-none focus:border-accent">
                      <option value="change">按涨跌幅</option>
                      <option value="turnover">按换手率</option>
                      <option value="amount">按成交额</option>
                      <option value="market-cap">按流通市值</option>
                    </select>
                  </div>
                </div>
                <StockTable stocks={visibleStocks} onOpen={openStock} />
              </section>
            </>
          ) : (
            <EmptyState icon={BadgeAlert} title="未识别到 ST 标的" hint="请先完成日线/enriched 数据同步，并确认证券简称已写入全市场快照" />
          )}
        </div>
      </main>

      {preview && (
        <StockPreviewDialog
          symbol={preview.symbol}
          name={preview.name}
          onClose={() => setPreview(null)}
          navList={toNavItems(visibleStocks)}
          onNavigate={(symbol, name) => setPreview({ symbol, name })}
        />
      )}
    </>
  )
}

function MetricCard({ icon: Icon, label, value, hint, tone }: {
  icon: typeof Activity
  label: string
  value: ReactNode
  hint: ReactNode
  tone: 'amber' | 'red' | 'blue' | 'violet' | 'cyan'
}) {
  const tones = {
    amber: 'border-amber-400/20 bg-amber-400/5 text-amber-400',
    red: 'border-red-400/20 bg-red-400/5 text-red-400',
    blue: 'border-blue-400/20 bg-blue-400/5 text-blue-400',
    violet: 'border-violet-400/20 bg-violet-400/5 text-violet-400',
    cyan: 'border-cyan-400/20 bg-cyan-400/5 text-cyan-400',
  }
  return (
    <div className={cn('rounded-2xl border p-4', tones[tone])}>
      <div className="flex items-center gap-2 text-[11px]"><Icon className="h-3.5 w-3.5" /><span>{label}</span></div>
      <div className="mt-2 truncate text-xl font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 truncate text-[11px] text-muted">{hint}</div>
    </div>
  )
}

function BreadthPanel({ analysis }: { analysis: ReturnType<typeof buildStAnalysis> }) {
  const denominator = Math.max(analysis.pricedCount, 1)
  const upPct = analysis.upCount / denominator * 100
  const flatPct = analysis.flatCount / denominator * 100
  const downPct = analysis.downCount / denominator * 100
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 shadow-sm backdrop-blur">
      <h2 className="text-sm font-semibold">板块宽度</h2>
      <p className="mt-1 text-[11px] text-muted">有涨跌幅的 {analysis.pricedCount} 只标的</p>
      <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-elevated">
        <div className="bg-bull" style={{ width: `${upPct}%` }} title={`上涨 ${analysis.upCount}`} />
        <div className="bg-muted" style={{ width: `${flatPct}%` }} title={`平盘 ${analysis.flatCount}`} />
        <div className="bg-bear" style={{ width: `${downPct}%` }} title={`下跌 ${analysis.downCount}`} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        <BreadthValue label="上涨" value={analysis.upCount} percent={upPct} className="text-bull" />
        <BreadthValue label="平盘" value={analysis.flatCount} percent={flatPct} className="text-muted" />
        <BreadthValue label="下跌" value={analysis.downCount} percent={downPct} className="text-bear" />
      </div>
    </div>
  )
}

function BreadthValue({ label, value, percent, className }: { label: string; value: number; percent: number; className: string }) {
  return <div><div className={cn('text-lg font-semibold tabular-nums', className)}>{value}</div><div className="text-[11px] text-muted">{label} · {percent.toFixed(1)}%</div></div>
}

function DistributionPanel({ analysis }: { analysis: ReturnType<typeof buildStAnalysis> }) {
  const max = Math.max(...analysis.distribution.map(bin => bin.count), 1)
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 shadow-sm backdrop-blur">
      <h2 className="text-sm font-semibold">涨跌幅分布</h2>
      <div className="mt-3 space-y-2">
        {analysis.distribution.map(bin => (
          <div key={bin.key} className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2 text-[11px]">
            <span className="text-muted">{bin.label}</span>
            <div className="h-2 overflow-hidden rounded-full bg-elevated">
              <div className={cn('h-full rounded-full', bin.tone === 'up' ? 'bg-bull' : bin.tone === 'down' ? 'bg-bear' : 'bg-muted')} style={{ width: `${bin.count / max * 100}%` }} />
            </div>
            <span className="text-right tabular-nums text-secondary">{bin.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmotionPanel({ analysis }: { analysis: ReturnType<typeof buildStAnalysis> }) {
  const tone = analysis.emotionScore >= 70
    ? 'text-bull'
    : analysis.emotionScore >= 55
      ? 'text-amber-400'
      : analysis.emotionScore >= 40
        ? 'text-foreground'
        : 'text-bear'
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2"><ThermometerSun className="h-4 w-4 text-amber-400" /><h2 className="text-sm font-semibold">ST 情绪温度</h2></div>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div><div className={cn('text-4xl font-semibold tabular-nums', tone)}>{analysis.emotionScore}</div><div className="mt-1 text-xs text-muted">{analysis.emotionLabel} · 100 分制</div></div>
        <Flame className={cn('h-10 w-10', tone)} strokeWidth={1.4} />
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-gradient-to-r from-emerald-500 via-amber-400 to-red-500">
        <div className="h-full border-r-2 border-white/90" style={{ width: `${analysis.emotionScore}%` }} />
      </div>
      <div className="mt-4 space-y-2 text-[11px] text-muted">
        <div className="flex justify-between"><span>上涨家数权重</span><span className="tabular-nums">50%</span></div>
        <div className="flex justify-between"><span>平均涨跌权重</span><span className="tabular-nums">30%</span></div>
        <div className="flex justify-between"><span>涨跌停平衡权重</span><span className="tabular-nums">20%</span></div>
        <p className="border-t border-border pt-2 leading-relaxed">该分数是透明的盘面启发式指标，用于横向观察情绪变化，不代表预测概率。</p>
      </div>
    </div>
  )
}

function LimitPanel({ analysis, onOpen }: {
  analysis: ReturnType<typeof buildStAnalysis>
  onOpen: (symbol: string, name?: string) => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div><div className="flex items-center gap-2"><Zap className="h-4 w-4 text-accent" /><h2 className="text-sm font-semibold">ST 涨跌停分析</h2></div><p className="mt-1 text-[11px] text-muted">使用系统按交易日、板块和风险警示状态计算的价格限制字段</p></div>
        <div className="flex gap-2 text-center">
          <LimitCounter label="涨停" value={analysis.limitUpCount} className="text-bull" />
          <LimitCounter label="跌停" value={analysis.limitDownCount} className="text-bear" />
          <LimitCounter label="炸板" value={analysis.brokenLimitUpCount} className="text-amber-400" />
          <LimitCounter label="翘板" value={analysis.limitDownRecoveryCount} className="text-cyan-400" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <LimitStockGroup title="涨停股" stocks={analysis.limitUpStocks} empty="今日无 ST 涨停" className="border-red-400/20 bg-red-400/5" onOpen={onOpen} />
        <LimitStockGroup title="跌停股" stocks={analysis.limitDownStocks} empty="今日无 ST 跌停" className="border-emerald-400/20 bg-emerald-400/5" onOpen={onOpen} />
      </div>
    </div>
  )
}

function LimitCounter({ label, value, className }: { label: string; value: number; className: string }) {
  return <div className="min-w-10"><div className={cn('text-lg font-semibold tabular-nums', className)}>{value}</div><div className="text-[10px] text-muted">{label}</div></div>
}

function LimitStockGroup({ title, stocks, empty, className, onOpen }: {
  title: string
  stocks: StStock[]
  empty: string
  className: string
  onOpen: (symbol: string, name?: string) => void
}) {
  return (
    <div className={cn('min-h-24 rounded-xl border p-3', className)}>
      <div className="text-[11px] font-medium text-secondary">{title}</div>
      {stocks.length ? <div className="mt-2 flex flex-wrap gap-1.5">{stocks.slice(0, 18).map(stock => <button key={stock.symbol} onClick={() => onOpen(stock.symbol, stock.name ?? undefined)} className="rounded bg-base/70 px-2 py-1 text-[11px] hover:text-accent">{stock.name || stock.symbol} <span className={priceColorClass(stock.change_pct)}>{fmtPct(stock.change_pct)}</span></button>)}</div> : <div className="mt-5 text-center text-[11px] text-muted">{empty}</div>}
    </div>
  )
}

function Momentum20Panel({ analysis, onOpen }: {
  analysis: ReturnType<typeof buildStAnalysis>
  onOpen: (symbol: string, name?: string) => void
}) {
  const leaders = analysis.momentum20Leaders.slice(0, 20)
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface/80 shadow-sm backdrop-blur">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div><div className="flex items-center gap-2"><TrendingUp className="h-4 w-4 text-bull" /><h2 className="text-sm font-semibold">近 20 个交易日涨幅榜</h2></div><p className="mt-1 text-[11px] text-muted">前复权收盘价口径 · 有效 {analysis.momentum20Count} 只 · 平均 {fmtPct(analysis.avgMomentum20)} · 中位 {fmtPct(analysis.medianMomentum20)}</p></div>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/60 md:grid-cols-2 md:divide-x md:divide-y-0 xl:grid-cols-4">
        {[0, 5, 10, 15].map(start => (
          <div key={start} className="divide-y divide-border/60 px-3">
            {leaders.slice(start, start + 5).map((stock, offset) => (
              <button key={stock.symbol} onClick={() => onOpen(stock.symbol, stock.name ?? undefined)} className="flex w-full items-center gap-2 py-2.5 text-left hover:text-accent">
                <span className={cn('w-5 text-center text-xs font-semibold tabular-nums', start + offset < 3 ? 'text-amber-400' : 'text-muted')}>{start + offset + 1}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{stock.name || stock.symbol}</span><span className="text-[10px] text-muted">今日 {fmtPct(stock.change_pct)}</span></span>
                <span className={cn('text-xs font-semibold tabular-nums', priceColorClass(stock.momentum_20d))}>{fmtPct(stock.momentum_20d)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {!leaders.length && <div className="px-4 py-10 text-center text-xs text-muted">历史窗口不足，暂无 20 日动量数据</div>}
    </section>
  )
}

function AnnouncementsPanel({ date, maxDate, onDateChange, data, isLoading, isFetching, error, onRefresh, onOpen }: {
  date: string
  maxDate?: string
  onDateChange: (date: string) => void
  data?: StAnnouncementsResponse
  isLoading: boolean
  isFetching: boolean
  error: Error | null
  onRefresh: () => void
  onOpen: (symbol: string, name?: string) => void
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface/80 shadow-sm backdrop-blur">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div><div className="flex items-center gap-2"><CalendarDays className="h-4 w-4 text-violet-400" /><h2 className="text-sm font-semibold">每日 ST 重要公告</h2></div><p className="mt-1 text-[11px] text-muted">退市/风险警示、重整、监管、债务诉讼、资本运作、交易提示与业绩公告</p></div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} max={maxDate} onChange={event => onDateChange(event.target.value)} className="h-8 rounded-btn border border-border bg-base px-2 text-xs outline-none focus:border-accent" />
          <button onClick={onRefresh} disabled={isFetching || !date} className="rounded-btn p-1.5 text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50" title="刷新公告"><RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} /></button>
        </div>
      </div>
      {data?.partial && <div className="border-b border-amber-400/20 bg-amber-400/5 px-4 py-2 text-[11px] text-amber-400">部分关键词查询失败或结果超出分页上限，本次列表可能不完整。</div>}
      {isLoading ? <div className="flex items-center justify-center gap-2 px-4 py-12 text-xs text-muted"><RefreshCw className="h-4 w-4 animate-spin" />正在从巨潮资讯获取公告…</div> : error ? <div className="px-4 py-10 text-center text-xs text-bear">{error.message || '公告查询失败，请稍后重试'}</div> : data?.items.length ? (
        <div className="divide-y divide-border/60">
          {data.items.map(item => (
            <div key={item.id} className="flex flex-col gap-2 px-4 py-3 hover:bg-elevated/40 sm:flex-row sm:items-center">
              <button onClick={() => onOpen(qualifiedSymbol(item.symbol), item.name)} className="w-36 shrink-0 text-left hover:text-accent"><span className="block truncate text-xs font-medium">{item.name || item.symbol}</span><span className="text-[10px] text-muted">{item.symbol}</span></button>
              <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><span className={cn('rounded px-1.5 py-0.5 text-[10px]', item.importance === 'high' ? 'bg-red-400/10 text-red-400' : 'bg-amber-400/10 text-amber-400')}>{item.category}</span><span className="text-xs text-foreground">{item.title}</span></div><div className="mt-1 text-[10px] text-muted">{item.published_at ? new Date(item.published_at).toLocaleString('zh-CN', { hour12: false }) : date}</div></div>
              {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-[11px] text-accent hover:underline">公告原文<ExternalLink className="h-3 w-3" /></a>}
            </div>
          ))}
        </div>
      ) : <div className="px-4 py-10 text-center text-xs text-muted">该日未检索到当前 ST 标的的重要公告</div>}
      {data && <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[10px] text-muted"><span>{data.cached ? '15 分钟缓存' : '刚刚获取'} · 仅按标题关键词筛选</span><a href={data.source.url} target="_blank" rel="noreferrer" className="hover:text-accent">来源：{data.source.name}</a></div>}
    </section>
  )
}

function RankingCard({ icon: Icon, title, stocks, metric, metricClass, onOpen }: {
  icon: typeof TrendingUp
  title: string
  stocks: StStock[]
  metric: (stock: StStock) => string
  metricClass?: (stock: StStock) => string
  onOpen: (symbol: string, name?: string) => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface/80 p-4 shadow-sm backdrop-blur">
      <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-accent" /><h2 className="text-sm font-semibold">{title}</h2></div>
      <div className="mt-3 divide-y divide-border/70">
        {stocks.map((stock, index) => (
          <button key={stock.symbol} onClick={() => onOpen(stock.symbol, stock.name ?? undefined)} className="flex w-full items-center gap-3 py-2 text-left hover:text-accent">
            <span className="w-4 text-[10px] tabular-nums text-muted">{index + 1}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{stock.name || stock.symbol}</span><span className="block text-[10px] text-muted">{stock.symbol}</span></span>
            <span className={cn('text-xs font-medium tabular-nums', metricClass?.(stock))}>{metric(stock)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function StockTable({ stocks, onOpen }: { stocks: StStock[]; onOpen: (symbol: string, name?: string) => void }) {
  return (
    <div className="max-h-[38rem] overflow-auto">
      <table className="w-full min-w-[920px] text-xs">
        <thead className="sticky top-0 z-10 bg-surface text-[11px] text-muted">
          <tr className="border-b border-border">
            {['证券', '类别', '最新价', '涨跌幅', '成交额', '换手率', '量比(5日)', '流通市值', '连板'].map(title => <th key={title} className="px-4 py-2.5 text-right font-medium first:text-left">{title}</th>)}
          </tr>
        </thead>
        <tbody>
          {stocks.map(stock => (
            <tr key={stock.symbol} className="border-b border-border/60 transition-colors last:border-0 hover:bg-elevated/60">
              <td className="px-4 py-2.5">
                <button onClick={() => onOpen(stock.symbol, stock.name ?? undefined)} className="text-left hover:text-accent">
                  <span className="block font-medium">{stock.name || '—'}</span>
                  <span className="text-[10px] text-muted">{stock.symbol}</span>
                </button>
              </td>
              <td className="px-4 py-2.5 text-right"><span className={cn('rounded px-1.5 py-0.5 text-[10px]', stock.stCategory === 'star-st' ? 'bg-red-400/10 text-red-400' : 'bg-amber-400/10 text-amber-400')}>{categoryLabels[stock.stCategory]}</span></td>
              <td className="px-4 py-2.5 text-right tabular-nums">{stock.close?.toFixed(2) ?? '—'}</td>
              <td className={cn('px-4 py-2.5 text-right font-medium tabular-nums', priceColorClass(stock.change_pct))}>{fmtPct(stock.change_pct)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{fmtBigNum(stock.amount)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{percentValue(stock.turnover_rate)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{stock.vol_ratio_5d?.toFixed(2) ?? '—'}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{fmtBigNum(stock.float_market_cap)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{stock.consecutive_limit_ups ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stocks.length === 0 && <div className="px-4 py-14 text-center text-sm text-muted">当前筛选没有匹配的 ST 标的</div>}
    </div>
  )
}
