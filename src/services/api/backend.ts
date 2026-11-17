/** 401 时通知界面回到登录页;登录接口本身不触发。 */
export const UNAUTHORIZED_EVENT = 'chat-demo:unauthorized'

export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

const readError = async (response: Response): Promise<BackendError> => {
  const text = await response.text().catch(() => '')
  let message = text || response.statusText || `请求失败 (${response.status})`
  let code: string | undefined
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: string } }
    if (typeof body.error?.message === 'string') {
      message = body.error.message
    }
    code = body.error?.code
  } catch {
    // 非 JSON 错误体直接展示原文
  }
  return new BackendError(response.status, message, code)
}

export const apiFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new BackendError(0, error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
  return response
}

export const apiJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await apiFetch(path, init)
  if (!response.ok) {
    throw await readError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const putJson = <T>(path: string, value: unknown): Promise<T> =>
  apiJson<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  })

export const postJson = <T>(path: string, value?: unknown): Promise<T> =>
  apiJson<T>(path, {
    method: 'POST',
    ...(value === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  })