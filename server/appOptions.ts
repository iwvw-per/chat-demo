import { config } from './config.js'
import { getProviderConfig } from './db.js'

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

const text = (value: unknown, fallback: string, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : fallback

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

export const defaultAppOptions = (): AppOptions => ({
  appName: '',
  welcomeMessage: '',
  announcement: '',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultThinking: false,
  defaultSearch: false,
  allowRegistration: config.allowRegistration,
})

export const normalizeAppOptions = (value: unknown): AppOptions => {
  const defaults = defaultAppOptions()
  const input =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const systemPrompt = text(input.systemPrompt, defaults.systemPrompt, 8000).trim()
  return {
    appName: text(input.appName, defaults.appName, 60).trim(),
    welcomeMessage: text(input.welcomeMessage, defaults.welcomeMessage, 200).trim(),
    announcement: text(input.announcement, defaults.announcement, 1000).trim(),
    systemPrompt: systemPrompt || defaults.systemPrompt,
    defaultThinking: flag(input.defaultThinking, defaults.defaultThinking),
    defaultSearch: flag(input.defaultSearch, defaults.defaultSearch),
    allowRegistration: flag(input.allowRegistration, defaults.allowRegistration),
  }
}

export const getAppOptions = (): AppOptions => normalizeAppOptions(getProviderConfig()?.options)

export type PublicConfig = {
  model: string
  configured: boolean
  version: number
  options: AppOptions
}

export const publicConfig = (): PublicConfig => {
  const provider = getProviderConfig()
  return {
    model: provider?.model ?? 'deepseek-flash',
    configured: Boolean(provider?.apiKey),
    version: provider?.updatedAt ?? 0,
    options: getAppOptions(),
  }
}