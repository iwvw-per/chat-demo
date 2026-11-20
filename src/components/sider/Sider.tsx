import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useProvider } from '../../services/provider.js'
import logoUrl from '../../assets/deepseek.svg'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 会话项入场/退场动画时长,与 SessionItem.module.css 保持一致 */
const SESSION_ITEM_ANIMATION_MS = 160

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const appName = useProvider((state) => state.options.appName)
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [removingId, setRemovingId] = useState<string | null>(null)
  const knownIdsRef = useRef<Set<string> | null>(null)

  useLayoutEffect(() => {
    const known = knownIdsRef.current
    knownIdsRef.current = new Set(sessions.map((session) => session.id))
    if (!known) {
      return
    }
    const added = sessions
      .filter((session) => !known.has(session.id))
      .map((session) => session.id)
    if (added.length === 0) {
      return
    }
    setEnteringIds(new Set(added))
    const timer = setTimeout(() => setEnteringIds(new Set<string>()), SESSION_ITEM_ANIMATION_MS)
    return () => clearTimeout(timer)
  }, [sessions])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <img
          className={styles.logo}
          src={logoUrl}
          alt={appName || t('appName')}
          draggable={false}
        />
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  entering={enteringIds.has(session.id)}
                  removing={session.id === removingId}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  setRemovingId(deleting.id)
                  try {
                    await new Promise((resolve) => setTimeout(resolve, SESSION_ITEM_ANIMATION_MS))
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setRemovingId(null)
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
const DRAWER_TRANSITION_MS = 240

const drawerTransitionMs = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DRAWER_TRANSITION_MS

export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  // 收起时先播放退场过渡,再卸载抽屉
  const [mounted, setMounted] = useState(false)
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setActive(true))
      return () => cancelAnimationFrame(frame)
    }
    setActive(false)
    const timer = setTimeout(() => setMounted(false), drawerTransitionMs())
    return () => clearTimeout(timer)
  }, [open])

  if (!mounted) {
    return null
  }
  return (
    <>
      <div
        className={clsx(styles.drawerMask, !active && styles.drawerMaskHidden)}
        aria-hidden={!active}
        onClick={closeMobileSider}
      />
      <div className={clsx(styles.drawer, !active && styles.drawerHidden)} aria-hidden={!active}>
        <Sider mobile />
      </div>
    </>
  )
}
