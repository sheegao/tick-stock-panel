import { Activity } from 'lucide-react'
import type { FrontendExtension, FrontendSlotContextMap } from '@/extensions/types'
import { AlphaQuantPage, AlphaQuantStockFacts } from './workbench'

function StockFooter(context: FrontendSlotContextMap[keyof FrontendSlotContextMap]) {
  return 'symbol' in context ? <AlphaQuantStockFacts symbol={context.symbol} /> : null
}

const extension: FrontendExtension = {
  id: 'alphaquant.workbench',
  apiVersion: 1,
  routes: [{ id: 'alphaquant-workbench', path: '/alphaquant', component: AlphaQuantPage }],
  navigation: [{ id: 'alphaquant-workbench', routeId: 'alphaquant-workbench', label: 'AlphaQuant 策略', icon: Activity, order: 50, badge: '只读' }],
  slots: [{ id: 'alphaquant-stock-detail', name: 'stock-preview.footer', component: StockFooter }],
}
export default extension
