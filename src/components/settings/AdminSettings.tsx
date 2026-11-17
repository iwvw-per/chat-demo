import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { apiJson, postJson, putJson } from '../../services/api/backend.js'
import { readAuthError, useAuth, type AuthUser } from '../../services/auth.js'
import { FALLBACK_OPTIONS, type AppOptions } from '../../services/provider.js'
import { Button } from '../base/Button.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

type AdminConfig = {
  baseUrl: string
  model: string
  hasApiKey: boolean
  apiKeyHint: string
  options: AppOptions
}

type Role = 'admin' | 'user'

const errorMessage = (error: unknown) => readAuthError(error)

export const AdminSettings = () => {
  const t = useTranslate()
  const currentUser = useAuth((state) => state.user)
  const [config, setConfig] = useState<AdminConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [options, setOptions] = useState<AppOptions>(FALLBACK_OPTIONS)
  const [configBusy, setConfigBusy] = useState(false)
  const [configMessage, setConfigMessage] = useState<{ text: string; error: boolean } | null>(null)

  const [users, setUsers] = useState<AuthUser[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [userMessage, setUserMessage] = useState<{ text: string; error: boolean } | null>(null)
  const [userBusy, setUserBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [resetValue, setResetValue] = useState('')

  useEffect(() => {
    let active = true
    void apiJson<AdminConfig>('/api/admin/config')
      .then((value) => {
        if (!active) {
          return
        }
        setConfig(value)
        setBaseUrl(value.baseUrl)
        setModel(value.model)
        setOptions(value.options)
      })
      .catch((error: unknown) => {
        if (active) {
          setConfigMessage({ text: errorMessage(error), error: true })
        }
      })
    void apiJson<{ users: AuthUser[] }>('/api/admin/users')
      .then((value) => {
        if (active) {
          setUsers(value.users)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  const saveConfig = async () => {
    if (configBusy) {
      return
    }
    setConfigBusy(true)
    setConfigMessage(null)
    try {
      const value = await putJson<AdminConfig>('/api/admin/config', {
        baseUrl,
        model,
        options,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setConfig(value)
      setOptions(value.options)
      setApiKey('')
      showToast({ key: 'adminSavedHot' })
    } catch (error) {
      setConfigMessage({ text: errorMessage(error), error: true })
    } finally {
      setConfigBusy(false)
    }
  }

  const testConfig = async () => {
    if (configBusy) {
      return
    }
    setConfigBusy(true)
    setConfigMessage(null)
    try {
      const result = await postJson<{ ok: boolean; status: number; message: string }>(
        '/api/admin/config/test',
        { baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
      )
      setConfigMessage(
        result.ok
          ? { text: t('adminTestOk'), error: false }
          : {
              text: t('adminTestFailed', { message: result.message || String(result.status) }),
              error: true,
            }
      )
    } catch (error) {
      setConfigMessage({ text: errorMessage(error), error: true })
    } finally {
      setConfigBusy(false)
    }
  }

  const loadUsers = async () => {
    try {
      const value = await apiJson<{ users: AuthUser[] }>('/api/admin/users')
      setUsers(value.users)
    } catch {
      // 列表加载失败保留原内容
    }
  }

  const createUser = async () => {
    if (userBusy || !username.trim() || !password) {
      return
    }
    setUserBusy(true)
    setUserMessage(null)
    try {
      await postJson('/api/admin/users', { username: username.trim(), password, role })
      setUsername('')
      setPassword('')
      setRole('user')
      await loadUsers()
      showToast({ key: 'adminUserCreated' })
    } catch (error) {
      setUserMessage({ text: t('adminUserCreateFailed', { message: errorMessage(error) }), error: true })
    } finally {
      setUserBusy(false)
    }
  }

  const deleteUser = async (user: AuthUser) => {
    setDeletingId(null)
    try {
      await apiJson(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' })
      await loadUsers()
    } catch (error) {
      setUserMessage({ text: errorMessage(error), error: true })
    }
  }

  const resetPassword = async (user: AuthUser) => {
    if (!resetValue) {
      return
    }
    try {
      await putJson(`/api/admin/users/${encodeURIComponent(user.id)}/password`, {
        password: resetValue,
      })
      setResettingId(null)
      setResetValue('')
      showToast({ key: 'adminResetPasswordDone' })
    } catch (error) {
      setUserMessage({ text: errorMessage(error), error: true })
    }
  }

  return (
    <>
      <div className={styles.sectionTitle}>{t('adminProviderTitle')}</div>
      <form
        className={styles.formStack}
        onSubmit={(event) => {
          event.preventDefault()
          void saveConfig()
        }}
      >
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminBaseUrl')}</span>
          <input
            className={styles.formInput}
            value={baseUrl}
            spellCheck={false}
            placeholder="https://api.deepseek.com"
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminApiKey')}</span>
          <input
            className={styles.formInput}
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              config?.hasApiKey ? t('adminApiKeySaved', { hint: config.apiKeyHint }) : t('adminApiKeyPlaceholder')
            }
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminModel')}</span>
          <input
            className={styles.formInput}
            value={model}
            spellCheck={false}
            placeholder="deepseek-flash"
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <div className={styles.sectionTitle}>{t('adminFrontendTitle')}</div>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminAppName')}</span>
          <input
            className={styles.formInput}
            value={options.appName}
            maxLength={60}
            placeholder={t('appName')}
            onChange={(event) => setOptions({ ...options, appName: event.target.value })}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminWelcomeMessage')}</span>
          <input
            className={styles.formInput}
            value={options.welcomeMessage}
            maxLength={200}
            placeholder={t('welcomeMessageChat250808')}
            onChange={(event) => setOptions({ ...options, welcomeMessage: event.target.value })}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminAnnouncement')}</span>
          <textarea
            className={styles.formTextarea}
            value={options.announcement}
            rows={2}
            maxLength={1000}
            onChange={(event) => setOptions({ ...options, announcement: event.target.value })}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('adminSystemPrompt')}</span>
          <textarea
            className={styles.formTextarea}
            value={options.systemPrompt}
            rows={4}
            maxLength={8000}
            onChange={(event) => setOptions({ ...options, systemPrompt: event.target.value })}
          />
          <span className={styles.formHint}>{t('adminSystemPromptHint')}</span>
        </label>
        <div className={styles.checkboxList}>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.defaultThinking}
              onChange={(event) =>
                setOptions({ ...options, defaultThinking: event.target.checked })
              }
            />
            <span>{t('adminDefaultThinking')}</span>
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.defaultSearch}
              onChange={(event) => setOptions({ ...options, defaultSearch: event.target.checked })}
            />
            <span>{t('adminDefaultSearch')}</span>
          </label>
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={options.allowRegistration}
              onChange={(event) =>
                setOptions({ ...options, allowRegistration: event.target.checked })
              }
            />
            <span>{t('adminAllowRegistration')}</span>
          </label>
        </div>
        {configMessage ? (
          <div className={configMessage.error ? styles.error : styles.formSuccess}>
            {configMessage.text}
          </div>
        ) : null}
        <div className={styles.formActions}>
          <Button variant="outlined" size="m" disabled={configBusy} onClick={() => void testConfig()}>
            {t('adminTest')}
          </Button>
          <Button
            variant="primary"
            size="m"
            disabled={configBusy || !baseUrl.trim() || !model.trim()}
            onClick={() => void saveConfig()}
          >
            {t('adminSave')}
          </Button>
        </div>
      </form>

      <div className={styles.sectionTitle}>{t('adminUsersTitle')}</div>
      <div className={styles.userList}>
        {users.map((user) => (
          <div key={user.id} className={styles.userRow}>
            <div className={styles.userMain}>
              <span className={styles.userName}>{user.username}</span>
              <span className={styles.userRole}>
                {t(user.role === 'admin' ? 'accountRoleAdmin' : 'accountRoleUser')}
              </span>
            </div>
            <div className={styles.rowActions}>
              {deletingId === user.id ? (
                <>
                  <Button variant="danger" size="s" onClick={() => void deleteUser(user)}>
                    {t('adminUserDeleteConfirm', { username: user.username })}
                  </Button>
                  <Button variant="outlined" size="s" onClick={() => setDeletingId(null)}>
                    {t('cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outlined"
                    size="s"
                    onClick={() => {
                      setResettingId(user.id)
                      setResetValue('')
                    }}
                  >
                    {t('adminResetPassword')}
                  </Button>
                  <Button
                    variant="dangerOutlined"
                    size="s"
                    disabled={user.id === currentUser?.id}
                    onClick={() => setDeletingId(user.id)}
                  >
                    {t('adminDeleteUser')}
                  </Button>
                </>
              )}
            </div>
            {resettingId === user.id ? (
              <div className={styles.userReset}>
                <input
                  className={styles.formInput}
                  type="password"
                  autoComplete="new-password"
                  value={resetValue}
                  placeholder={t('adminResetPasswordPlaceholder')}
                  onChange={(event) => setResetValue(event.target.value)}
                />
                <Button
                  variant="primary"
                  size="s"
                  disabled={!resetValue}
                  onClick={() => void resetPassword(user)}
                >
                  {t('confirm')}
                </Button>
                <Button variant="outlined" size="s" onClick={() => setResettingId(null)}>
                  {t('cancel')}
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <form
        className={styles.formStack}
        onSubmit={(event) => {
          event.preventDefault()
          void createUser()
        }}
      >
        <div className={styles.formRow}>
          <label className={styles.formField}>
            <span className={styles.formLabel}>{t('authUsername')}</span>
            <input
              className={styles.formInput}
              value={username}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className={styles.formField}>
            <span className={styles.formLabel}>{t('authPassword')}</span>
            <input
              className={styles.formInput}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className={styles.formField}>
            <span className={styles.formLabel}>{t('adminUserRole')}</span>
            <Select<Role>
              ariaLabel={t('adminUserRole')}
              value={role}
              options={[
                { value: 'user', label: t('accountRoleUser') },
                { value: 'admin', label: t('accountRoleAdmin') },
              ]}
              onChange={setRole}
            />
          </label>
        </div>
        {userMessage ? (
          <div className={userMessage.error ? styles.error : styles.formSuccess}>{userMessage.text}</div>
        ) : null}
        <div className={styles.formActions}>
          <Button
            variant="primary"
            size="m"
            disabled={userBusy || !username.trim() || !password}
            onClick={() => void createUser()}
          >
            {t('adminAddUser')}
          </Button>
        </div>
      </form>
    </>
  )
}