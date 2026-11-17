import express, { Router } from 'express'
import { getAppOptions, normalizeAppOptions } from '../appOptions.js'
import { hashPassword, requireAdmin, requireAuth } from '../auth.js'
import { config } from '../config.js'
import {
  countAdmins,
  createUserAtomic,
  deleteAuthSessionsForUser,
  deleteUser,
  findUserById,
  getProviderConfig,
  listUsers,
  saveProviderConfig,
  updateUserPassword,
} from '../db.js'
import { asyncHandler, currentUser, fail, validatePassword, validateUsername } from '../http.js'
import { createId } from '../id.js'
import { broadcastConfig } from './settings.js'

const validateBaseUrl = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : ''
  let parsed: URL | undefined
  try {
    parsed = new URL(raw)
  } catch {
    fail(400, 'API 地址无效', 'invalid_base_url')
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    fail(400, 'API 地址仅支持 http 或 https', 'invalid_base_url')
  }
  return raw.replace(/\/+$/, '')
}

const validateModel = (value: unknown): string => {
  const model = typeof value === 'string' ? value.trim() : ''
  if (!model || model.length > 100) {
    fail(400, '模型名称无效', 'invalid_model')
  }
  return model
}

export const adminRouter = Router()

adminRouter.use(express.json({ limit: '128kb' }), requireAuth, requireAdmin)

adminRouter.get('/config', (_req, res) => {
  const provider = getProviderConfig()
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    baseUrl: provider?.baseUrl ?? '',
    model: provider?.model ?? '',
    hasApiKey: Boolean(provider?.apiKey),
    apiKeyHint: provider?.apiKey
      ? `${provider.apiKey.slice(0, 4)}****${provider.apiKey.slice(-4)}`
      : '',
    options: getAppOptions(),
  })
})

adminRouter.put('/config', (req, res) => {
  const provider = getProviderConfig()
  const baseUrl = validateBaseUrl(req.body?.baseUrl)
  const model = validateModel(req.body?.model)
  const inputKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : ''
  const apiKey = inputKey || provider?.apiKey || ''
  const options = normalizeAppOptions(req.body?.options)
  saveProviderConfig({ baseUrl, apiKey, model, options, now: Date.now() })
  broadcastConfig()
  res.json({
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey),
    apiKeyHint: apiKey ? `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}` : '',
    options,
  })
})

adminRouter.post(
  '/config/test',
  asyncHandler(async (req, res) => {
    const provider = getProviderConfig()
    const baseUrl = req.body?.baseUrl ? validateBaseUrl(req.body.baseUrl) : provider?.baseUrl
    if (!baseUrl) {
      fail(400, '请先填写 API 地址', 'invalid_base_url')
    }
    const inputKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : ''
    const apiKey = inputKey || provider?.apiKey || ''
    if (!apiKey) {
      fail(400, '请先填写 API Key', 'missing_api_key')
    }
    try {
      const response = await fetch(`${baseUrl}${config.apiPaths.models}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      })
      const text = await response.text().catch(() => '')
      if (response.ok) {
        res.json({ ok: true, status: response.status, message: '' })
        return
      }
      let message = text.slice(0, 500)
      try {
        const body = JSON.parse(text) as { error?: { message?: string } }
        if (typeof body.error?.message === 'string') {
          message = body.error.message
        }
      } catch {
        // 非 JSON 响应直接展示原文
      }
      res.json({ ok: false, status: response.status, message })
    } catch (error) {
      res.json({
        ok: false,
        status: 0,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
)

adminRouter.get('/users', (_req, res) => {
  res.json({ users: listUsers() })
})

adminRouter.post(
  '/users',
  asyncHandler(async (req, res) => {
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    const role = req.body?.role === 'admin' ? 'admin' : 'user'
    const { passwordHash, passwordSalt } = await hashPassword(password)
    const result = createUserAtomic(
      { id: createId(), username, passwordHash, passwordSalt, role, now: Date.now() },
      true
    )
    if ('reason' in result) {
      fail(409, '用户名已存在', 'username_taken')
    }
    res.status(201).json({ user: result.user })
  })
)

adminRouter.delete('/users/:id', (req, res) => {
  const id = req.params.id
  if (id === currentUser(req).id) {
    fail(400, '不能删除当前登录的账号', 'cannot_delete_self')
  }
  const target = findUserById(id)
  if (!target) {
    fail(404, '用户不存在', 'not_found')
  }
  if (target.role === 'admin' && countAdmins() <= 1) {
    fail(400, '至少需要保留一个管理员', 'last_admin')
  }
  deleteUser(id)
  res.status(204).end()
})

adminRouter.put(
  '/users/:id/password',
  asyncHandler(async (req, res) => {
    const id = req.params.id
    if (!findUserById(id)) {
      fail(404, '用户不存在', 'not_found')
    }
    const password = validatePassword(req.body?.password)
    const { passwordHash, passwordSalt } = await hashPassword(password)
    updateUserPassword(id, passwordHash, passwordSalt)
    deleteAuthSessionsForUser(id)
    res.status(204).end()
  })
)