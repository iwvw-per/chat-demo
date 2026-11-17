import { apiFetch, apiJson, putJson } from '../api/backend.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** 文件原件按附件的本地 id 存储在服务端,所有引用同一 id 的消息共用一份。 */
export type StoredFile = {
  id: string
  blob: Blob
}

const uploadFile = async (file: StoredFile, path: string): Promise<void> => {
  const form = new FormData()
  form.append('id', file.id)
  form.append('file', file.blob, file.id)
  const response = await apiFetch(path, { method: 'POST', body: form })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `文件上传失败 (${response.status})`)
  }
}

const recentFiles = new Map<string, Blob>()

const rememberFile = (file: StoredFile) => {
  recentFiles.delete(file.id)
  recentFiles.set(file.id, file.blob)
  while (recentFiles.size > 12) {
    const oldest = recentFiles.keys().next().value
    if (oldest === undefined) {
      break
    }
    recentFiles.delete(oldest)
  }
}

const rememberFiles = (files: StoredFile[]) => {
  for (const file of files) {
    rememberFile(file)
  }
}

export const clearFileCache = () => recentFiles.clear()

const uploadFiles = async (files: StoredFile[], path: string): Promise<void> => {
  await Promise.all(files.map((file) => uploadFile(file, path)))
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const body = await apiJson<{ sessions: SessionSummary[] }>('/api/chat/sessions')
  return body.sessions.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  const response = await apiFetch(`/api/chat/sessions/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`读取会话失败 (${response.status})`)
  }
  return (await response.json()) as Session
}

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  rememberFiles(files)
  if (files.length > 0) {
    await uploadFiles(files, '/api/chat/files')
  }
  await putJson(`/api/chat/sessions/${encodeURIComponent(session.id)}`, session)
}

/** 未打开的会话也可重命名,只更新列表元数据。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  const response = await apiFetch(`/api/chat/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!response.ok) {
    throw new Error(`重命名会话失败 (${response.status})`)
  }
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  const response = await apiFetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`删除会话失败 (${response.status})`)
  }
}

export const saveFiles = (files: StoredFile[]): Promise<void> => {
  rememberFiles(files)
  return uploadFiles(files, '/api/chat/files')
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const cached = recentFiles.get(id)
  if (cached) {
    return cached
  }
  const response = await apiFetch(`/api/chat/files/${encodeURIComponent(id)}`)
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new Error(`读取附件失败 (${response.status})`)
  }
  const blob = await response.blob()
  rememberFile({ id, blob })
  return blob
}

/** 清空导入暂存:开始导入前清除上次中断遗留的数据,导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  await apiJson('/api/chat/staging/clear', { method: 'POST' })
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await apiJson('/api/chat/staging/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(session),
  })
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  uploadFiles(files, '/api/chat/staging/files')

/** 图片位于会话 JSON 之后;全部读完后回填具体 MIME,保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  await apiJson('/api/chat/staging/file-types', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ types: Object.fromEntries(types) }),
  })
}

/** 导入完成后用暂存替换正式数据,返回提交后的会话列表。 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const body = await apiJson<{ sessions: SessionSummary[] }>('/api/chat/staging/commit', {
    method: 'POST',
  })
  return body.sessions
}

/** 存储失败不打断对话,只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}