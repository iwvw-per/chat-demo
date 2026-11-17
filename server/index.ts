import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { authRouter, hashPassword } from './auth.js'
import { config } from './config.js'
import {
  countUsers,
  createUser,
  db,
  seedProviderConfig,
} from './db.js'
import { HttpError, sendError } from './http.js'
import { createId } from './id.js'
import { adminRouter } from './routes/admin.js'
import { chatRouter } from './routes/chat.js'
import { proxyRouter } from './routes/proxy.js'
import { configRouter, settingsRouter } from './routes/settings.js'

const seedAdmin = async (): Promise<void> => {
  if (countUsers() > 0 || !config.adminUsername || !config.adminPassword) {
    return
  }
  if (config.adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD 至少需要 8 位')
  }
  const { passwordHash, passwordSalt } = await hashPassword(config.adminPassword)
  createUser({
    id: createId(),
    username: config.adminUsername,
    passwordHash,
    passwordSalt,
    role: 'admin',
    now: Date.now(),
  })
  console.log(`[auth] 已创建管理员账号 ${config.adminUsername}`)
}

const bootstrap = async () => {
  seedProviderConfig()
  await seedAdmin()

  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) {
    app.set('trust proxy', 1)
  }

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    next()
  })

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true })
  })

  app.use('/api/auth', authRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/chat', chatRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/config', configRouter)
  app.use('/api/llm', proxyRouter)

  app.use('/api', (_req, res) => {
    sendError(res, 404, '接口不存在', 'not_found')
  })

  if (fs.existsSync(config.staticDir)) {
    app.use(
      express.static(config.staticDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.includes(`${path.sep}static${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
          }
        },
      })
    )
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET' || !req.accepts('html')) {
        next()
        return
      }
      res.setHeader('Cache-Control', 'no-cache')
      res.sendFile(path.join(config.staticDir, 'index.html'))
    })
  }

  app.use((_req, res) => {
    sendError(res, 404, '资源不存在', 'not_found')
  })

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message, error.code)
      return
    }
    if (error instanceof multer.MulterError) {
      sendError(res, error.code === 'LIMIT_FILE_SIZE' ? 413 : 400, error.message, error.code)
      return
    }
    if (error instanceof SyntaxError && 'body' in error) {
      sendError(res, 400, '请求体格式错误', 'invalid_body')
      return
    }
    if (error instanceof Error && 'status' in error) {
      const status = Number((error as { status?: unknown }).status)
      if (Number.isInteger(status) && status >= 400 && status < 600) {
        sendError(res, status, error.message)
        return
      }
    }
    console.error('[server]', error)
    sendError(res, 500, '服务器内部错误', 'internal_error')
  })

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[server] 监听 http://0.0.0.0:${config.port}`)
    console.log(`[server] 数据目录 ${config.dataDir}`)
  })

  const shutdown = () => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

bootstrap().catch((error: unknown) => {
  console.error('[server] 启动失败', error)
  process.exit(1)
})