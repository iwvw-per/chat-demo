import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { changePassword, logout, readAuthError, useAuth } from '../../services/auth.js'
import { resetChat } from '../../services/chat/store.js'
import { resetProvider } from '../../services/provider.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import { SettingCell, type Status } from './SettingCell.js'
import styles from './Settings.module.css'

export const AccountSettings = () => {
  const t = useTranslate()
  const user = useAuth((state) => state.user)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const submit = async () => {
    if (busy) {
      return
    }
    if (next !== confirm) {
      setStatus({ key: 'authPasswordMismatch', error: true })
      return
    }
    setBusy(true)
    setStatus(null)
    try {
      await changePassword(current, next)
      setCurrent('')
      setNext('')
      setConfirm('')
      showToast({ key: 'accountPasswordChanged' })
    } catch (error) {
      setStatus({
        key: 'accountPasswordFailed',
        params: { message: readAuthError(error) },
        error: true,
      })
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    await logout()
    resetChat()
    resetProvider()
  }

  return (
    <>
      <SettingCell
        label={t('accountSignedInAs')}
        description={t(user?.role === 'admin' ? 'accountRoleAdmin' : 'accountRoleUser')}
        status={null}
        action={<span className={styles.accountValue}>{user?.username ?? ''}</span>}
      />
      <div className={styles.sectionTitle}>{t('accountChangePassword')}</div>
      <form
        className={styles.formStack}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('accountCurrentPassword')}</span>
          <input
            className={styles.formInput}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('accountNewPassword')}</span>
          <input
            className={styles.formInput}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
        </label>
        <label className={styles.formField}>
          <span className={styles.formLabel}>{t('accountConfirmNewPassword')}</span>
          <input
            className={styles.formInput}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </label>
        {status ? (
          <div className={styles.error}>{t(status.key, status.params)}</div>
        ) : null}
        <div className={styles.formActions}>
          <Button
            variant="primary"
            size="m"
            disabled={busy || !current || !next || !confirm}
            onClick={() => void submit()}
          >
            {t('confirm')}
          </Button>
        </div>
      </form>
      <SettingCell
        label={t('accountLogout')}
        status={null}
        action={
          <Button variant="dangerOutlined" size="m" className={styles.cellButton} onClick={() => void signOut()}>
            {t('accountLogout')}
          </Button>
        }
      />
    </>
  )
}