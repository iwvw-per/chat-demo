import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useTranslate, type LinkedMessage } from '../../i18n/index.js'
import { IconToastError16 } from './icons.js'
import { useToast } from './toastState.js'
import styles from './Toast.module.css'

const EXIT_DURATION = 160

export const Toast = () => {
  const t = useTranslate()
  const { id, message } = useToast()
  const [content, setContent] = useState<LinkedMessage | string | null>(message)
  const [closing, setClosing] = useState(false)
  const renderedRef = useRef(false)
  renderedRef.current = content !== null

  useEffect(() => {
    if (message) {
      setContent(message)
      setClosing(false)
      return
    }
    if (!renderedRef.current) {
      return
    }
    setClosing(true)
    const timer = window.setTimeout(() => {
      setContent(null)
      setClosing(false)
    }, EXIT_DURATION)
    return () => window.clearTimeout(timer)
  }, [id, message])

  if (!content) {
    return null
  }

  const error = typeof content !== 'string' && content.type === 'error'
  return (
    <div className={clsx(styles.toast, error && styles.error, closing && styles.closing)} role="status">
      {error ? (
        <span className={styles.icon}>
          <IconToastError16 />
        </span>
      ) : null}
      <span className={styles.content}>
        {typeof content === 'string' ? content : t(content.key, content.params)}
        {typeof content !== 'string' && content.link ? (
          <a className={styles.link} href={content.link.href} target="_blank" rel="noreferrer">
            {t(content.link.key)}
          </a>
        ) : null}
      </span>
    </div>
  )
}
