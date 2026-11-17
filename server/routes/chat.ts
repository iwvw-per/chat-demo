import express, { Router } from 'express'
import multer from 'multer'
import { requireAuth } from '../auth.js'
import {
  addStagingSession,
  clearStaging,
  commitStaging,
  deleteSession,
  getFile,
  getSessionData,
  listSessionSummaries,
  putFile,
  putSession,
  putStagingFile,
  renameSession,
  updateStagingFileTypes,
  type SessionSummary,
} from '../db.js'
import { currentUser, fail } from '../http.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 96 * 1024 * 1024, files: 1 },
})

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const readId = (value: unknown, label = 'ID'): string => {
  const id = typeof value === 'string' ? value : ''
  if (!ID_PATTERN.test(id)) {
    fail(400, `${label} 无效`, 'invalid_id')
  }
  return id
}

const readSession = (body: unknown, expectedId: string): { session: SessionSummary & { data: string } } => {
  if (typeof body !== 'object' || body === null) {
    fail(400, '会话数据无效', 'invalid_session')
  }
  const value = body as Record<string, unknown>
  if (value.id !== expectedId) {
    fail(400, '会话 ID 不匹配', 'invalid_session')
  }
  if (!Array.isArray(value.messages)) {
    fail(400, '会话消息无效', 'invalid_session')
  }
  const createdAt = Number(value.createdAt)
  const updatedAt = Number(value.updatedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    fail(400, '会话时间无效', 'invalid_session')
  }
  const title = typeof value.title === 'string' ? value.title.slice(0, 500) : ''
  value.title = title
  return {
    session: { id: expectedId, title, createdAt, updatedAt, data: JSON.stringify(value) },
  }
}

export const chatRouter = Router()

chatRouter.use(requireAuth, express.json({ limit: '32mb' }))

chatRouter.get('/sessions', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ sessions: listSessionSummaries(currentUser(req).id) })
})

chatRouter.get('/sessions/:id', (req, res) => {
  const id = readId(req.params.id, '会话 ID')
  const data = getSessionData(currentUser(req).id, id)
  if (!data) {
    res.status(404).json({ error: { message: '会话不存在', code: 'not_found' } })
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  res.type('application/json').send(data)
})

chatRouter.put('/sessions/:id', (req, res) => {
  const id = readId(req.params.id, '会话 ID')
  const { session } = readSession(req.body, id)
  putSession(currentUser(req).id, session)
  res.status(204).end()
})

chatRouter.patch('/sessions/:id', (req, res) => {
  const id = readId(req.params.id, '会话 ID')
  const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 500) : null
  if (title === null) {
    fail(400, '标题无效', 'invalid_title')
  }
  if (!renameSession(currentUser(req).id, id, title, Date.now())) {
    res.status(404).json({ error: { message: '会话不存在', code: 'not_found' } })
    return
  }
  res.status(204).end()
})

chatRouter.delete('/sessions/:id', (req, res) => {
  const id = readId(req.params.id, '会话 ID')
  deleteSession(currentUser(req).id, id)
  res.status(204).end()
})

const fileFromRequest = (req: express.Request) => {
  const id = readId(req.body?.id, '文件 ID')
  const uploaded = req.file
  if (!uploaded) {
    fail(400, '缺少文件', 'missing_file')
  }
  return {
    id,
    mimeType: uploaded.mimetype || '',
    data: new Uint8Array(uploaded.buffer),
  }
}

chatRouter.post('/files', upload.single('file'), (req, res) => {
  putFile(currentUser(req).id, fileFromRequest(req), Date.now())
  res.status(204).end()
})

chatRouter.get('/files/:id', (req, res) => {
  const id = readId(req.params.id, '文件 ID')
  const file = getFile(currentUser(req).id, id)
  if (!file) {
    res.status(404).end()
    return
  }
  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${id}"`)
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.end(Buffer.from(file.data))
})

chatRouter.post('/staging/clear', (req, res) => {
  clearStaging(currentUser(req).id)
  res.status(204).end()
})

chatRouter.post('/staging/sessions', (req, res) => {
  const body = req.body as Record<string, unknown> | undefined
  const id = readId(body?.id, '会话 ID')
  const { session } = readSession(body, id)
  addStagingSession(currentUser(req).id, session)
  res.status(204).end()
})

chatRouter.post('/staging/files', upload.single('file'), (req, res) => {
  putStagingFile(currentUser(req).id, fileFromRequest(req), Date.now())
  res.status(204).end()
})

chatRouter.post('/staging/file-types', (req, res) => {
  const types = (req.body as { types?: unknown } | undefined)?.types
  if (typeof types !== 'object' || types === null || Array.isArray(types)) {
    fail(400, '类型映射无效', 'invalid_types')
  }
  const entries = Object.entries(types as Record<string, unknown>)
  if (entries.length > 5000) {
    fail(400, '类型映射过大', 'invalid_types')
  }
  const mapping: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      mapping[key] = value
    }
  }
  updateStagingFileTypes(currentUser(req).id, mapping)
  res.status(204).end()
})

chatRouter.post('/staging/commit', (req, res) => {
  res.json({ sessions: commitStaging(currentUser(req).id) })
})