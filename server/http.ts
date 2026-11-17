import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { PublicUser } from './db.js'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function fail(status: number, message: string, code?: string): never {
  throw new HttpError(status, message, code)
}

/** requireAuth 之后取当前用户;没有时按未登录处理 */
export const currentUser = (req: Request): PublicUser => {
  if (!req.user) {
    fail(401, '未登录', 'unauthorized')
  }
  return req.user
}

export const asyncHandler =
  (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res, next).catch(next)
  }

export const sendError = (res: Response, status: number, message: string, code?: string) => {
  res.status(status).json({ error: { message, ...(code ? { code } : {}) } })
}

export const readCookies = (header: string | undefined): Record<string, string> => {
  const cookies: Record<string, string> = {}
  if (!header) {
    return cookies
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) {
      continue
    }
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value)
      } catch {
        cookies[name] = value
      }
    }
  }
  return cookies
}

const rateBuckets = new Map<string, { count: number; resetAt: number }>()

/** 简单的内存限流:同一来源在窗口内的请求数超过上限时返回 429 */
export const rateLimit = (key: string, limit: number, windowMs: number): boolean => {
  const now = Date.now()
  if (rateBuckets.size > 10_000) {
    for (const [bucketKey, bucket] of rateBuckets) {
      if (bucket.resetAt <= now) {
        rateBuckets.delete(bucketKey)
      }
    }
  }
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  bucket.count += 1
  if (bucket.count > limit) {
    return false
  }
  return true
}

export const validateUsername = (value: unknown): string => {
  const username = typeof value === 'string' ? value.trim() : ''
  if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    fail(400, '用户名需为 3-32 位字母、数字、下划线、点或短横线', 'invalid_username')
  }
  return username
}

export const validatePassword = (value: unknown): string => {
  const password = typeof value === 'string' ? value : ''
  if (password.length < 8 || password.length > 128) {
    fail(400, '密码长度需为 8-128 位', 'invalid_password')
  }
  return password
}