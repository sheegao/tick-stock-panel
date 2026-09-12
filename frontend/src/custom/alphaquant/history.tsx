import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { EChartsOption } from 'echarts'
import { Download, RefreshCw, X } from 'lucide-react'
import { StockPanel } from '@/components/StockPanel'
import { useECharts } from '@/pages/backtest/charts/useECharts'
import { useChartTheme } from '@/lib/theme'
import { QK } from '@/lib/queryKeys'
import { cn } from '@/lib/cn'
import { alphaApi, useHistory, useHistoryRecords, useHistoryMarkers, type HistoryKind, type Row, type Run } from './api'
import { chartRange, display, number, time } from './model'

const button = 'inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm hover:bg-elevated disabled:opacity-40'
const input = 'min-w-0 rounded border border-border bg-surface px-3 py-2 text-sm'
const kinds: [HistoryKind, string][] = [['trades', '成交明细'], ['orders', '历史委托'], ['decisions', '决策日志'], ['positions', '逐日持仓'], ['candidates', '逐日候选'], ['signals', '策略信号']]
const translations: Record<string, string> = { BUY: '买入', SELL: '卖出', FILLED: '全部成交', CANCELED: '已撤单', PARTIALLY_FILLED: '部分成交', REJECTED: '已拒绝', UNKNOWN: '未知', SUBMITTED: '已提交', signal_emitted: '已发信号', filtered: '已过滤', skipped: '已跳过' }
const columns: Record<HistoryKind, [string, string][]> = {
  trades: [['side', '方向'], ['fill_qty_shares', '成交 / 股'], ['fill_price', '成交价 / 元'], ['fill_turnover', '成交额 / 元']],
  orders: [['side', '方向'], ['status', '归档状态'], ['qty_shares', '委托 / 股'], ['filled_qty_shares', '已成交 / 股'], ['limit_price', '限价 / 元'], ['avg_fill_price', '成交均价 / 元']],
  decisions: [['phase', '阶段'], ['outcome', '结果'], ['reason', '原因']],
  positions: [['qty_total', '持有 / 股'], ['qty_available', '可卖 / 股'], ['avg_price', '成本 / 元'], ['market_value', '市值 / 元']],
  candidates: [['rank', '排名'], ['score', '评分'], ['selected', '选中'], ['pool_reason', '入池原因']],
  signals: [['action', '方向'], ['strategy_id', '策略'], ['reason', '原因'], ['signal_id', '信号 ID']],
}
function value(field: string, v: unknown) {
  if (typeof v === 'number') return number(v, field.includes('qty') || field === 'rank' ? 0 : 4)
  if (typeof v === 'boolean') return v ? '是' : '否'
  return translations[String(v)] || display(v)
}
function Warnings({ warnings }: { warnings?: string[] }) {
  return warnings?.length ? <div role="status" className="rounded border border-warning/30 p-3 text-sm text-warning">{warnings.join('；')}</div> : null
}

function PerformanceChart({ curve }: { curve: Row[] }) {
  const ct = useChartTheme()
  const [view, setView] = useState('return')
  const option = useMemo<EChartsOption | null>(() => {
    if (!curve.length) return null
    const series = view === 'equity' ? [['账户权益 / 元', 'equity']] : view === 'drawdown' ? [['回撤 / %', 'drawdown_pct']] : [['策略累计收益 / %', 'strategy_return_pct'], ['基准累计收益 / %', 'benchmark_return_pct']]
    return {
      animation: false, color: ['#3b82f6', '#f59e0b'],
      legend: { textStyle: { color: ct.text }, top: 0 },
      tooltip: { trigger: 'axis', renderMode: 'richText', backgroundColor: ct.tooltipBg, textStyle: { color: ct.tooltipText } },
      grid: { left: 78, right: 24, top: 45, bottom: 70 },
      xAxis: { type: 'category', data: curve.map(r => String(r.trading_day)), axisLabel: { color: ct.text }, axisLine: { lineStyle: { color: ct.border } } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: ct.text }, splitLine: { lineStyle: { color: ct.grid } } },
      dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8, textStyle: { color: ct.text }, borderColor: ct.border }],
      series: series.map(([name, key]) => ({ name, type: 'line' as const, connectNulls: false, showSymbol: curve.length < 20, data: curve.map(r => typeof r[key] === 'number' ? r[key] as number : null) })),
    }
  }, [curve, view, ct])
  const chart = useECharts(option)
  return <section className="rounded-lg border border-border bg-surface p-3"><div className="mb-3 flex flex-wrap gap-2">{[['return', '累计收益'], ['equity', '账户权益'], ['drawdown', '回撤']].map(([key, label]) => <button key={key} className={cn(button, view === key && 'text-accent')} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div>{curve.length ? <div ref={chart} role="img" aria-label="历史回测绩效曲线" className="h-80 w-full" /> : <p className="p-8 text-center text-muted">未保存可用的净值曲线</p>}</section>
}

export function HistoryRecords({ id, kind, day = '', symbol = '', onStock }: { id: string; kind: HistoryKind; day?: string; symbol?: string; onStock?: (symbol: string, day: string) => void }) {
  const [offset, setOffset] = useState(0)
  const result = useHistoryRecords(id, kind, day, symbol, offset)
  const data = result.data
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3 text-sm"><span>{data ? `${data.complete ? '共' : '已读取（不完整）'} ${data.total} 条 · 第 ${Math.floor(offset / 100) + 1} 页` : '正在读取历史记录…'}</span><button className={button} disabled={!offset || result.isFetching} onClick={() => setOffset(o => Math.max(0, o - 100))}>上一页</button><button className={button} disabled={!data || offset + 100 >= data.total || result.isFetching} onClick={() => setOffset(o => o + 100)}>下一页</button>{kind === 'trades' && <a className={button} href={alphaApi.historyTrades(id, day, symbol)} download><Download size={14} />导出筛选范围全部成交</a>}</div>
    {result.isError && <p role="alert" className="text-danger">历史明细读取失败，未用其他运行替代。<button className="ml-2 underline" onClick={() => void result.refetch()}>重试</button></p>}
    <Warnings warnings={data?.warnings} />
    {data && <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full text-left text-sm"><thead className="bg-elevated text-secondary"><tr>{['交易日 / 北京时间', '标的', ...columns[kind].map(c => c[1]), '依据'].map(h => <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-border">{data.rows.map((row, i) => <tr key={`${offset}:${i}`} className="hover:bg-elevated"><td className="whitespace-nowrap px-3 py-2">{display(row.trading_day)}<div className="text-xs text-muted">{time(row.exchange_ts_ms ?? row.decision_ts_ms ?? row.created_ts_ms)}</div></td><td className="px-3 py-2">{onStock && row.symbol ? <button className="whitespace-nowrap text-accent hover:underline" onClick={() => onStock(String(row.symbol), String(row.trading_day || ''))}>{display(row.symbol)}</button> : display(row.symbol)}</td>{columns[kind].map(([field]) => <td key={field} className="max-w-sm px-3 py-2">{value(field, row[field])}</td>)}<td className="px-3 py-2"><details><summary className="cursor-pointer whitespace-nowrap text-accent">原始字段</summary><pre className="max-h-52 w-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row, null, 2)}</pre></details></td></tr>)}{!data.rows.length && <tr><td colSpan={columns[kind].length + 3} className="px-3 py-8 text-center text-muted">{data.complete ? '当前筛选条件没有记录' : '没有可显示记录，请检查上方缺失 / 损坏提示'}</td></tr>}</tbody></table></div>}
  </div>
}

function HistoricalStock({ id, symbol, day, close }: { id: string; symbol: string; day: string; close: () => void }) {
  const markers = useHistoryMarkers(id, symbol)
  return <section className="space-y-3 rounded-lg border border-border bg-surface p-3"><div className="flex items-center justify-between"><h2 className="font-medium">{symbol} · 历史行情与 AQ 成交日</h2><button className={button} aria-label="关闭历史个股图表" onClick={close}><X size={14} /></button></div><p className="text-xs text-muted">行情来自 TSP 已配置数据源；成交日标记覆盖本次运行该股全部成交，不受表格分页影响。标记不是复权 K 线上的成交价格。点击 K 线可查看历史分时；缺行情不会伪造替代数据。</p><Warnings warnings={markers.data?.warnings} />{markers.isError && <p role="alert" className="text-danger">成交日标记读取失败；行情不受影响。</p>}<StockPanel key={`${id}:${symbol}:${day}`} symbol={symbol} dateRange={chartRange(day || null)} markers={markers.data?.markers || []} height={380} showIntraday showLimitMarkers={false} /></section>
}

export function AlphaQuantHistory({ run }: { run: Run }) {
  const overview = useHistory(run.id)
  const qc = useQueryClient()
  const [kind, setKind] = useState<HistoryKind | 'performance'>('performance')
  const [day, setDay] = useState('')
  const [draft, setDraft] = useState('')
  const [symbol, setSymbol] = useState('')
  const [stock, setStock] = useState<{ symbol: string; day: string } | null>(null)
  const data = overview.data
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-3 text-sm"><span className="rounded bg-accent/10 px-2 py-1 text-accent">历史回测 · 归档只读</span><span>{run.start_day || data?.days[0] || '日期未知'} → {run.end_day || data?.days.at(-1) || '日期未知'}</span><span className="text-secondary">{run.strategy_id} · {data?.days.length ?? '—'} 个交易日</span><button className={button} onClick={() => void qc.invalidateQueries({ queryKey: QK.alphaquantBacktest(run.id) })}><RefreshCw size={14} />重新读取归档</button><a className={button} href={alphaApi.historyReport(run.id)} download><Download size={14} />下载绩效报告</a></div>
    <p className="text-xs text-muted">读取 AlphaQuant 已保存的回测产物，不启动策略、不连接券商。收益指标沿用原报告；日胜率不是逐笔交易胜率，缺失指标显示 —。</p>
    {overview.isPending && <p className="text-muted">正在读取历史绩效…</p>}
    {overview.isError && <p role="alert" className="text-danger">历史绩效读取失败，请检查服务后重新读取归档。</p>}
    <Warnings warnings={data?.warnings} />
    <nav aria-label="历史回测视图" className="flex gap-2 overflow-x-auto border-b border-border">{[['performance', '绩效曲线'], ...kinds].map(([key, label]) => <button key={key} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm', kind === key ? 'border-accent text-accent' : 'border-transparent text-secondary')} aria-current={kind === key ? 'page' : undefined} onClick={() => setKind(key as typeof kind)}>{label}</button>)}</nav>
    {kind === 'performance' && data && <>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[['final_value', '期末权益 / 元'], ['total_return_pct', '累计收益 / %'], ['annualized_return_pct', '年化收益 / %'], ['max_drawdown_pct', '最大回撤 / %'], ['sharpe_ratio', '夏普比率'], ['win_rate_pct', '日胜率 / %'], ['initial_value', '初始权益 / 元'], ['total_pnl', '累计盈亏 / 元']].map(([key, label]) => <div key={key} className="rounded-lg border border-border bg-surface p-4"><div className="text-sm text-secondary">{label}</div><div className="mt-2 text-2xl font-semibold tabular-nums">{number(data.metrics[key])}</div></div>)}</div>
      <PerformanceChart curve={data.curve} />
      <p className="text-xs text-muted">基准：{display(data.benchmark.name)} {display(data.benchmark.symbol)}。曲线按保存的权益归一化；回撤优先使用原报告，缺失时仅从权益绘制。基准缺失日期不插值、不补零。</p>
      <details className="rounded border border-border p-3"><summary className="cursor-pointer text-sm">完整绩效指标、月度收益与基准比较（原始字段）</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ strategy_metrics: data.metrics, monthly_returns: data.monthly_returns, benchmark: data.benchmark, comparison: data.comparison }, null, 2)}</pre></details>
      <div className="overflow-x-auto rounded border border-border"><table className="w-full text-left text-sm"><thead className="bg-elevated"><tr>{['交易日', '期末权益 / 元', '当日收益 / %', '累计收益 / %', '回撤 / %'].map(h => <th className="px-3 py-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.curve.map(r => <tr key={String(r.trading_day)} className="border-t border-border"><td className="px-3 py-2"><button className="text-accent" onClick={() => { setDay(String(r.trading_day)); setKind('trades') }}>{display(r.trading_day)}</button></td>{['equity', 'day_return_pct', 'strategy_return_pct', 'drawdown_pct'].map(k => <td className="px-3 py-2" key={k}>{number(r[k])}</td>)}</tr>)}</tbody></table></div>
    </>}
    {kind !== 'performance' && <>
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); setSymbol(draft.trim().toUpperCase()) }}><select aria-label="历史交易日" className={input} value={day} onChange={e => setDay(e.target.value)}><option value="">全部交易日</option>{data?.days.map(d => <option key={d} value={d}>{d}</option>)}</select><input aria-label="历史股票筛选" className={input} value={draft} placeholder="股票代码，如 600000.SH" onChange={e => setDraft(e.target.value)} /><button className={button} type="submit">应用筛选</button><button className={button} type="button" onClick={() => { setDay(''); setDraft(''); setSymbol('') }}>清除筛选</button><span className="text-xs text-muted">生效股票筛选：{symbol || '全部'} · 每页 100 条</span></form>
      {kind === 'orders' && <p className="text-xs text-muted">按 order_intent_id 关联回报与成交，不跨日合并重复券商编号。累计成交回报不叠加；所有委托均为历史记录，不代表当前活动订单。</p>}
      {kind === 'candidates' && <p className="text-xs text-muted">候选取各日保存的最终状态，不代表盘中每个时刻的完整候选变化；详细过程请查决策日志。</p>}
      <HistoryRecords key={`${run.id}:${kind}:${day}:${symbol}`} id={run.id} kind={kind} day={day} symbol={symbol} onStock={(s, d) => setStock({ symbol: s, day: d || run.end_day || '' })} />
    </>}
    {stock && <HistoricalStock id={run.id} symbol={stock.symbol} day={stock.day} close={() => setStock(null)} />}
  </div>
}
