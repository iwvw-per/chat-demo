import { useEffect } from 'react'
import { AuthPage, AuthSplash } from './AuthPage.js'
import { App } from './App.js'
import { UNAUTHORIZED_EVENT } from '../services/api/backend.js'
import { bootstrapAuth, useAuth } from '../services/auth.js'
import { startProviderSync, resetProvider } from '../services/provider.js'
import { loadServerSettings } from '../services/settings.js'
import { resetChat } from '../services/chat/store.js'

export const Root = () => {
  const ready = useAuth((state) => state.ready)
  const user = useAuth((state) => state.user)
  const userId = user?.id

  useEffect(() => {
    void bootstrapAuth()
  }, [])

  useEffect(() => {
    const onUnauthorized = () => {
      if (useAuth.getState().user) {
        resetChat()
        resetProvider()
      }
      useAuth.setState({ user: null })
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  useEffect(() => {
    if (userId) {
      void startProviderSync().then(loadServerSettings)
    }
  }, [userId])

  if (!ready) {
    return <AuthSplash />
  }
  return user ? <App /> : <AuthPage />
}