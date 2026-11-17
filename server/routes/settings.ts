import express, { Router, type Response } from 'express'
import { publicConfig } from '../appOptions.js'
import { requireAuth } from '../auth.js'
import { getUserSettings, saveUserSettings } from '../db.js'
import { currentUser, fail } from '../http.js'

export const settingsRouter = Router()

settingsRouter.use(express.json({ limit: '1mb' }), requireAuth)

settingsRouter.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ settings: getUserSettings(currentUser(req).id) })
})

settingsRouter.put('/', (req, res) => {
  const settings = req.body
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    fail(400, '设置数据无效', 'invalid_settings')
  }
  if (JSON.stringify(settings).length > 1024 * 1024) {
    fail(413, '设置数据过大', 'settings_too_large')
  }
  saveUserSettings(currentUser(req).id, settings, Date.now())
  res.status(204).end()
})

export const configRouter = Router()

configRouter.use(requireAuth)

configRouter.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json(publicConfig())
})

const configClients = new Set<Response>()

const configEvent = () => `event: config\ndata: ${JSON.stringify(publicConfig())}\n\n`

/** 配置保存后向所有在线客户端推送,前端无需刷新即可生效 */
export const broadcastConfig = () => {
  const payload = configEvent()
  for (const client of configClients) {
    try {
      client.write(payload)
    } catch {
      configClients.delete(client)
    }
  }
}

configRouter.get('/events', (req, res) => {
  res.status(200)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  configClients.add(res)
  res.write(configEvent())
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(timer)
      configClients.delete(res)
    }
  }, 25_000)
  req.on('close', () => {
    clearInterval(timer)
    configClients.delete(res)
  })
})