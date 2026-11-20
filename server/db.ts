import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.js'

export type Role = 'admin' | 'user'

export type UserRow = {
  id: string
  username: string
  password_hash: string
  password_salt: string
  role: Role
  created_at: number
}

export type PublicUser = {
  id: string
  username: string
  role: Role
  createdAt: number
}

export type ProviderConfig = {
  baseUrl: string
  apiKey: string
  model: string
  options: Record<string, unknown>
  updatedAt: number
}

export type SessionSummary = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
}

type SessionInput = SessionSummary & { data: string }

type FileInput = {
  id: string
  mimeType: string
  data: Uint8Array
}

fs.mkdirSync(config.dataDir, { recursive: true })

export const db = new DatabaseSync(path.join(config.dataDir, 'chat-demo.sqlite'))

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);

  CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_sessions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS chat_sessions_updated ON chat_sessions(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS chat_files (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    text_content TEXT,
    text_truncated INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE IF NOT EXISTS staging_sessions (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE IF NOT EXISTS staging_files (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
`)

const appConfigColumns = db.prepare('PRAGMA table_info(app_config)').all()
if (!appConfigColumns.some((column) => String(column.name) === 'options')) {
  db.exec("ALTER TABLE app_config ADD COLUMN options TEXT NOT NULL DEFAULT '{}'")
}

const chatFileColumns = db.prepare('PRAGMA table_info(chat_files)').all()
if (!chatFileColumns.some((column) => String(column.name) === 'text_content')) {
  db.exec('ALTER TABLE chat_files ADD COLUMN text_content TEXT')
}
if (!chatFileColumns.some((column) => String(column.name) === 'text_truncated')) {
  db.exec('ALTER TABLE chat_files ADD COLUMN text_truncated INTEGER')
}

const publicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  createdAt: row.created_at,
})

const asUser = (row: Record<string, unknown> | undefined): UserRow | undefined =>
  row
    ? {
        id: String(row.id),
        username: String(row.username),
        password_hash: String(row.password_hash),
        password_salt: String(row.password_salt),
        role: row.role === 'admin' ? 'admin' : 'user',
        created_at: Number(row.created_at),
      }
    : undefined

export const countUsers = (): number =>
  Number(db.prepare('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0)

export const findUserByName = (username: string): UserRow | undefined =>
  asUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username))

export const findUserById = (id: string): UserRow | undefined =>
  asUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id))

export const listUsers = (): PublicUser[] =>
  db
    .prepare('SELECT * FROM users ORDER BY created_at ASC')
    .all()
    .map((row) => publicUser(asUser(row) as UserRow))

export const countAdmins = (): number =>
  Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get()?.count ?? 0)

export const createUser = (user: {
  id: string
  username: string
  passwordHash: string
  passwordSalt: string
  role: Role
  now: number
}): PublicUser => {
  db.prepare(
    `INSERT INTO users (id, username, password_hash, password_salt, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(user.id, user.username, user.passwordHash, user.passwordSalt, user.role, user.now)
  return { id: user.id, username: user.username, role: user.role, createdAt: user.now }
}

export const updateUserPassword = (
  id: string,
  passwordHash: string,
  passwordSalt: string
): void => {
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(
    passwordHash,
    passwordSalt,
    id
  )
}

export const createUserAtomic = (
  user: {
    id: string
    username: string
    passwordHash: string
    passwordSalt: string
    role?: Role
    now: number
  },
  allowRegistration: boolean
): { user: PublicUser } | { reason: 'registration_disabled' | 'username_taken' } => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const firstUser = countUsers() === 0
    if (!firstUser && !allowRegistration) {
      db.exec('ROLLBACK')
      return { reason: 'registration_disabled' }
    }
    if (findUserByName(user.username)) {
      db.exec('ROLLBACK')
      return { reason: 'username_taken' }
    }
    const created = createUser({
      id: user.id,
      username: user.username,
      passwordHash: user.passwordHash,
      passwordSalt: user.passwordSalt,
      role: firstUser ? 'admin' : (user.role ?? 'user'),
      now: user.now,
    })
    db.exec('COMMIT')
    return { user: created }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已回滚
    }
    throw error
  }
}

export const deleteUser = (id: string): void => {
  db.prepare('DELETE FROM users WHERE id = ?').run(id)
}

export const insertAuthSession = (
  tokenHash: string,
  userId: string,
  now: number,
  expiresAt: number
): void => {
  db.prepare(
    'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash, userId, now, expiresAt)
}

export const findAuthSession = (tokenHash: string): { user: PublicUser; expiresAt: number } | null => {
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash)
  if (!row) {
    return null
  }
  const user = asUser(row)
  if (!user) {
    return null
  }
  return { user: publicUser(user), expiresAt: Number(row.session_expires_at) }
}

export const deleteAuthSession = (tokenHash: string): void => {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
}

/** 删除某个用户的登录态;exceptTokenHash 用于保留当前会话(修改密码时) */
export const deleteAuthSessionsForUser = (userId: string, exceptTokenHash?: string): void => {
  if (exceptTokenHash) {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?').run(
      userId,
      exceptTokenHash
    )
    return
  }
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
}

export const deleteExpiredAuthSessions = (now: number): void => {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now)
}

const asProviderConfig = (row: Record<string, unknown> | undefined): ProviderConfig | null => {
  if (!row) {
    return null
  }
  let options: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(String(row.options ?? '{}'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      options = parsed as Record<string, unknown>
    }
  } catch {
    options = {}
  }
  return {
    baseUrl: String(row.base_url),
    apiKey: String(row.api_key),
    model: String(row.model),
    options,
    updatedAt: Number(row.updated_at),
  }
}

export const getProviderConfig = (): ProviderConfig | null =>
  asProviderConfig(db.prepare('SELECT * FROM app_config WHERE id = 1').get())

export const saveProviderConfig = (value: {
  baseUrl: string
  apiKey: string
  model: string
  options: Record<string, unknown>
  now: number
}): void => {
  db.prepare(
    `INSERT INTO app_config (id, base_url, api_key, model, options, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       model = excluded.model,
       options = excluded.options,
       updated_at = excluded.updated_at`
  ).run(
    value.baseUrl,
    value.apiKey,
    value.model,
    JSON.stringify(value.options),
    value.now
  )
}

export const getUserSettings = (userId: string): unknown | null => {
  const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(userId)
  if (!row) {
    return null
  }
  try {
    return JSON.parse(String(row.data))
  } catch {
    return null
  }
}

export const saveUserSettings = (userId: string, data: unknown, now: number): void => {
  db.prepare(
    `INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(data), now)
}

export const listSessionSummaries = (userId: string): SessionSummary[] =>
  db
    .prepare(
      'SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC'
    )
    .all(userId)
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }))

export const getSessionData = (userId: string, id: string): string | null => {
  const row = db
    .prepare('SELECT data FROM chat_sessions WHERE user_id = ? AND id = ?')
    .get(userId, id)
  return row ? String(row.data) : null
}

export const putSession = (userId: string, session: SessionInput): void => {
  db.prepare(
    `INSERT INTO chat_sessions (user_id, id, title, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       title = excluded.title,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       data = excluded.data`
  ).run(userId, session.id, session.title, session.createdAt, session.updatedAt, session.data)
}

export const renameSession = (userId: string, id: string, title: string, now: number): boolean => {
  const row = db
    .prepare('SELECT data FROM chat_sessions WHERE user_id = ? AND id = ?')
    .get(userId, id)
  if (!row) {
    return false
  }
  let data = String(row.data)
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>
    parsed.title = title
    data = JSON.stringify(parsed)
  } catch {
    // 数据损坏时仍更新列,列表可正常显示
  }
  db.prepare(
    'UPDATE chat_sessions SET title = ?, data = ?, updated_at = ? WHERE user_id = ? AND id = ?'
  ).run(title, data, now, userId, id)
  return true
}

const collectFileIds = (data: string): string[] => {
  try {
    const parsed = JSON.parse(data) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) {
      return []
    }
    const ids: string[] = []
    for (const message of parsed.messages) {
      const item = message as { role?: string; files?: unknown }
      if (item.role !== 'user' || !Array.isArray(item.files)) {
        continue
      }
      for (const file of item.files) {
        const id = (file as { id?: unknown }).id
        if (typeof id === 'string') {
          ids.push(id)
        }
      }
    }
    return ids
  } catch {
    return []
  }
}

const cleanupOrphanFiles = (userId: string) => {
  const used = new Set<string>()
  const sessions = db
    .prepare('SELECT data FROM chat_sessions WHERE user_id = ?')
    .all(userId)
  for (const session of sessions) {
    for (const id of collectFileIds(String(session.data))) {
      used.add(id)
    }
  }
  const remove = db.prepare('DELETE FROM chat_files WHERE user_id = ? AND id = ?')
  for (const file of db.prepare('SELECT id FROM chat_files WHERE user_id = ?').all(userId)) {
    const id = String(file.id)
    if (!used.has(id)) {
      remove.run(userId, id)
    }
  }
}

/** 删除会话,并清理不再被该用户任何会话引用的原件 */
export const deleteSession = (userId: string, id: string): void => {
  db.prepare('DELETE FROM chat_sessions WHERE user_id = ? AND id = ?').run(userId, id)
  cleanupOrphanFiles(userId)
}

export const putFile = (userId: string, file: FileInput, now: number): void => {
  db.prepare(
    `INSERT INTO chat_files (user_id, id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       mime_type = excluded.mime_type,
       data = excluded.data,
       text_content = NULL,
       text_truncated = NULL`
  ).run(userId, file.id, file.mimeType, file.data, now)
}

export const putFileText = (
  userId: string,
  id: string,
  text: string,
  truncated: boolean
): void => {
  db.prepare(
    'UPDATE chat_files SET text_content = ?, text_truncated = ? WHERE user_id = ? AND id = ?'
  ).run(text, truncated ? 1 : 0, userId, id)
}

export const getFileText = (
  userId: string,
  id: string
): { text: string; truncated: boolean } | null => {
  const row = db
    .prepare('SELECT text_content, text_truncated FROM chat_files WHERE user_id = ? AND id = ?')
    .get(userId, id)
  if (!row || row.text_content === null || row.text_content === undefined) {
    return null
  }
  return { text: String(row.text_content), truncated: Number(row.text_truncated) === 1 }
}

export const getFile = (
  userId: string,
  id: string
): { mimeType: string; data: Uint8Array } | null => {
  const row = db
    .prepare('SELECT mime_type, data FROM chat_files WHERE user_id = ? AND id = ?')
    .get(userId, id)
  if (!row) {
    return null
  }
  return { mimeType: String(row.mime_type), data: row.data as Uint8Array }
}

export const clearStaging = (userId: string): void => {
  db.prepare('DELETE FROM staging_sessions WHERE user_id = ?').run(userId)
  db.prepare('DELETE FROM staging_files WHERE user_id = ?').run(userId)
}

export const addStagingSession = (userId: string, session: SessionInput): void => {
  db.prepare(
    `INSERT INTO staging_sessions (user_id, id, title, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, session.id, session.title, session.createdAt, session.updatedAt, session.data)
}

export const putStagingFile = (userId: string, file: FileInput, now: number): void => {
  db.prepare(
    `INSERT INTO staging_files (user_id, id, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET mime_type = excluded.mime_type, data = excluded.data`
  ).run(userId, file.id, file.mimeType, file.data, now)
}

export const updateStagingFileTypes = (userId: string, types: Record<string, string>): void => {
  const rows = db
    .prepare('SELECT id, data FROM staging_sessions WHERE user_id = ?')
    .all(userId)
  const updateSession = db.prepare('UPDATE staging_sessions SET data = ? WHERE user_id = ? AND id = ?')
  for (const row of rows) {
    let changed = false
    let parsed: { messages?: unknown }
    try {
      parsed = JSON.parse(String(row.data)) as { messages?: unknown }
    } catch {
      continue
    }
    if (!Array.isArray(parsed.messages)) {
      continue
    }
    for (const message of parsed.messages) {
      const item = message as { role?: string; files?: unknown }
      if (item.role !== 'user' || !Array.isArray(item.files)) {
        continue
      }
      for (const file of item.files) {
        const attachment = file as { id?: string; mimeType?: string }
        const mimeType = attachment.id ? types[attachment.id] : undefined
        if (mimeType !== undefined && attachment.mimeType !== mimeType) {
          attachment.mimeType = mimeType
          changed = true
        }
      }
    }
    if (changed) {
      updateSession.run(JSON.stringify(parsed), userId, String(row.id))
    }
  }
  const updateFile = db.prepare(
    'UPDATE staging_files SET mime_type = ? WHERE user_id = ? AND id = ?'
  )
  for (const [id, mimeType] of Object.entries(types)) {
    updateFile.run(mimeType, userId, id)
  }
}

export const commitStaging = (userId: string): SessionSummary[] => {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM chat_files WHERE user_id = ?').run(userId)
    db.prepare(
      `INSERT INTO chat_sessions (user_id, id, title, created_at, updated_at, data)
       SELECT user_id, id, title, created_at, updated_at, data FROM staging_sessions WHERE user_id = ?`
    ).run(userId)
    db.prepare(
      `INSERT INTO chat_files (user_id, id, mime_type, data, created_at)
       SELECT user_id, id, mime_type, data, created_at FROM staging_files WHERE user_id = ?`
    ).run(userId)
    db.prepare('DELETE FROM staging_sessions WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM staging_files WHERE user_id = ?').run(userId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return listSessionSummaries(userId)
}

export const seedProviderConfig = (): void => {
  if (!getProviderConfig()) {
    saveProviderConfig({
      baseUrl: config.apiBaseUrl,
      apiKey: config.apiKey,
      model: config.apiModel,
      options: {},
      now: Date.now(),
    })
  }
}