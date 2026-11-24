import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { android, saveAndroidHistory } from '../../app/android.js'
import { openAndroidPage } from '../../app/openAndroidPage.js'
import {
  subscribeToAndroidBackPreview,
  useAndroidBackInterception,
} from '../../app/useAndroidBackInterception.js'
import { useTranslate, type LinkedMessage, type TranslationKey } from '../../i18n/index.js'
import type { TtsVoice } from '../../services/api/speech.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  formatExportWarning,
  formatImportResult,
  importHistory,
  type ImportMode,
} from '../../services/chat/backup.js'
import { useChatStore } from '../../services/chat/store.js'
import { setInert } from '../../utils/inert.js'
import {
  setApiKey,
  setFoldThinking,
  setFontSize,
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type LocalePreference,
  type ThemePreference,
} from '../../services/settings.js'
import {
  IconChevronRightOutline14,
  IconCloseOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconGlobeLanguageOutline14,
  IconLightOutline16,
  IconLinkOutline16,
  IconRefreshOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { closeOverlaySider } from '../sider/mobileSiderState.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import { AdvancedApiSettings } from './AdvancedApiSettings.js'
import { createSettingsPageMotion } from './androidSettingsMotion.js'
import { ProfileIcon } from './ProfileAvatar.js'
import { ProfileEditor } from './ProfileEditor.js'
import { closeSettings, useSettingsDialog } from './settingsDialogState.js'
import { balanceCurrencySymbol } from '../../services/api/balance.js'
import { useAccountBalance, type BalanceState } from './useAccountBalance.js'
import styles from './AndroidSettings.module.css'

const appVersion = document.querySelector<HTMLMetaElement>(
  'meta[name="application-version"]'
)?.content
const policiesUrl = 'https://cdn.deepseek.com/policies'
const chinesePoliciesUrl = `${policiesUrl}/zh-CN`
const faqUrl = 'https://static.deepseek.com/faq/index.html'
const platformUsageUrl = 'https://platform.deepseek.com/usage'
const releasesUrl = 'https://github.com/LiJiaHua1024/deepseek-app-replica/releases/latest'

const updateMessages = {
  current: 'updateCurrent',
  checkFailed: 'updateCheckFailed',
  downloadFailed: 'updateDownloadFailed',
  invalidApk: 'updateInvalidApk',
  apkMissing: 'updateApkMissing',
  permissionDenied: 'updatePermissionDenied',
  installerUnavailable: 'updateInstallerUnavailable',
} satisfies Record<string, TranslationKey>

type UpdateStatus = {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready'
  version?: string
  progress?: number
  message?: keyof typeof updateMessages
}

type Page =
  | 'root'
  | 'account'
  | 'advanced'
  | 'data'
  | 'export'
  | 'font'
  | 'personalization'
  | 'agreements'
type Popup = 'locale' | 'theme' | 'voice' | 'logout' | 'delete' | 'import'

const parentPage: Record<Page, Page | null> = {
  root: null,
  account: 'root',
  advanced: 'account',
  data: 'root',
  export: 'data',
  font: 'root',
  personalization: 'root',
  agreements: 'root',
}

const PersonalizationIcon = () => (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M6.374 5.017 4.897 4.499c-.247-.086-.484.151-.398.398l.518 1.477c.349.992.174 2.093-.463 2.929l-.95 1.244c-.158.208-.006.508.256.502l1.564-.037c1.052-.024 2.045.481 2.643 1.346l.89 1.287c.149.216.481.163.556-.088l.448-1.499a3.32 3.32 0 0 1 2.097-2.097l1.499-.448c.251-.075.304-.407.088-.556l-1.287-.89a3.32 3.32 0 0 1-1.346-2.643l.037-1.564c.006-.262-.294-.414-.502-.256l-1.244.95a3.32 3.32 0 0 1-2.929.463Zm-1.573-2.207c-1.236-.433-2.424.755-1.991 1.991l.734 2.09a1.32 1.32 0 0 1-.232 1.465l-1.344 1.761c-.794 1.041-.031 2.539 1.279 2.508l2.214-.052c.526-.012 1.022.241 1.321.674l1.26 1.821c.745 1.078 2.405.815 2.781-.44l.635-2.122c.15-.504.544-.898 1.048-1.048l2.122-.635c1.255-.376 1.518-2.036.44-2.781l-1.821-1.26a1.32 1.32 0 0 1-.674-1.321l.052-2.214c.031-1.31-1.467-2.073-2.509-1.279l-1.76 1.344a1.32 1.32 0 0 1-1.465.232l-2.09-.734Z"
    />
    <path d="M12.387 13.729a.9.9 0 1 1 1.344-1.344l3.384 2.722a1.5 1.5 0 1 1-1.885 2.007l-2.72-3.385Z" />
  </svg>
)

const PolicyIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4.4 2.75h6.8c.8 0 1.4.6 1.4 1.4v5.9" />
    <path d="M4.4 2.75c-.8 0-1.4.6-1.4 1.4v9.1c0 .8.6 1.4 1.4 1.4h2.9" />
    <path d="M6 5.8h5M6 8.5h3.3" />
    <path d="m10.1 13.3 3.65-3.65 1.55 1.55-3.65 3.65-2.05.5.5-2.05Z" />
  </svg>
)

const LogoutIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M8.2 3H5.6A1.6 1.6 0 0 0 4 4.6v8.8A1.6 1.6 0 0 0 5.6 15h2.6" />
    <path d="M10.7 5.7 14 9l-3.3 3.3M7.5 9H14" />
  </svg>
)

const VoiceIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3.2 7.2h2.1l3.1-2.5v8.6L5.3 10.8H3.2V7.2Z" />
    <path d="M11 6.1c1.55 1.6 1.55 4.2 0 5.8" />
    <path d="M12.6 4.5c2 2.5 2 6.5 0 9" />
  </svg>
)

const FontSizeIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.4 14.25 3.8 8.25l2.4 6M2.2 12.25h3.2" />
    <path d="M8.6 14.25 12.6 3.75l4 10.5M9.95 10.75h5.3" />
  </svg>
)

const Info = ({ glyph = 'i' }: { glyph?: string }) => <span className={styles.info}>{glyph}</span>

const Group = ({
  label,
  children,
  spaced,
}: {
  label?: string
  children: ReactNode
  spaced?: boolean
}) => (
  <section className={styles.group} data-spaced={spaced ? '' : undefined}>
    {label ? <h2>{label}</h2> : null}
    <div className={styles.card}>{children}</div>
  </section>
)

const Row = ({
  label,
  icon,
  value,
  onClick,
  href,
  control,
  danger = false,
  disabled = false,
  arrow = Boolean(onClick || href),
}: {
  label: string
  icon?: ReactNode
  value?: string
  onClick?: () => void
  href?: string
  control?: ReactNode
  danger?: boolean
  disabled?: boolean
  arrow?: boolean
}) => {
  const contents = (
    <>
      {icon ? <span className={styles.icon}>{icon}</span> : null}
      <span className={styles.rowLabel}>{label}</span>
      {value ? <span className={styles.value}>{value}</span> : null}
      {control}
      {arrow ? (
        <span className={styles.arrow}>
          <IconChevronRightOutline14 />
        </span>
      ) : null}
    </>
  )
  if (href) {
    return (
      <a className={styles.row} href={href}>
        {contents}
      </a>
    )
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={styles.row}
        data-danger={danger}
        disabled={disabled}
        onClick={onClick}
      >
        {contents}
      </button>
    )
  }
  return <div className={styles.row}>{contents}</div>
}

/** 已登录 Key 的账号余额卡片：展示总余额、赠金/充值分项，支持手动刷新。 */
const BalancePanel = ({ state, onRefresh }: { state: BalanceState; onRefresh: () => void }) => {
  const t = useTranslate()
  if (state.status === 'idle') {
    return null
  }

  const ready = state.status === 'ready'
  const symbol = ready ? balanceCurrencySymbol(state.data.currency) : ''
  const currencyCode =
    ready && state.data.currency && !['CNY', 'USD'].includes(state.data.currency)
      ? state.data.currency
      : ''

  let value: string
  let tone: 'default' | 'error' | 'muted' = 'default'
  if (state.status === 'loading') {
    value = t('balanceLoading')
    tone = 'muted'
  } else if (state.status === 'error') {
    value = state.reason === 'unauthorized' ? t('balanceUnauthorized') : t('balanceFailed')
    tone = 'error'
  } else {
    value = state.data.isAvailable
      ? `${symbol}${state.data.totalBalance}`
      : t('balanceLow')
    tone = state.data.isAvailable ? 'default' : 'error'
  }

  return (
    <div className={styles.balance} data-tone={tone}>
      <div className={styles.balanceMain}>
        <span className={styles.balanceLabel}>{t('balanceTitle')}</span>
        <span className={styles.balanceValue}>
          {value}
          {currencyCode ? ` ${currencyCode}` : ''}
        </span>
        <button
          type="button"
          className={styles.balanceRefresh}
          aria-label={t('balanceRefresh')}
          disabled={state.status === 'loading'}
          onClick={onRefresh}
        >
          <IconRefreshOutline16 />
        </button>
      </div>
      {ready ? (
        <div className={styles.balanceMeta}>
          <span>
            {t('balanceGranted')} {symbol}{state.data.grantedBalance}
          </span>
          <span>
            {t('balanceToppedUp')} {symbol}{state.data.toppedUpBalance}
          </span>
        </div>
      ) : null}
    </div>
  )
}

const Switch = ({
  label,
  checked,
  toggle,
}: {
  label: string
  checked: boolean
  toggle?: () => void
}) => (
  <button
    type="button"
    className={styles.switch}
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={!toggle}
    onClick={toggle}
  >
    <span />
  </button>
)

const Choice = <T extends string>({
  title,
  icon,
  value,
  fields,
  confirmLabel,
  confirm,
  dismiss,
}: {
  title: string
  icon?: ReactNode
  value: T
  fields: ReadonlyArray<{ id: T; label: string }>
  confirmLabel?: string
  confirm: (value: T) => void
  dismiss: () => void
}) => {
  const t = useTranslate()
  const [next, setNext] = useState(value)
  return (
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          dismiss()
        }
      }}
    >
      <section className={styles.choice} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          {icon}
          {title}
        </header>
        <div className={styles.options} role="radiogroup" aria-label={title}>
          {fields.map((field) => (
            <button
              key={field.id}
              type="button"
              role="radio"
              aria-checked={next === field.id}
              onClick={() => setNext(field.id)}
            >
              {field.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.confirm} onClick={() => confirm(next)}>
          {confirmLabel ?? t('confirm')}
        </button>
      </section>
    </div>
  )
}

export const AndroidSettings = ({ chatFrame }: { chatFrame: RefObject<HTMLDivElement> }) => {
  const open = useSettingsDialog((state) => state.open)
  const section = useSettingsDialog((state) => state.section)
  return open ? (
    <Settings
      start={section === 'general' ? 'root' : section === 'advanced' ? 'advanced' : 'account'}
      chatFrame={chatFrame}
      key={section}
    />
  ) : null
}

const Settings = ({ start, chatFrame }: { start: Page; chatFrame: RefObject<HTMLDivElement> }) => {
  const t = useTranslate()
  const {
    locale,
    localePreference,
    themePreference,
    fontSize,
    foldThinking,
    ttsVoice,
    chatConfig,
  } = useSettings()
  const tr = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const [page, setPage] = useState<Page>(start)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [tone, setTone] = useState(ttsVoice)
  const [busy, setBusy] = useState(false)
  const [update, setUpdate] = useState<UpdateStatus>({ phase: 'idle' })
  const [updateFallback, setUpdateFallback] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [importMode, setImportMode] = useState<ImportMode>('merge')
  const [importStatus, setImportStatus] = useState<LinkedMessage | null>(null)
  const [exportSavedName, setExportSavedName] = useState<string | null>(null)
  const importInput = useRef<HTMLInputElement>(null)
  const pagesRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<ReturnType<typeof createSettingsPageMotion>>()
  const enterNext = useRef(true)
  const exiting = useRef(false)
  const sessions = useChatStore((state) => state.sessions.length)
  const editor = useApiKeyEditor()
  const balance = useAccountBalance(editor.apiKey)
  const updateBusy = update.phase === 'checking' || update.phase === 'downloading'

  useEffect(() => {
    if (!android?.updateStatus) {
      return
    }
    const onUpdate = (event: Event) => {
      const status = (event as CustomEvent<UpdateStatus>).detail
      setUpdate(status)
      if (status.message) {
        showToast({
          key: updateMessages[status.message],
          type: status.message === 'current' ? undefined : 'error',
        })
      }
      setUpdateFallback(
        status.message === 'checkFailed' ||
          status.message === 'downloadFailed' ||
          status.message === 'installerUnavailable'
      )
    }
    window.addEventListener('android-update', onUpdate)
    try {
      setUpdate(JSON.parse(android.updateStatus()) as UpdateStatus)
    } catch {
      // Ignore malformed native update snapshots so Settings stays usable.
    }
    return () => window.removeEventListener('android-update', onUpdate)
  }, [])

  const labels: Record<Page, string> = {
    root: t('settings'),
    account: t('accountManagement'),
    advanced: t('advancedSettings'),
    data: tr('数据管理', 'Data management'),
    export: t('exportAllLabel'),
    font: tr('字体大小', 'Text size'),
    personalization: tr('个性化', 'Personalization'),
    agreements: tr('服务协议', 'Service agreement'),
  }
  const language = tr('语言', 'Language')
  const appearance = tr('外观', 'Appearance')
  const voice = tr('朗读音色', 'Read-aloud voice')
  const autoFold = tr('思考内容自动折叠', 'Collapse thinking automatically')
  const follow = tr('跟随系统', 'Follow system')
  const logout = tr('退出登录', 'Sign out')
  const clear = tr('删除所有历史对话', 'Delete all conversations')
  const themes: { id: ThemePreference; label: string }[] = [
    { id: 'system', label: tr('系统', 'System') },
    { id: 'light', label: tr('浅色', 'Light') },
    { id: 'dark', label: tr('深色', 'Dark') },
  ]
  const languages: { id: LocalePreference; label: string }[] = [
    { id: 'system', label: tr('系统', 'System') },
    { id: 'zh-CN', label: '中文 (简体中文)' },
    { id: 'en-US', label: 'English' },
  ]
  const tones: { id: TtsVoice; label: string; description: string }[] = [
    {
      id: 'stella',
      label: t('settingsTtsVoiceStella'),
      description: t('settingsTtsVoiceStellaDescription'),
    },
    {
      id: 'tide',
      label: t('settingsTtsVoiceTide'),
      description: t('settingsTtsVoiceTideDescription'),
    },
  ]
  const currentTone = tones.find((item) => item.id === tone) ?? tones[0]
  const systemFontStep = Math.min(
    6,
    Math.max(0, Math.round(((android?.systemFontScale() ?? 1) - 1) / 0.1 + 2))
  )
  const languageLabel = languages.find((item) => item.id === locale)?.label
  const themeLabel = themes.find((item) => item.id === themePreference)?.label
  const localizedPoliciesUrl = `${policiesUrl}/${locale}`

  const openPage = (next: Page) => {
    if (exiting.current) {
      return
    }
    closeOverlaySider()
    enterNext.current = true
    setPage(next)
  }

  const back = () => {
    if (busy || exiting.current) {
      return
    }
    if (popup) {
      setPopup(null)
      setFile(null)
      return
    }
    const finish = () => {
      const previous = parentPage[page]
      if (previous) {
        enterNext.current = false
        setPage(previous)
      } else {
        closeSettings()
      }
    }
    const motion = motionRef.current
    if (!motion) {
      finish()
      return
    }
    closeOverlaySider()
    exiting.current = true
    void motion.play('back').then((finished) => {
      if (motionRef.current !== motion) {
        return
      }
      if (finished) {
        finish()
      } else {
        exiting.current = false
      }
    })
  }

  useAndroidBackInterception()
  useLayoutEffect(() => {
    const pages = pagesRef.current
    const getPage = (screen: Page) =>
      pages?.querySelector<HTMLElement>(`[data-settings-page="${screen}"]`)
    const settings = getPage(page)
    const content = settings?.querySelector<HTMLElement>(`.${styles.pageContent}`)
    if (!settings || !content) {
      return
    }
    const parent = parentPage[page]
    const previous = parent
      ? (getPage(parent)?.querySelector<HTMLElement>(`.${styles.pageContent}`) ?? null)
      : chatFrame.current
    exiting.current = false
    const motion = createSettingsPageMotion(settings, content, previous)
    motionRef.current = motion
    if (enterNext.current) {
      void motion.play('enter').then((finished) => {
        if (finished && motionRef.current === motion && !exiting.current) {
          motion.cancel()
          closeOverlaySider()
        }
      })
    }
    return () => {
      motionRef.current = undefined
      motion.cancel()
    }
  }, [chatFrame, page])

  const canPreview = page !== 'font' && popup === null && !busy
  useLayoutEffect(() => {
    const motion = motionRef.current
    if (!canPreview || !motion) {
      return
    }
    let previewing = false
    const unsubscribe = subscribeToAndroidBackPreview((preview) => {
      if (!exiting.current) {
        if (preview && !previewing) {
          closeOverlaySider()
        }
        previewing = Boolean(preview)
        motion.seek(preview?.progress ?? 0)
      }
    })
    return () => {
      unsubscribe?.()
      if (previewing && !exiting.current && motionRef.current === motion) {
        motion.seek(0)
      }
    }
  }, [canPreview, page])

  useEffect(() => {
    const onBack = (event: Event) => {
      event.preventDefault()
      back()
    }
    window.addEventListener('android-back', onBack)
    return () => window.removeEventListener('android-back', onBack)
  })

  const runExportAction = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      showToast({
        key: 'historyExportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const confirmAction = async () => {
    if (busy) {
      return
    }
    if (popup === 'logout') {
      if (setApiKey(null)) {
        closeSettings()
      } else {
        showToast({ key: 'apiKeyStorageFailed' })
      }
      return
    }
    setBusy(true)
    try {
      if (popup === 'import' && file) {
        setPopup(null)
        setFile(null)
        setImportStatus({ key: 'historyImporting' })
        const result = await importHistory(file, setImportStatus, importMode)
        setImportStatus(formatImportResult(result))
      } else if (popup === 'delete') {
        await clearHistory()
        showToast({ key: 'historyDeleted' })
        setPopup(null)
      }
    } catch (error) {
      if (popup === 'import') {
        setImportStatus({
          key: error instanceof BackupError ? error.key : 'historyImportFailed',
          type: 'error',
        })
      } else {
        showToast({ key: 'historyDeleteFailed', type: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }

  const renderPage = (screen: Page) => (
    <>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.back}
          aria-label={tr('返回', 'Back')}
          onClick={back}
        >
          <IconChevronRightOutline14 />
        </button>
        <h1>{labels[screen]}</h1>
      </header>
      <div className={styles.scroll}>
        {screen === 'root' ? (
          <>
            <Group label={tr('账户', 'Account')}>
              <Row
                label={labels.account}
                icon={<ProfileIcon />}
                onClick={() => openPage('account')}
              />
              <Row
                label={labels.data}
                icon={<IconDataOutline16 />}
                onClick={() => openPage('data')}
              />
            </Group>
            <Group label={tr('应用', 'App')}>
              <Row
                label={language}
                value={languageLabel}
                icon={<IconGlobeLanguageOutline14 />}
                onClick={() => setPopup('locale')}
              />
              <Row
                label={appearance}
                value={themeLabel}
                icon={<IconLightOutline16 />}
                onClick={() => setPopup('theme')}
              />
              <Row label={labels.font} icon={<FontSizeIcon />} onClick={() => openPage('font')} />
              <Row
                label={labels.personalization}
                icon={<PersonalizationIcon />}
                onClick={() => openPage('personalization')}
              />
            </Group>
            <Group label={tr('语音', 'Voice')}>
              <Row
                label={voice}
                icon={<VoiceIcon />}
                arrow={false}
                onClick={() => {
                  setTone(ttsVoice)
                  setPopup('voice')
                }}
              />
            </Group>
            <Group label={tr('关于', 'About')}>
              <Row label={tr('版本信息', 'Version')} value={appVersion} icon={<Info />} />
              {android?.checkForUpdate ? (
                <Row
                  label={t('checkForUpdate')}
                  value={update.phase === 'checking' ? t('checkingForUpdate') : undefined}
                  icon={<IconRefreshOutline16 />}
                  onClick={() => android?.checkForUpdate()}
                  disabled={updateBusy}
                  arrow={false}
                />
              ) : null}
              {update.version && android ? (
                <Row
                  label={t(
                    update.phase === 'downloading'
                      ? 'updateDownloading'
                      : update.phase === 'ready'
                        ? 'updateInstall'
                        : 'updateDownload'
                  )}
                  value={
                    update.phase === 'downloading'
                      ? `${update.progress ?? 0}%`
                      : `v${update.version}`
                  }
                  icon={<IconDownloadOutline16 />}
                  onClick={() => android?.installUpdate()}
                  disabled={updateBusy}
                  arrow={false}
                />
              ) : null}
              {updateFallback || update.phase === 'ready' ? (
                <Row
                  label={t('updateOpenReleases')}
                  icon={<IconLinkOutline16 />}
                  href={releasesUrl}
                />
              ) : null}
              <Row
                label={labels.agreements}
                icon={<PolicyIcon />}
                onClick={() => openPage('agreements')}
              />
            </Group>
            <Group spaced>
              <Row
                label={tr('帮助与反馈', 'Help & Feedback')}
                icon={<Info glyph="?" />}
                onClick={() => openAndroidPage(faqUrl, { showBrowserAction: false })}
              />
            </Group>
            {editor.apiKey ? (
              <Group spaced>
                <Row
                  label={logout}
                  icon={<LogoutIcon />}
                  danger
                  arrow={false}
                  onClick={() => setPopup('logout')}
                />
              </Group>
            ) : null}
          </>
        ) : null}
        {screen === 'account' ? (
          <>
            <Group>
              <ProfileEditor />
            </Group>
            <Group label={tr('账户', 'Account')}>
              <Row
                label="DeepSeek API Key"
                icon={<ProfileIcon />}
                value={editor.apiKey ? '••••••••' : undefined}
                onClick={() => editor.setEditing(true)}
              />
              {editor.editing ? (
                <div className={styles.credentials}>
                  <ApiKeyField editor={editor} />
                  <ApiKeyConfirm editor={editor} />
                </div>
              ) : null}
              {editor.apiKey ? (
                <BalancePanel state={balance.state} onRefresh={balance.refresh} />
              ) : null}
              <Row
                label={labels.advanced}
                value={chatConfig.model}
                onClick={() => openPage('advanced')}
              />
              <Row
                label={t('balanceUsageEntry')}
                icon={<IconLinkOutline16 />}
                onClick={() => {
                  if (!openAndroidPage(platformUsageUrl)) {
                    window.open(platformUsageUrl, '_blank', 'noopener')
                  }
                }}
              />
              <Row
                label={tr('开放平台', 'Open platform')}
                href="https://platform.deepseek.com/api_keys"
              />
              <Row
                label={tr('开放平台帮助', 'API help')}
                href="https://api-docs.deepseek.com/zh-cn/"
              />
            </Group>
            <p className={styles.legal}>{t('appName')}</p>
          </>
        ) : null}
        {screen === 'advanced' ? (
          <Group>
            <AdvancedApiSettings onSave={back} />
          </Group>
        ) : null}
        {screen === 'data' ? (
          <>
            <p className={styles.caption}>
              {tr(
                '历史对话保存在此设备。API 数据处理适用 ',
                'Chat history is stored on this device. API usage is subject to the '
              )}
              <a href={`${chinesePoliciesUrl}/deepseek-open-platform-privacy-policy.html`}>
                {tr('DeepSeek 开放平台隐私政策', 'DeepSeek Open Platform Privacy Policy')}
              </a>
              {tr('。', '.')}
            </p>
            <Group>
              <Row
                label={labels.export}
                disabled={busy}
                onClick={() => {
                  setExportSavedName(null)
                  openPage('export')
                }}
              />
            </Group>
            <Group>
              <Row
                label={clear}
                danger
                arrow={false}
                disabled={busy}
                onClick={() => setPopup('delete')}
              />
            </Group>
            <Group>
              <Row
                label={t('historyImport')}
                arrow={false}
                disabled={busy}
                onClick={() => importInput.current?.click()}
              />
              <input
                ref={importInput}
                hidden
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => {
                  const selected = event.target.files?.[0]
                  event.target.value = ''
                  if (selected) {
                    setImportMode('merge')
                    setFile(selected)
                    setPopup('import')
                  }
                }}
              />
            </Group>
            {importStatus ? (
              <p
                className={styles.caption}
                role={importStatus.type === 'error' ? 'alert' : 'status'}
              >
                {t(importStatus.key, importStatus.params)}
              </p>
            ) : null}
          </>
        ) : null}
        {screen === 'export' ? (
          <>
            <Group>
              <Row
                label={tr('保存到设备', 'Save to device')}
                arrow={false}
                disabled={busy || !sessions}
                onClick={() =>
                  void runExportAction(async () => {
                    setExportSavedName(null)
                    const exported = await exportHistory()
                    const warning = formatExportWarning(exported)
                    if (warning) {
                      showToast(warning)
                    }
                    if (android) {
                      if (await saveAndroidHistory(exported.name, exported.blob)) {
                        setExportSavedName(exported.name)
                      }
                      return
                    }
                    const url = URL.createObjectURL(exported.blob)
                    const link = document.createElement('a')
                    link.href = url
                    link.download = exported.name
                    link.click()
                    setTimeout(() => URL.revokeObjectURL(url), 10_000)
                    setExportSavedName(exported.name)
                  })
                }
              />
            </Group>
            <p className={styles.caption} role="status">
              {busy
                ? t('historyExporting')
                : exportSavedName
                  ? t('historyExportSaved', { name: exportSavedName })
                  : t(sessions ? 'historyExportDescription' : 'androidNoChats')}
            </p>
          </>
        ) : null}
        {screen === 'font' ? (
          <div
            className={styles.preview}
            style={{
              fontSize: `${16 * (fontSize === null ? (android?.systemFontScale() ?? 1) : 1 + (fontSize - 2) * 0.1)}px`,
            }}
          >
            <span>{tr('预览文字大小', 'Preview text size')}</span>
            <p>
              {tr('你可以拖动滑块来调整字体大小。', 'Drag the slider to adjust the text size.')}
            </p>
            <p>
              {tr(
                '如果在使用过程中存在问题或建议，可反馈给 DeepSeek 团队。',
                'You can share questions or suggestions with DeepSeek.'
              )}
            </p>
          </div>
        ) : null}
        {screen === 'personalization' ? (
          <>
            <Group>
              <Row
                label={autoFold}
                control={
                  <Switch
                    label={autoFold}
                    checked={foldThinking}
                    toggle={() => setFoldThinking(!foldThinking)}
                  />
                }
              />
            </Group>
            <p className={styles.caption}>
              {tr(
                '开启后，思考结束后将自动折叠思考内容',
                'Collapse thinking once an answer is ready.'
              )}
            </p>
          </>
        ) : null}
        {screen === 'agreements' ? (
          <Group>
            <Row
              label={tr('用户协议', 'Terms of Use')}
              onClick={() => openAndroidPage(`${localizedPoliciesUrl}/deepseek-terms-of-use.html`)}
            />
            <Row
              label={tr('隐私政策', 'Privacy Policy')}
              onClick={() =>
                openAndroidPage(`${localizedPoliciesUrl}/deepseek-privacy-policy.html`)
              }
            />
            <Row
              label={tr('第三方信息共享清单', 'SDK Sharing List')}
              onClick={() =>
                openAndroidPage(`${chinesePoliciesUrl}/third-party-info-sharing-list.html`)
              }
            />
            <Row
              label={tr('个人信息收集清单', 'Collected Personal Information')}
              onClick={() =>
                openAndroidPage(`${chinesePoliciesUrl}/collected-personal-information.html`)
              }
            />
            <Row
              label={tr('应用权限', 'App Permissions')}
              onClick={() => android?.openAppPermissions()}
            />
          </Group>
        ) : null}
      </div>
      {screen === 'font' ? (
        <div className={styles.fontPanel}>
          <Row
            label={follow}
            control={
              <Switch
                label={follow}
                checked={fontSize === null}
                toggle={() => setFontSize(fontSize === null ? systemFontStep : null)}
              />
            }
          />
          <div className={styles.fontLabels}>
            <small>A</small>
            <span>{tr('标准', 'Standard')}</span>
            <strong>A</strong>
          </div>
          <div className={styles.rangeWrap}>
            <div className={styles.rangeTicks} aria-hidden="true">
              {Array.from({ length: 7 }, (_, step) => (
                <span key={step} />
              ))}
            </div>
            <input
              type="range"
              aria-label={labels.font}
              min="0"
              max="6"
              step="1"
              value={fontSize ?? systemFontStep}
              onChange={(event) => setFontSize(event.target.valueAsNumber)}
            />
          </div>
        </div>
      ) : null}
    </>
  )

  const popups = (
    <>
      {popup === 'locale' ? (
        <Choice
          title={language}
          icon={<IconGlobeLanguageOutline14 />}
          value={localePreference}
          fields={languages}
          confirmLabel={tr('确认', 'Confirm')}
          confirm={(value) => {
            setLocale(value)
            setPopup(null)
          }}
          dismiss={back}
        />
      ) : null}
      {popup === 'theme' ? (
        <Choice
          title={appearance}
          value={themePreference}
          fields={themes}
          confirmLabel={tr('确认', 'Confirm')}
          confirm={(value) => {
            setThemePreference(value)
            setPopup(null)
          }}
          dismiss={back}
        />
      ) : null}
      {popup === 'voice' ? (
        <div
          className={styles.overlay}
          data-sheet=""
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              back()
            }
          }}
        >
          <section className={styles.voiceSheet} role="dialog" aria-modal="true" aria-label={voice}>
            <header>
              {voice}
              <button type="button" aria-label={t('close')} onClick={back}>
                <IconCloseOutline16 />
              </button>
            </header>
            <div
              className={styles.voiceBody}
              onTouchStart={(event) => {
                event.currentTarget.dataset.swipeX = String(event.touches[0].clientX)
              }}
              onTouchEnd={(event) => {
                const dx =
                  event.changedTouches[0].clientX - Number(event.currentTarget.dataset.swipeX)
                if (Math.abs(dx) > 32) {
                  setTone(dx > 0 ? 'stella' : 'tide')
                }
              }}
            >
              <div className={styles.voiceArt} data-tone={tone} aria-hidden="true" />
              <div>{currentTone.label}</div>
              <small>{currentTone.description}</small>
              <div className={styles.dots} role="radiogroup" aria-label={voice}>
                {tones.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-label={item.label}
                    aria-checked={tone === item.id}
                    onClick={() => setTone(item.id)}
                  />
                ))}
              </div>
            </div>
            <button
              className={styles.primary}
              type="button"
              onClick={() => {
                setTtsVoice(tone)
                setPopup(null)
              }}
            >
              {tr('确认', 'Confirm')}
            </button>
          </section>
        </div>
      ) : null}
      {popup === 'import' ? (
        <div
          className={styles.overlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              back()
            }
          }}
        >
          <section
            className={styles.choice}
            role="dialog"
            aria-modal="true"
            aria-label={t('historyImportConfirmTitle')}
          >
            <header>{t('historyImportConfirmTitle')}</header>
            <div
              className={styles.options}
              role="radiogroup"
              aria-label={t('historyImportConfirmTitle')}
            >
              <button
                type="button"
                role="radio"
                aria-checked={importMode === 'merge'}
                disabled={busy}
                onClick={() => setImportMode('merge')}
              >
                {t('historyImportModeMerge')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={importMode === 'replace'}
                disabled={busy}
                onClick={() => setImportMode('replace')}
              >
                {t('historyImportModeReplace')}
              </button>
            </div>
            <p className={styles.importDescription}>
              {t(
                importMode === 'merge'
                  ? 'historyImportModeMergeDescription'
                  : 'historyImportModeReplaceDescription'
              )}
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.confirm} disabled={busy} onClick={back}>
                {t('cancel')}
              </button>
              <button
                type="button"
                className={styles.confirm}
                disabled={busy}
                data-danger={importMode === 'replace'}
                onClick={() => void confirmAction()}
              >
                {t(
                  importMode === 'merge'
                    ? 'historyImportMergeConfirm'
                    : 'historyImportReplaceConfirm'
                )}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {popup === 'logout' || popup === 'delete' ? (
        <div className={styles.overlay}>
          <section className={styles.choice} role="dialog" aria-modal="true">
            <header>{popup === 'logout' ? logout : clear}</header>
            <p className={styles.message}>
              {popup === 'logout'
                ? tr('确认退出当前 API Key？', 'Sign out of this API Key?')
                : t('deleteAllSessionsModalDescription')}
            </p>
            <div className={styles.confirmActions}>
              <button className={styles.confirm} disabled={busy} onClick={back}>
                {t('cancel')}
              </button>
              <button
                className={styles.confirm}
                disabled={busy}
                data-danger
                onClick={() => void confirmAction()}
              >
                {t('confirm')}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )

  const pages = [page]
  for (let parent = parentPage[page]; parent; parent = parentPage[parent]) {
    pages.unshift(parent)
  }

  return (
    <div ref={pagesRef}>
      {pages.map((screen) => {
        const active = screen === page
        return (
          <section
            key={screen}
            ref={(element) => {
              setInert(element, !active)
            }}
            className={styles.page}
            data-settings-page={screen}
            role="region"
            aria-label={labels[screen]}
            aria-hidden={active ? undefined : true}
          >
            <div className={styles.pageContent}>{renderPage(screen)}</div>
            {active ? popups : null}
          </section>
        )
      })}
    </div>
  )
}
