import { describe, expect, it } from 'vitest'
import { pluginSetupHint } from './plugin-setup'

describe('plugin setup hint', () => {
  it('does not ask a keyless bridge for an API key', () => {
    expect(pluginSetupHint({ available: false, api_key_env: '', install_hint: '启动本机桥接', status: 'offline' })).toBe('启动本机桥接')
  })
  it('preserves API key setup for key-based plugins', () => {
    expect(pluginSetupHint({ available: false, api_key_env: 'FUYAO_API_KEY', install_hint: '', status: 'no key' })).toBe('点击配置 Key')
  })
  it('shows failure status when no install hint exists', () => {
    expect(pluginSetupHint({ available: false, api_key_env: '', install_hint: '', status: 'offline' })).toBe('offline')
  })
  it('does not show setup hints for ready plugins', () => {
    expect(pluginSetupHint({ available: true, api_key_env: '', install_hint: 'start', status: 'ok' })).toBe('')
  })
})
