import type { PluginDataSourceItem } from '@/lib/api'

export function pluginSetupHint(plugin: Pick<PluginDataSourceItem, 'available' | 'api_key_env' | 'install_hint' | 'status'>): string {
  if (plugin.available) return ''
  if (plugin.api_key_env) return '点击配置 Key'
  return plugin.install_hint || plugin.status || '插件尚未就绪'
}
