import { create } from 'zustand'

/** 设置弹窗的分组:通用设置 / 数据管理 / 账号 / 管理控制台(仅管理员) */
export type SettingsSection = 'general' | 'data' | 'account' | 'admin'

/** 设置弹窗:侧边栏底部、账号菜单与错误提示都可以打开;section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })