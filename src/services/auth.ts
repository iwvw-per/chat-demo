import { create } from 'zustand'
import { apiFetch, BackendError, postJson, putJson } from './api/backend.js'

export type AuthUser = {
  id: string
  username: string
  role: 'admin' | 'user'
  createdAt: number
}

type AuthState = {
  ready: boolean
  user: AuthUser | null
}

export const useAuth = create<AuthState>(() => ({ ready: false, user: null }))

export type AuthStatus = {
  hasUsers: boolean
  allowRegistration: boolean
  appName: string
}

export const readAuthError = (error: unknown): string => {
  if (error instanceof BackendError) {
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export const bootstrapAuth = async (): Promise<void> => {
  try {
    const response = await apiFetch('/api/auth/me')
    if (response.ok) {
      const body = (await response.json()) as { user: AuthUser }
      useAuth.setState({ ready: true, user: body.user })
      return
    }
  } catch {
    // 网络异常时也进入登录页,登录时会重新请求
  }
  useAuth.setState({ ready: true, user: null })
}

export const getAuthStatus = async (): Promise<AuthStatus> => {
  const response = await apiFetch('/api/auth/status')
  if (!response.ok) {
    return { hasUsers: true, allowRegistration: false, appName: '' }
  }
  return (await response.json()) as AuthStatus
}

export const login = async (username: string, password: string): Promise<void> => {
  const body = await postJson<{ user: AuthUser }>('/api/auth/login', { username, password })
  useAuth.setState({ ready: true, user: body.user })
}

export const register = async (username: string, password: string): Promise<void> => {
  const body = await postJson<{ user: AuthUser }>('/api/auth/register', { username, password })
  useAuth.setState({ ready: true, user: body.user })
}

export const logout = async (): Promise<void> => {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' })
  } finally {
    useAuth.setState({ user: null })
  }
}

export const changePassword = async (currentPassword: string, newPassword: string): Promise<void> => {
  await putJson('/api/auth/password', { currentPassword, newPassword })
}