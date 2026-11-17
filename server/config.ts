import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))
const runningCompiled = path.basename(moduleDir) === 'dist'

/** 编译后位于 server/dist,源码开发时位于 server;应用根目录都在上一级或两级 */
export const appRoot = path.resolve(moduleDir, runningCompiled ? '../..' : '..')

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined ? fallback : value === 'true' || value === '1'

const int = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const pathOf = (value: string | undefined, fallback: string) => {
  const path = value?.trim() || fallback
  return path.startsWith('/') ? path : `/${path}`
}

export const config = {
  port: int(process.env.PORT, 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(appRoot, 'data')),
  staticDir: path.resolve(process.env.STATIC_DIR ?? path.join(appRoot, 'dist')),
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  sessionDays: int(process.env.SESSION_DAYS, 30),
  adminUsername: process.env.ADMIN_USERNAME?.trim() ?? '',
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  apiBaseUrl: process.env.API_BASE_URL?.trim() || 'https://api.deepseek.com',
  apiKey: process.env.API_KEY?.trim() ?? '',
  apiModel: process.env.API_MODEL?.trim() || 'deepseek-flash',
  apiPaths: {
    messages: pathOf(process.env.API_MESSAGES_PATH, '/anthropic/v1/messages'),
    files: pathOf(process.env.API_FILES_PATH, '/anthropic/v1/files'),
    models: pathOf(process.env.API_MODELS_PATH, '/models'),
    asr: pathOf(process.env.API_ASR_PATH, '/v1/tools/asr'),
    tts: pathOf(process.env.API_TTS_PATH, '/v1/tools/tts'),
  },
}

export const SESSION_COOKIE = 'chat_demo_session'