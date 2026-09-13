import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Activity, Download, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StockPanel } from '@/components/StockPanel'
import { StockPreviewDialog } from '@/components/StockPreviewDialog'
import { cn } from '@/lib/cn'
import { alphaApi, ObservationAuto, useRun, useRunEvents, useRuns, type Detail, type Row, type Run } from './api'
import { chartRange, display, fillMarkers, number, selectRun, symbolRows, time } from './model'
import { AlphaQuantHistory, HistoryRecords } from './history'

const button = 'inline-flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-elevated disabled:opacity-40'
const states: Record<string, string> = { fresh: '快照更新中', stale: '快照已过期', finished: '运行已结束', unknown: '状态未知' }
const modes: Record<string, string> = { demo: '演示数据', dry_run: '模拟执行', live: '实盘', replay: '回放', unknown: '模式未知' }
const labels: Record<string, string> = { signal_emitted: '已发信号', filtered: '已过滤', skipped: '已跳过', FILLED: '全部成交', PARTIALLY_FILLED: '部分成交', CANCELED: '已撤单', SUBMITTED: '已提交', REJECTED: '已拒绝', BUY: '买入', SELL: '卖出' }
const tabs = ['候选与图表', '持仓订单', '风控记录', '决策复盘'] as const

function RunPicker({ runs, value, onChange }: { runs: Run[]; value: string; onChange: (id: string) => void }) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(false)
  const ql = filter.trim().toLowerCase()
  const filtered = ql ? runs.filter(r => r.label.toLowerCase().includes(ql) || r.source_run_id.toLowerCase().includes(ql) || r.id.includes(ql)) : runs
  const selected = runs.find(r => r.id === value)
  const displayText = selected
    ? `${selected.start_day ? `${selected.start_day}→${selected.end_day}` : selected.trading_day || '?'} · ${selected.is_backtest ? '回测' : modes[selected.mode] || selected.mode} · ${selected.label}`
    : '选择策略运行'
  return <div className="relative min-w-0 flex-1 max-w-2xl">
    <div className="flex gap-1">
      <input aria-label="搜索运行" className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm" placeholder="搜索运行名称，如 v3s、2025-poolflow…" value={filter} onChange={e => { setFilter(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} />
      <button type="button" className={cn(button, !open && 'text-accent')} onClick={() => setOpen(o => !o)}>{open ? '收起' : '展开'}</button>
    </div>
    {open && <div className="absolute z-30 mt-1 max-h-96 w-full overflow-y-auto rounded-md border border-border bg-surface shadow-lg">
      {filtered.length === 0 && <p className="px-3 py-4 text-sm text-muted">无匹配运行</p>}
      {filtered.slice(0, 200).map(run => <button key={run.id} type="button" className={cn('block w-full truncate px-3 py-2 text-left text-sm hover:bg-elevated', run.id === value && 'bg-accent/10 text-accent')} onClick={() => { onChange(run.id); setOpen(false) }}>
        {run.start_day ? `${run.start_day} → ${run.end_day}` : run.trading_day || '日期未知'} · {run.is_backtest ? '历史回测' : modes[run.mode] || run.mode} · {run.label} <span className="text-xs text-muted">[{run.id.slice(-6)}]</span>
      </button>)}
      {filtered.length > 200 && <p className="px-3 py-2 text-xs text-muted">仅显示前 200 条，共 {filtered.length} 条，请输入更精确的关键词</p>}
    </div>}
    {!open && selected && <p className="mt-1 truncate text-xs text-muted">{displayText}</p>}
  </div>
}
function Table({ headings, children, empty }: { headings: string[]; children: ReactNode; empty: boolean }) {
  return <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-elevated text-secondary"><tr>{headings.map(h => <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-border">{empty ? <tr><td colSpan={headings.length} className="px-3 py-6 text-center text-muted">此运行暂无记录</td></tr> : children}</tbody></table></div>
}
function Cell({ children }: { children: ReactNode }) { return <td className="px-3 py-2 align-top">{children}</td> }
function StockButton({ symbol, name, onClick }: { symbol: string; name?: string | null; onClick: (symbol: string, name?: string) => void }) {
  return <button className="whitespace-nowrap text-accent hover:underline" onClick={() => onClick(symbol, name || undefined)}>{name || symbol}{name && <span className="ml-2 font-mono text-xs text-muted">{symbol}</span>}</button>
}
function Facts({ rows }: { rows: Row[] }) {
  return <Table headings={['时间（北京时间）', '标的', '结果 / 事件', '原因与依据']} empty={!rows.length}>{rows.slice(-100).reverse().map((row, i) => <tr key={String(row.record_id || row.event_id || i)}>
    <Cell>{time(row.decision_ts_ms ?? row.ts_ms)}</Cell><Cell>{display(row.symbol)}</Cell><Cell>{display(labels[String(row.outcome || row.status)] || row.outcome || row.status || row.kind)}<div className="text-xs text-muted">{display(row.event || row.phase || row.severity)}</div></Cell>
    <Cell>{display(row.reason || row.message)}<details className="mt-1 text-xs text-secondary"><summary className="cursor-pointer">原始依据 / 回报字段</summary><pre className="max-h-52 max-w-xl overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(row, null, 2)}</pre></details></Cell>
  </tr>)}</Table>
}

export function AlphaQuantPage() {
  const [params, setParams] = useSearchParams()
  const [auto, setAuto] = useState(true)
  const [tab, setTab] = useState<typeof tabs[number]>('候选与图表')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<{ symbol: string; name?: string } | null>(null)
  const runs = useRuns(auto)
  const id = selectRun(runs.data?.runs || [], params.get('aq_run'))
  useEffect(() => {
    if (id && !params.get('aq_run')) setParams(prev => { const next = new URLSearchParams(prev); next.set('aq_run', id); return next }, { replace: true })
  }, [id, params, setParams])
  const historicalRun = runs.data?.runs.find(run => run.id === id && run.is_backtest)
  const detail = useRun(historicalRun ? '' : id, auto)
  const stream = useRunEvents(historicalRun ? '' : id, auto)
  const data = detail.data
  const selectedSymbol = params.get('symbol') || data?.candidates[0]?.symbol || ''
  const filtered = data?.candidates.filter(row => `${row.symbol} ${row.name || ''}`.toLowerCase().includes(search.toLowerCase())) || []
  const markers = useMemo(() => fillMarkers(data?.timeline || [], selectedSymbol), [data?.timeline, selectedSymbol])
  const changeRun = (value: string) => { setPreview(null); setSearch(''); setParams(prev => { const next = new URLSearchParams(prev); next.set('aq_run', value); next.delete('symbol'); return next }, { replace: true }) }
  const selectSymbol = (symbol: string) => setParams(prev => { const next = new URLSearchParams(prev); next.set('symbol', symbol); return next }, { replace: true })
  const openStock = (symbol: string, name?: string) => setPreview({ symbol, name })
  const refresh = () => { void runs.refetch(); if (id && !historicalRun) void detail.refetch() }
  return <ObservationAuto.Provider value={auto}><div className="flex h-full min-w-0 flex-col">
    <PageHeader title="AlphaQuant 策略" titleExtra={<span className="rounded bg-accent/10 px-2 py-1 text-xs text-accent">只读观察</span>} />
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 md:p-5">
      <div className="flex flex-wrap items-center gap-3"><RunPicker runs={runs.data?.runs || []} value={id} onChange={changeRun} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />自动刷新</label><button className={button} onClick={refresh}><RefreshCw size={14} />刷新</button><span className="text-xs text-muted">{stream}</span></div>
      {(runs.isError || detail.isError) && <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">观察服务暂不可用。请检查 AlphaQuant Panel 服务与 TSP 后端代理。{data && ' 下方保留的是上次成功读取的快照。'}</div>}
      {!historicalRun && !data && (runs.isPending || (id && detail.isPending)) && <p className="text-sm text-muted">正在读取策略运行…</p>}
      {!runs.isPending && !runs.isError && !id && <EmptyState icon={Activity} title={params.get('aq_run') ? '所选运行已不可用' : '尚无 AlphaQuant 运行'} hint="请指定包含历史 summary.json 或实盘 run_snapshot.json 的运行目录，或重新选择运行；不会自动改用其他账户。" />}
      {historicalRun && <AlphaQuantHistory key={id} run={historicalRun} />}
      {data && <>
        <div className="flex flex-wrap items-center gap-3 text-sm"><span className="rounded bg-warning/10 px-2 py-1 text-warning">{modes[data.mode] || data.mode}</span><span>{states[data.status.runtime] || data.status.runtime}</span><span className="text-secondary">{data.strategy_id} · {data.broker_provider}</span><span className="text-muted">快照 {time(data.captured_at)}</span></div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[['账户权益 / 元', number(data.portfolio.equity)], ['可用资金 / 元', number(data.portfolio.cash_available)], ['策略候选', String(data.candidates.length)], ['活动委托', String(data.orders.filter(row => row.active).length)]].map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-surface p-4"><div className="text-sm text-secondary">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div></div>)}</div>
        <p className="text-xs text-muted">账户 {display(data.portfolio.account_masked)} · 非单策略收益。快照新鲜不代表券商在线。行情 / 策略 / 账户快照年龄：{number(data.status.market_age_seconds, 0)} / {number(data.status.runtime_age_seconds, 0)} / {number(data.status.portfolio_age_seconds, 0)} 秒。</p>
        {data.warnings.length > 0 && <div role="status" className="rounded border border-warning/30 p-3 text-sm text-warning">{data.warnings.join('；')}</div>}
        <nav aria-label="策略运行视图" className="flex gap-2 overflow-x-auto border-b border-border">{tabs.map(item => <button key={item} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm', tab === item ? 'border-accent text-accent' : 'border-transparent text-secondary')}>{item}</button>)}</nav>
        {tab === '候选与图表' && <>
          <input aria-label="搜索策略候选" placeholder="搜索代码或名称" value={search} onChange={e => setSearch(e.target.value)} className="w-full rounded border border-border bg-surface px-3 py-2 text-sm md:max-w-sm" />
          <Table headings={['排名', '标的', '评分', '执行行情 / 元', '涨跌幅', '决策', '图表']} empty={!filtered.length}>{filtered.map(row => <tr key={row.symbol} className={cn('hover:bg-elevated', row.symbol === selectedSymbol && 'bg-accent/5')}><Cell>{display(row.rank)}</Cell><Cell><StockButton symbol={row.symbol} name={row.name} onClick={openStock} /></Cell><Cell>{number(row.score)}</Cell><Cell>{number(row.last_price)}</Cell><Cell>{row.change_pct == null ? '—' : `${number(row.change_pct)}%`}</Cell><Cell>{display(labels[String(row.decision?.outcome)] || row.decision?.outcome)}<div className="max-w-sm text-xs text-muted">{display(row.decision?.reason)}</div></Cell><Cell><button className="whitespace-nowrap text-accent hover:underline" onClick={() => selectSymbol(row.symbol)}>联动图表</button></Cell></tr>)}</Table>
          {selectedSymbol && <section className="rounded-lg border border-border bg-surface p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{selectedSymbol} · 行情与成交日</h2><button className={button} onClick={() => openStock(selectedSymbol)}>打开个股详情</button></div><p className="mb-3 text-xs text-muted">图表使用 TSP 已配置的日线 / 分钟数据源，候选表为 AlphaQuant 执行快照。AQ 标记只表示确认成交的北京时间日期，不代表前复权 K 线上的实际成交价；点选 K 线可联动历史分时。缺行情时请在 TSP 数据源设置中配置，不会生成替代行情。</p><StockPanel key={`${id}:${selectedSymbol}`} symbol={selectedSymbol} dateRange={chartRange(data.trading_day)} markers={markers} height={420} showIntraday showLimitMarkers={false} /></section>}
        </>}
        {tab === '持仓订单' && <PositionsOrders data={data} openStock={openStock} />}
        {tab === '风控记录' && <Facts rows={data.risk_events} />}
        {tab === '决策复盘' && <><a className={button} href={alphaApi.review(id)} download><Download size={14} />下载运行复盘</a><p className="text-xs text-muted">列表显示当前读取窗口最近 100 条；下载范围与观察服务窗口一致，不是全量审计。</p><Facts rows={data.decisions} /></>}
      </>}
    </div>
    <StockPreviewDialog key={id} symbol={preview?.symbol || null} name={preview?.name} onClose={() => setPreview(null)} navList={filtered.map(row => ({ symbol: row.symbol, name: row.name || undefined }))} onNavigate={openStock} />
  </div></ObservationAuto.Provider>
}

function PositionsOrders({ data, openStock }: { data: Detail; openStock: (symbol: string, name?: string) => void }) {
  return <div className="space-y-4"><h2 className="font-medium">账户持仓</h2><Table headings={['标的', '持有 / 股', '可卖 / 股', '成本 / 元', '市值 / 元']} empty={!data.positions.length}>{data.positions.map((row, i) => <tr key={i}><Cell><StockButton symbol={String(row.symbol)} onClick={openStock} /></Cell>{['qty_total', 'qty_available', 'avg_price', 'market_value'].map(key => <Cell key={key}>{number(row[key], key.startsWith('qty') ? 0 : 2)}</Cell>)}</tr>)}</Table>
    <h2 className="font-medium">策略委托</h2><Table headings={['标的', '方向 / 状态', '委托 / 股', '已成交 / 股', '限价 / 元', '成交均价 / 元']} empty={!data.orders.length}>{data.orders.map((row, i) => <tr key={i}><Cell><StockButton symbol={String(row.symbol)} onClick={openStock} /></Cell><Cell>{labels[String(row.side)] || display(row.side)} · {labels[String(row.status)] || display(row.status)}</Cell>{['qty_shares', 'filled_qty_shares', 'limit_price', 'avg_fill_price'].map(key => <Cell key={key}>{number(row[key], key.includes('qty') ? 0 : 2)}</Cell>)}</tr>)}</Table>
    <h2 className="font-medium">最近订单过程（最多 100 条）</h2><Facts rows={data.timeline} /></div>
}

// The same footer is used by watchlist, screener, monitor and this page's
// original TSP stock dialog. It shares the host's QueryClient, not an iframe.
export function AlphaQuantStockFacts({ symbol }: { symbol: string }) {
  const [params, setParams] = useSearchParams()
  const [expanded, setExpanded] = useState(false)
  const auto = useContext(ObservationAuto)
  const runs = useRuns(expanded && auto, expanded)
  const id = selectRun(runs.data?.runs || [], params.get('aq_run'))
  useEffect(() => {
    if (expanded && id && !params.get('aq_run')) setParams(prev => { const next = new URLSearchParams(prev); next.set('aq_run', id); return next }, { replace: true })
  }, [expanded, id, params, setParams])
  const history = runs.data?.runs.find(run => run.id === id)?.is_backtest
  const detail = useRun(expanded && !history ? id : '', expanded && auto)
  return <section className="max-h-[36vh] overflow-auto border-t border-border p-3 text-sm"><button className="text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>AlphaQuant 决策与成交 · {symbol} {expanded ? '收起' : '展开'}</button>
    {expanded && <div className="mt-3 space-y-3"><RunPicker runs={runs.data?.runs || []} value={id} onChange={value => setParams(prev => { const next = new URLSearchParams(prev); next.set('aq_run', value); return next }, { replace: true })} />
      {(runs.isError || detail.isError) && <p role="alert" className="text-danger">AlphaQuant 观察服务暂不可用，不影响 TSP 图表。</p>}
      {!id && !runs.isPending && <p className="text-muted">没有可读取的运行，请选择运行或检查观察目录。</p>}
      {detail.isFetching && !detail.data && <p className="text-muted">读取运行记录…</p>}
      {history && <><p className="text-xs text-muted">历史回测 · 该股全运行范围的分页成交；完整决策与逐日持仓请在 AlphaQuant 页面查看。</p><HistoryRecords key={`${id}:${symbol}`} id={id} kind="trades" symbol={symbol} /></>}
      {detail.data && <><p className="text-xs text-muted">{modes[detail.data.mode] || detail.data.mode} · {detail.data.trading_day} · {detail.data.strategy_id} · {states[detail.data.status.runtime]} · 快照 {time(detail.data.captured_at)} · 与图表选中日期独立的运行记录</p><Facts rows={symbolRows(detail.data.decisions, symbol)} /><Facts rows={symbolRows(detail.data.timeline, symbol)} /></>}
    </div>}
  </section>
}
