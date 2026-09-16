import { ShieldAlert } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'
import { StAnalysisPage } from './page'

const extension: FrontendExtension = {
  id: 'alphaquant.st-analysis',
  apiVersion: 1,
  routes: [{ id: 'st-analysis', path: '/st-analysis', component: StAnalysisPage }],
  navigation: [{
    id: 'st-analysis',
    routeId: 'st-analysis',
    label: 'ST 板块分析',
    icon: ShieldAlert,
    order: 45,
    badge: '风险',
  }],
}

export default extension
