import express, { Router, type Response } from 'express'
import multer from 'multer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { requireAuth } from '../auth.js'
import { config as appConfig } from '../config.js'
import { getProviderConfig, type ProviderConfig } from '../db.js'
import { asyncHandler, fail } from '../http.js'
import { handleVisionMessage, hasInlineImages } from '../vision.js'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 96 * 1024 * 1024, files: 1 },
})

const MAX_BODY = '64mb'

const originalName = (name: string): string => {
  if (!/[\u0080-\u00ff]/.test(name)) {
    return name
  }
  const decoded = Buffer.from(name, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? name : decoded
}

const provider = (): ProviderConfig => {
  const config = getProviderConfig()
  if (!config) {
    fail(503, '服务端尚未配置上游 API,请联系管理员', 'provider_unconfigured')
  }
  if (!config.apiKey) {
    fail(503, '服务端尚未配置上游 API Key,请联系管理员', 'provider_unconfigured')
  }
  return config
}

const upstreamUrl = (config: ProviderConfig, path: string) =>
  `${config.baseUrl.replace(/\/+$/, '')}${path}`

const forward = async (
  res: Response,
  path: string,
  init: RequestInit,
  signal: AbortSignal
) => {
  const config = provider()
  let response: globalThis.Response | null = null
  try {
    response = await fetch(upstreamUrl(config, path), { ...init, signal })
  } catch (error) {
    if (signal.aborted) {
      return
    }
    fail(502, `无法连接上游 API: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response) {
    return
  }
  res.status(response.status)
  const contentType = response.headers.get('content-type')
  if (contentType) {
    res.setHeader('Content-Type', contentType)
  }
  const cacheControl = response.headers.get('cache-control')
  if (cacheControl) {
    res.setHeader('Cache-Control', cacheControl)
  }
  const requestId = response.headers.get('x-request-id')
  if (requestId) {
    res.setHeader('X-Request-Id', requestId)
  }
  if (!response.body) {
    res.end()
    return
  }
  try {
    await pipeline(Readable.fromWeb(response.body as never), res)
  } catch (error) {
    if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined)
    }
  }
}

const abortOnClose = (res: Response) => {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort()
    }
  })
  return controller
}

const bearerHeaders = (config: ProviderConfig): Record<string, string> => ({
  Authorization: `Bearer ${config.apiKey}`,
})

export const proxyRouter = Router()

proxyRouter.use(requireAuth)

proxyRouter.get(
  '/models',
  asyncHandler(async (_req, res) => {
    const controller = abortOnClose(res)
    await forward(
      res,
      appConfig.apiPaths.models,
      { method: 'GET', headers: bearerHeaders(provider()), signal: controller.signal },
      controller.signal
    )
  })
)

proxyRouter.post(
  '/anthropic/v1/messages',
  express.raw({ type: () => true, limit: MAX_BODY }),
  asyncHandler(async (req, res) => {
    const config = provider()
    const controller = abortOnClose(res)
    const beta = req.headers['anthropic-beta']
    if (appConfig.imageMode === 'data-url') {
      let body: unknown
      try {
        body = JSON.parse((req.body as Buffer).toString('utf8'))
      } catch {
        body = null
      }
      if (hasInlineImages(body)) {
        await handleVisionMessage(res, body as Record<string, unknown>, config)
        return
      }
    }
    res.setHeader('X-Accel-Buffering', 'no')
    await forward(
      res,
      appConfig.apiPaths.messages,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: req.headers.accept ?? 'text/event-stream',
          ...bearerHeaders(config),
          'x-api-key': config.apiKey,
          ...(typeof beta === 'string' ? { 'anthropic-beta': beta } : {}),
        },
        body: req.body as unknown as RequestInit['body'],
        signal: controller.signal,
      },
      controller.signal
    )
  })
)

proxyRouter.post(
  '/anthropic/v1/files',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const config = provider()
    const uploaded = req.file
    if (!uploaded) {
      fail(400, '缺少上传文件', 'missing_file')
    }
    const controller = abortOnClose(res)
    const form = new FormData()
    const purpose = typeof req.body?.purpose === 'string' ? req.body.purpose : ''
    if (purpose) {
      form.append('purpose', purpose)
    }
    form.append(
      'file',
      new Blob([new Uint8Array(uploaded.buffer)], {
        type: uploaded.mimetype || 'application/octet-stream',
      }),
      originalName(uploaded.originalname)
    )
    await forward(
      res,
      appConfig.apiPaths.files,
      {
        method: 'POST',
        headers: {
          ...bearerHeaders(config),
          'x-api-key': config.apiKey,
          'anthropic-beta': 'files-api-2025-04-14',
        },
        body: form,
        signal: controller.signal,
      },
      controller.signal
    )
  })
)

proxyRouter.delete(
  '/anthropic/v1/files/:fileId',
  asyncHandler(async (req, res) => {
    const config = provider()
    const controller = abortOnClose(res)
    await forward(
      res,
      `${appConfig.apiPaths.files}/${encodeURIComponent(req.params.fileId)}`,
      {
        method: 'DELETE',
        headers: {
          ...bearerHeaders(config),
          'x-api-key': config.apiKey,
          'anthropic-beta': 'files-api-2025-04-14',
        },
        signal: controller.signal,
      },
      controller.signal
    )
  })
)

proxyRouter.post(
  '/tools/asr',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const config = provider()
    const uploaded = req.file
    if (!uploaded) {
      fail(400, '缺少音频文件', 'missing_file')
    }
    const controller = abortOnClose(res)
    const form = new FormData()
    form.append(
      'file',
      new Blob([new Uint8Array(uploaded.buffer)], {
        type: uploaded.mimetype || 'audio/wav',
      }),
      originalName(uploaded.originalname)
    )
    await forward(
      res,
      appConfig.apiPaths.asr,
      {
        method: 'POST',
        headers: bearerHeaders(config),
        body: form,
        signal: controller.signal,
      },
      controller.signal
    )
  })
)

proxyRouter.post(
  '/tools/tts',
  express.raw({ type: () => true, limit: '4mb' }),
  asyncHandler(async (req, res) => {
    const config = provider()
    const controller = abortOnClose(res)
    await forward(
      res,
      appConfig.apiPaths.tts,
      {
        method: 'POST',
        headers: {
          ...bearerHeaders(config),
          'Content-Type': 'application/json',
        },
        body: req.body as unknown as RequestInit['body'],
        signal: controller.signal,
      },
      controller.signal
    )
  })
)

