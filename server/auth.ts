import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import express, { Router, type RequestHandler } from 'express'
import { getAppOptions } from './appOptions.js'
import { SESSION_COOKIE, config } from './config.js'
import {
  countUsers,
  createUserAtomic,
  deleteAuthSession,
  deleteAuthSessionsForUser,
  deleteExpiredAuthSessions,
  findAuthSession,
  findUserById,
  findUserByName,
  insertAuthSession,
  updateUserPassword,
  type PublicUser,
} from './db.js'
import {
  asyncHandler,
  currentUser,
  fail,
  rateLimit,
  readCookies,
  validatePassword,
  validateUsername,
} from './http.js'
import { createId } from './id.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: PublicUser
      tokenHash?: string
    }
  }
}

const SESSION_MAX_AGE = config.sessionDays * 24 * 60 * 60 * 1000

const scryptAsync = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error)
        return
      }
      resolve(derivedKey)
    })
  })

export const hashPassword = async (
  password: string
): Promise<{ passwordHash: string; passwordSalt: string }> => {
  const passwordSalt = randomBytes(16).toString('hex')
  const passwordHash = (await scryptAsync(password, passwordSalt)).toString('hex')
  return { passwordHash, passwordSalt }
}

export const verifyPassword = async (
  password: string,
  passwordHash: string,
  passwordSalt: string
): Promise<boolean> => {
  const expected = Buffer.from(passwordHash, 'hex')
  const actual = await scryptAsync(password, passwordSalt)
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected as unknown as Uint8Array, actual as unknown as Uint8Array)
  )
}

const tokenHashOf = (token: string) => createHash('sha256').update(token).digest('hex')

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.cookieSecure,
  path: '/',
  maxAge: SESSION_MAX_AGE,
}

const startSession = (user: PublicUser, res: Parameters<RequestHandler>[1]) => {
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  deleteExpiredAuthSessions(now)
  insertAuthSession(tokenHashOf(token), user.id, now, now + SESSION_MAX_AGE)
  res.cookie(SESSION_COOKIE, token, cookieOptions)
  return token
}

export const requireAuth: RequestHandler = (req, res, next) => {
  const token = readCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) {
    res.status(401).json({ error: { message: '未登录', code: 'unauthorized' } })
    return
  }
  const tokenHash = tokenHashOf(token)
  const session = findAuthSession(tokenHash)
  if (!session) {
    res.status(401).json({ error: { message: '登录已失效', code: 'unauthorized' } })
    return
  }
  if (session.expiresAt <= Date.now()) {
    deleteAuthSession(tokenHash)
    res.status(401).json({ error: { message: '登录已失效', code: 'unauthorized' } })
    return
  }
  req.user = session.user
  req.tokenHash = tokenHash
  next()
}

export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: { message: '需要管理员权限', code: 'forbidden' } })
    return
  }
  next()
}

const clientKey = (req: Parameters<RequestHandler>[0]) =>
  req.ip || req.socket.remoteAddress || 'unknown'

export const authRouter = Router()

authRouter.use(express.json({ limit: '64kb' }))

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    if (!rateLimit(`register:${clientKey(req)}`, 20, 10 * 60 * 1000)) {
      fail(429, '尝试过于频繁,请稍后再试', 'rate_limited')
    }
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    if (findUserByName(username)) {
      fail(409, '用户名已存在', 'username_taken')
    }
    const { passwordHash, passwordSalt } = await hashPassword(password)
    const result = createUserAtomic(
      { id: createId(), username, passwordHash, passwordSalt, now: Date.now() },
      getAppOptions().allowRegistration
    )
    if ('reason' in result) {
      if (result.reason === 'registration_disabled') {
        fail(403, '当前不允许注册,请联系管理员创建账号', 'registration_disabled')
      }
      fail(409, '用户名已存在', 'username_taken')
    }
    const user = result.user
    startSession(user, res)
    res.status(201).json({ user })
  })
)

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    if (!rateLimit(`login:${clientKey(req)}`, 30, 10 * 60 * 1000)) {
      fail(429, '尝试过于频繁,请稍后再试', 'rate_limited')
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const row = findUserByName(username)
    if (!row) {
      await hashPassword(password)
      fail(401, '用户名或密码错误', 'invalid_credentials')
    }
    if (!(await verifyPassword(password, row.password_hash, row.password_salt))) {
      fail(401, '用户名或密码错误', 'invalid_credentials')
    }
    deleteExpiredAuthSessions(Date.now())
    const user: PublicUser = {
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.created_at,
    }
    startSession(user, res)
    res.json({ user })
  })
)

authRouter.post('/logout', requireAuth, (req, res) => {
  if (req.tokenHash) {
    deleteAuthSession(req.tokenHash)
  }
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions, maxAge: undefined })
  res.status(204).end()
})

authRouter.get('/status', (_req, res) => {
  const hasUsers = countUsers() > 0
  const options = getAppOptions()
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    hasUsers,
    allowRegistration: !hasUsers || options.allowRegistration,
    appName: options.appName,
  })
})

authRouter.get('/me', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({ user: req.user })
})

authRouter.put(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : ''
    const next = validatePassword(req.body?.newPassword)
    const row = findUserById(currentUser(req).id)
    if (!row) {
      fail(401, '登录已失效', 'unauthorized')
    }
    if (!(await verifyPassword(current, row.password_hash, row.password_salt))) {
      fail(401, '当前密码不正确', 'invalid_credentials')
    }
    const { passwordHash, passwordSalt } = await hashPassword(next)
    updateUserPassword(row.id, passwordHash, passwordSalt)
    deleteAuthSessionsForUser(row.id, req.tokenHash)
    res.status(204).end()
  })
)