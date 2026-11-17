import { useEffect, useState } from 'react'
import { useTranslate, type TranslationKey } from '../i18n/index.js'
import {
  getAuthStatus,
  login,
  readAuthError,
  register,
  type AuthStatus,
} from '../services/auth.js'
import { BackendError } from '../services/api/backend.js'
import styles from './AuthPage.module.css'

const AUTH_ERROR_KEYS: Record<string, TranslationKey> = {
  invalid_credentials: 'authErrorInvalidCredentials',
  username_taken: 'authErrorUsernameTaken',
  registration_disabled: 'authErrorRegistrationDisabled',
  rate_limited: 'authErrorRateLimited',
  invalid_username: 'authErrorInvalidUsername',
  invalid_password: 'authErrorInvalidPassword',
}

type Mode = 'login' | 'register'

export const AuthPage = () => {
  const t = useTranslate()
  const [mode, setMode] = useState<Mode>('login')
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getAuthStatus().then((value) => {
      if (!active) {
        return
      }
      setStatus(value)
      if (!value.hasUsers && value.allowRegistration) {
        setMode('register')
      }
    })
    return () => {
      active = false
    }
  }, [])

  const canRegister = status?.allowRegistration ?? true

  const submit = async () => {
    if (busy) {
      return
    }
    const name = username.trim()
    if (!name || !password) {
      return
    }
    if (mode === 'register' && password !== confirm) {
      setError(t('authPasswordMismatch'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register') {
        await register(name, password)
      } else {
        await login(name, password)
      }
    } catch (cause) {
      const key = cause instanceof BackendError && cause.code ? AUTH_ERROR_KEYS[cause.code] : undefined
      setError(key ? t(key) : readAuthError(cause))
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>{status?.appName || t('authBrand')}</div>
        <div className={styles.tagline}>{t('authTagline')}</div>
        <div role="tablist" className={styles.tabs}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            className={mode === 'login' ? styles.tabActive : styles.tab}
            onClick={() => {
              setMode('login')
              setError(null)
            }}
          >
            {t('authLogin')}
          </button>
          {canRegister ? (
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={mode === 'register' ? styles.tabActive : styles.tab}
              onClick={() => {
                setMode('register')
                setError(null)
              }}
            >
              {t('authRegister')}
            </button>
          ) : null}
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <label className={styles.field}>
            <span className={styles.label}>{t('authUsername')}</span>
            <input
              className={styles.input}
              value={username}
              autoComplete="username"
              placeholder={t('authUsernamePlaceholder')}
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{t('authPassword')}</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder={t('authPasswordPlaceholder')}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {mode === 'register' ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('authConfirmPassword')}</span>
              <input
                className={styles.input}
                type="password"
                value={confirm}
                autoComplete="new-password"
                placeholder={t('authPasswordPlaceholder')}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
          ) : null}
          {error ? (
            <div className={styles.error} role="alert">
              {error}
            </div>
          ) : null}
          <button
            type="submit"
            className={styles.submit}
            disabled={busy || !username.trim() || !password}
          >
            {busy
              ? t('authSubmitting')
              : t(mode === 'register' ? 'authRegisterAction' : 'authLoginAction')}
          </button>
          {!canRegister ? <div className={styles.hint}>{t('authRegistrationDisabled')}</div> : null}
          {canRegister && status?.hasUsers === false ? (
            <div className={styles.hint}>{t('authFirstUserHint')}</div>
          ) : null}
        </form>
      </div>
    </div>
  )
}

export const AuthSplash = () => {
  const t = useTranslate()
  return (
    <div className={styles.page}>
      <div className={styles.splash} role="status" aria-live="polite">
        {t('sessionLoading')}
      </div>
    </div>
  )
}