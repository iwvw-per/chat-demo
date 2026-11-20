import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

const MENU_EXIT_MS = 120

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  children,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const visible = open || closing
  const close = () => {
    setOpen(false)
    setClosing(true)
  }
  useEffect(() => {
    if (!closing) {
      return
    }
    const timer = setTimeout(() => setClosing(false), MENU_EXIT_MS)
    return () => clearTimeout(timer)
  }, [closing])
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    visible,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({
          open,
          toggle: () => {
            if (open) {
              close()
              return
            }
            setClosing(false)
            setOpen(true)
          },
        })}
      </span>
      {visible
        ? createPortal(
            <div
              ref={floatingRef}
              className={clsx(styles.menu, closing && styles.closing)}
              style={position ?? { visibility: 'hidden' }}
              role="menu"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    close()
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
