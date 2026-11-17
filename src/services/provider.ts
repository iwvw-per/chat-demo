import { create } from 'zustand'
import { apiJson } from './api/backend.js'

export const FALLBACK_MODEL = 'deepseek-flash'
export const DEFAULT_SYSTEM_PROMPT = '该助手为DeepSeek,由深度求索公司创造。'

export type AppOptions = {
  appName: string
  welcomeMessage: string
  announcement: string
  systemPrompt: string
  defaultThinking: boolean
  defaultSearch: boolean
  allowRegistration: boolean
}

export const FALLBACK_OPTIONS: AppOptions = {
  appName: '',
  welcomeMessage: '',
  announcement: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultThinking: false,
  defaultSearch: false,
  allowRegistration: false,
}

type PublicConfig = {
  model: string
  configured: boolean
  version: number
  imageMode: 'files' | 'data-url'
  options: AppOptions
}

type ProviderState = {
  loaded: boolean
  model: string
  configured: boolean
  version: number
  imageMode: 'files' | 'data-url'
  options: AppOptions
}

export const useProvider = create<ProviderState>(() => ({
  loaded: false,
  model: FALLBACK_MODEL,
  configured: false,
  version: 0,
  imageMode: 'files',
  options: FALLBACK_OPTIONS,
}))

const normalizeOptions = (value: unknown): AppOptions => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return FALLBACK_OPTIONS
  }
  const input = value as Record<string, unknown>
  const text = (key: keyof AppOptions, fallback: string) =>
    typeof input[key] === 'string' ? (input[key] as string) : fallback
  const flag = (key: keyof AppOptions, fallback: boolean) =>
    typeof input[key] === 'boolean' ? (input[key] as boolean) : fallback
  return {
    appName: text('appName', FALLBACK_OPTIONS.appName),
    welcomeMessage: text('welcomeMessage', FALLBACK_OPTIONS.welcomeMessage),
    announcement: text('announcement', FALLBACK_OPTIONS.announcement),
    systemPrompt: text('systemPrompt', FALLBACK_OPTIONS.systemPrompt) || DEFAULT_SYSTEM_PROMPT,
    defaultThinking: flag('defaultThinking', FALLBACK_OPTIONS.defaultThinking),
    defaultSearch: flag('defaultSearch', FALLBACK_OPTIONS.defaultSearch),
    allowRegistration: flag('allowRegistration', FALLBACK_OPTIONS.allowRegistration),
  }
}

const applyConfig = (value: PublicConfig) => {
  useProvider.setState({
    loaded: true,
    model: typeof value.model === 'string' && value.model ? value.model : FALLBACK_MODEL,
    configured: Boolean(value.configured),
    version: Number(value.version) || 0,
    imageMode: value.imageMode === 'data-url' ? 'data-url' : 'files',
    options: normalizeOptions(value.options),
  })
}

export const getModel = (): string => useProvider.getState().model || FALLBACK_MODEL

export const getSystemPrompt = (): string =>
  useProvider.getState().options.systemPrompt || DEFAULT_SYSTEM_PROMPT

export const getImageMode = (): 'files' | 'data-url' => useProvider.getState().imageMode

let configSource: EventSource | null = null
let syncEpoch = 0

export const loadProviderConfig = async (epoch = syncEpoch): Promise<void> => {
  try {
    const config = await apiJson<PublicConfig>('/api/config', { cache: 'no-store' })
    if (epoch === syncEpoch) {
      applyConfig(config)
    }
  } catch {
    if (epoch === syncEpoch) {
      useProvider.setState({ loaded: true })
    }
  }
}

/** 首次加载配置并建立 SSE 订阅;管理员保存后新配置会即时推送 */
export const startProviderSync = async (): Promise<void> => {
  const epoch = ++syncEpoch
  await loadProviderConfig(epoch)
  if (epoch !== syncEpoch || configSource) {
    return
  }
  const source = new EventSource('/api/config/events')
  configSource = source
  source.addEventListener('config', (event) => {
    try {
      applyConfig(JSON.parse((event as MessageEvent<string>).data) as PublicConfig)
    } catch {
      // 忽略无法解析的推送,保留下一次事件
    }
  })
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      if (configSource === source) {
        configSource = null
      }
      void loadProviderConfig()
    }
  }
}

export const resetProvider = () => {
  syncEpoch += 1
  configSource?.close()
  configSource = null
  useProvider.setState({
    loaded: false,
    model: FALLBACK_MODEL,
    configured: false,
    version: 0,
    imageMode: 'files',
    options: FALLBACK_OPTIONS,
  })
}