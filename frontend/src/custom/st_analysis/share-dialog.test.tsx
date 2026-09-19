// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildStAnalysis } from './model'
import { buildStDailyReport } from './share'
import { StShareDialog } from './share-dialog'

const mocks = vi.hoisted(() => ({ copy: vi.fn(), png: vi.fn() }))
vi.mock('@/lib/clipboard', () => ({ copyText: mocks.copy }))
vi.mock('./share', async importOriginal => ({ ...await importOriginal<typeof import('./share')>(), downloadReportImage: mocks.png }))
let host: HTMLDivElement
let root: Root
const close = vi.fn()

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.copy.mockReset().mockResolvedValue(true)
  mocks.png.mockReset().mockResolvedValue(undefined)
  close.mockReset()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), fillText: vi.fn() } as unknown as CanvasRenderingContext2D)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const analysis = buildStAnalysis([{ symbol: '000001.SZ', name: 'ST甲', change_pct: 0.05, momentum_5d: 0.1 }])
  const report = buildStDailyReport('2026-09-16', analysis, undefined, 20)
  await act(async () => root.render(<StShareDialog report={report} onClose={close} />))
}

async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(element => element.textContent === label)
  expect(button).toBeTruthy()
  await act(async () => button!.click())
}

it('previews public data, copies a draft and invokes PNG export without publishing', async () => {
  await mount()
  expect(host.querySelector('[role="dialog"]')).toBeTruthy()
  expect(host.querySelector('textarea')!.value).toContain('ST甲')
  expect(host.querySelector('canvas')!.width).toBe(1320)
  await click('复制文案')
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('+10.00%'))
  expect(host.textContent).toContain('文案已复制')
  await click('导出 PNG')
  expect(mocks.png).toHaveBeenCalledWith(host.querySelector('canvas'), '2026-09-16')
  expect(host.querySelector('a')!.getAttribute('href')).toBe('https://xueqiu.com/')
})

it('provides manual-copy and PNG failure messages and supports Escape close', async () => {
  mocks.copy.mockResolvedValue(false)
  mocks.png.mockRejectedValue(new Error('PNG 生成失败'))
  await mount()
  await click('复制文案')
  expect(host.textContent).toContain('手动全选复制')
  await click('导出 PNG')
  expect(host.textContent).toContain('PNG 生成失败')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(close).toHaveBeenCalledOnce()
})

it('disables image export when canvas is unavailable but still permits text copy', async () => {
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
  await mount()
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('无法生成图片')
  const download = [...host.querySelectorAll('button')].find(button => button.textContent === '导出 PNG')!
  expect(download.disabled).toBe(true)
  await click('复制文案')
  expect(mocks.copy).toHaveBeenCalledOnce()
})

it('downloads a PNG blob with a safe filename and releases its object URL', async () => {
  vi.useFakeTimers()
  const urls = { createObjectURL: vi.fn(() => 'blob:local-report'), revokeObjectURL: vi.fn() }
  vi.stubGlobal('URL', urls)
  let filename = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filename = this.download })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['png'], { type: 'image/png' })))
  const actual = await vi.importActual<typeof import('./share')>('./share')
  await actual.downloadReportImage(document.createElement('canvas'), '2026-09-16')
  expect(filename).toBe('TSP-ST-2026-09-16.png')
  expect(document.querySelector('a[download]')).toBeNull()
  vi.runAllTimers()
  expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:local-report')
})

it('reports a null PNG encoder result rather than creating an empty download', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(null))
  const actual = await vi.importActual<typeof import('./share')>('./share')
  await expect(actual.downloadReportImage(document.createElement('canvas'), '2026-09-16')).rejects.toThrow('PNG 生成失败')
})
