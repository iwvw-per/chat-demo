import { create } from 'zustand'
import { apiJson, putJson } from './api/backend.js'
import { useAuth } from './auth.js'
import { useProvider } from './provider.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好;默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置,存 localStorage 并同步到后端:语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言,与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella(海星) */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

const snapshot = (): Settings => {
  const { locale, location, themePreference, ttsVoice, thinking, search, siderCollapsed } =
    useSettings.getState()
  return { locale, location, themePreference, ttsVoice, thinking, search, siderCollapsed }
}

let syncTimer: ReturnType<typeof setTimeout> | undefined

const pushSettings = () => {
  if (!useAuth.getState().user) {
    return
  }
  void putJson('/api/settings', snapshot()).catch(() => {
    // 同步失败保留本地设置,下次修改时再试
  })
}

const scheduleSync = () => {
  if (!useAuth.getState().user) {
    return
  }
  clearTimeout(syncTimer)
  syncTimer = setTimeout(pushSettings, 400)
}

export const loadServerSettings = async (): Promise<void> => {
  if (!useAuth.getState().user) {
    return
  }
  try {
    const body = await apiJson<{ settings: unknown }>('/api/settings')
    const value = body.settings
    if (typeof value !== 'object' || value === null) {
      const defaults = useProvider.getState().options
      useSettings.setState((state) => ({
        thinking: read(KEYS.thinking) === null ? defaults.defaultThinking : state.thinking,
        search: read(KEYS.search) === null ? defaults.defaultSearch : state.search,
      }))
      const next = useSettings.getState()
      write(KEYS.thinking, String(next.thinking))
      write(KEYS.search, String(next.search))
      pushSettings()
      return
    }
    const saved = value as Record<string, unknown>
    const locale = saved.locale === 'zh-CN' || saved.locale === 'en-US' ? saved.locale : undefined
    const themePreference =
      saved.themePreference === 'light' ||
      saved.themePreference === 'dark' ||
      saved.themePreference === 'system'
        ? saved.themePreference
        : undefined
    const ttsVoice = saved.ttsVoice === 'tide' || saved.ttsVoice === 'stella' ? saved.ttsVoice : undefined
    const location = normalizeLocation(saved.location)
    useSettings.setState((state) => ({
      locale: locale ?? state.locale,
      themePreference: themePreference ?? state.themePreference,
      location: saved.location === null ? null : (location ?? state.location),
      ttsVoice: ttsVoice ?? state.ttsVoice,
      thinking: typeof saved.thinking === 'boolean' ? saved.thinking : state.thinking,
      search: typeof saved.search === 'boolean' ? saved.search : state.search,
      siderCollapsed:
        typeof saved.siderCollapsed === 'boolean' ? saved.siderCollapsed : state.siderCollapsed,
    }))
    const next = useSettings.getState()
    write(KEYS.locale, next.locale)
    write(KEYS.location, next.location ? JSON.stringify(next.location) : null)
    write(KEYS.themePreference, next.themePreference)
    write(KEYS.ttsVoice, next.ttsVoice)
    write(KEYS.thinking, String(next.thinking))
    write(KEYS.search, String(next.search))
    write(KEYS.siderCollapsed, String(next.siderCollapsed))
  } catch {
    // 读取失败时沿用本地设置
  }
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
  scheduleSync()
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
  scheduleSync()
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
  scheduleSync()
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
  scheduleSync()
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
  scheduleSync()
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
  scheduleSync()
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
  scheduleSync()
}