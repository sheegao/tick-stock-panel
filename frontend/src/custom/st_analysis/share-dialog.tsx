import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, ExternalLink, X } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { copyText } from '@/lib/clipboard'
import { downloadReportImage, drawReportImage, reportText, type ReportLimit, type StDailyReport } from './share'

export function StShareDialog({ report, onClose }: { report: StDailyReport; onClose: () => void }) {
  const [limit, setLimit] = useState<ReportLimit>(10)
  const selected = useMemo(() => ({ ...report, rankings: report.rankings.map(ranking => ({ ...ranking, rows: ranking.rows.slice(0, limit) })) }), [report, limit])
  const [draft, setDraft] = useState(() => reportText(selected))
  const [message, setMessage] = useState('')
  const [imageError, setImageError] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    setDraft(reportText(selected))
    setMessage('')
    setImageError('')
    try {
      if (canvasRef.current) drawReportImage(canvasRef.current, selected)
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片预览失败')
    }
  }, [selected])

  async function copy() {
    setBusy(true)
    try {
      setMessage(await copyText(draft) ? '文案已复制，请到雪球粘贴并确认发布。' : '复制失败，请在文案框中手动全选复制。')
    } catch {
      setMessage('复制失败，请手动全选复制。')
    } finally {
      setBusy(false)
    }
  }

  async function download() {
    if (!canvasRef.current) return
    setBusy(true)
    try {
      await downloadReportImage(canvasRef.current, report.marketDate)
      setMessage('已发起 PNG 下载，请在雪球手动上传。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '图片导出失败')
    } finally {
      setBusy(false)
    }
  }

  return <Modal onClose={onClose} labelledBy="st-share-title" panelClassName="flex max-h-[90vh] w-[94vw] max-w-5xl flex-col overflow-hidden rounded-card border border-border bg-surface shadow-xl">
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div><h2 id="st-share-title" className="text-sm font-semibold">生成雪球日报</h2><p className="mt-1 text-[11px] text-muted">仅生成本地文案和图片，不登录雪球、不自动发布；数据固定为打开预览时的版本。</p></div>
      <button onClick={onClose} aria-label="关闭雪球日报" className="rounded-btn p-1.5 text-muted hover:bg-elevated"><X className="h-4 w-4" /></button>
    </header>
    <div className="overflow-y-auto p-4">
      <label className="flex flex-wrap items-center gap-2 text-xs text-secondary">每个榜单展示
        <select aria-label="榜单数量" value={limit} disabled={busy} onChange={event => setLimit(Number(event.target.value) as ReportLimit)} className="rounded-btn border border-border bg-base px-2 py-1.5">
          <option value={5}>前 5 名</option><option value={10}>前 10 名</option><option value={20}>前 20 名</option>
        </select>
        <span className="text-[11px] text-muted">改变数量会重新生成文案；重要公告最多节选 10 条。</span>
      </label>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section><label htmlFor="st-share-draft" className="text-xs font-medium">雪球文案（可编辑）</label>
          <textarea id="st-share-draft" value={draft} disabled={busy} onChange={event => { setDraft(event.target.value); setMessage('') }} className="mt-2 h-[52vh] min-h-64 w-full resize-y rounded-lg border border-border bg-base p-3 text-xs leading-relaxed text-secondary outline-none focus:border-accent" />
          <p className="mt-1 text-[11px] text-muted">{draft.length} 字符 · 请审核数据口径、日期及公告原文后发布。</p>
        </section>
        <section><h3 className="text-xs font-medium">榜单图片预览</h3><p className="mt-1 text-[11px] text-muted">图片按原始行情数据绘制，不包含对左侧文案的手动编辑。</p>
          {imageError && <p role="alert" className="mt-2 text-xs text-bear">{imageError}</p>}
          <canvas ref={canvasRef} role="img" aria-label="ST 情绪和近 5、10、20 日涨幅榜图片" className="mt-2 h-auto w-full rounded-lg border border-border" />
        </section>
      </div>
    </div>
    <footer className="border-t border-border px-4 py-3">
      <p role="status" aria-live="polite" className="mb-2 min-h-4 text-[11px] text-secondary">{message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => void copy()} disabled={busy || !draft.trim()} className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-2 text-xs text-white disabled:opacity-50"><Copy className="h-3.5 w-3.5" />复制文案</button>
        <button onClick={() => void download()} disabled={busy || !!imageError} className="flex items-center gap-1.5 rounded-btn border border-border px-3 py-2 text-xs text-secondary disabled:opacity-50"><Download className="h-3.5 w-3.5" />导出 PNG</button>
        <a href="https://xueqiu.com/" target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1.5 text-xs text-accent"><ExternalLink className="h-3.5 w-3.5" />打开雪球，手动发布</a>
      </div>
    </footer>
  </Modal>
}
