import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { android } from './android.js'
import { useAndroidBackInterception } from './useAndroidBackInterception.js'
import { useTranslate } from '../i18n/index.js'
import { useSettings } from '../services/settings.js'
import {
  isAndroidWide,
  useIsAndroidWide,
  useIsMobile,
  useMobileViewport,
  usePreventPageScroll,
} from './viewport.js'
import {
  bindChatPersistence,
  initChat,
  retrySaveSessions,
  selectSession,
  useChatStore,
} from '../services/chat/store.js'
import { SearchPanel } from '../components/search/SearchPanel.js'
import { closeSearchPanel, useSearchPanel } from '../components/search/searchPanelState.js'
import { SessionView } from '../components/session/SessionView.js'
import { MobileHeader } from '../components/session/MobileHeader.js'
import { Welcome } from '../components/session/Welcome.js'
import { ensureApiKey, useSettingsDialog } from '../components/settings/settingsDialogState.js'
import { SettingsDialog } from '../components/settings/SettingsDialog.js'
import { AndroidSettings } from '../components/settings/AndroidSettings.js'
import { ApiKeyScreen } from '../components/settings/ApiKeyScreen.js'
import { Toast } from '../components/base/Toast.js'
import { showToast } from '../components/base/toastState.js'
import { onUploadNotice } from '../services/attachments.js'
import { Button } from '../components/base/Button.js'
import { stopReadAloud } from '../services/speech/readAloud.js'
import { setInert } from '../utils/inert.js'
import { CollapsedSider } from '../components/sider/CollapsedSider.js'
import {
  closeDrawerSearch,
  closeMobileSider,
  openMobileSider,
  useMobileSider,
} from '../components/sider/mobileSiderState.js'
import { MobileSider, Sider } from '../components/sider/Sider.js'
import { useAndroidDrawerGesture } from '../components/sider/useAndroidDrawerGesture.js'
import styles from './App.module.css'

const SIDE_DRAWER_WIDTH = 326
const SIDE_DRAWER_MS = 220
const SIDE_DRAWER_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

const readTranslateX = (element: HTMLElement) => {
  const value = getComputedStyle(element).transform
  if (!value || value === 'none') {
    return 0
  }
  const match = value.match(/^matrix\(([^)]+)\)$/)
  if (match) {
    return Number(match[1].split(',')[4]) || 0
  }
  const match3d = value.match(/^matrix3d\(([^)]+)\)$/)
  if (match3d) {
    return Number(match3d[1].split(',')[12]) || 0
  }
  return 0
}

const ChatContent = memo(function ChatContent({
  isMobile,
  siderCollapsed,
}: {
  isMobile: boolean
  siderCollapsed: boolean
}) {
  const t = useTranslate()
  const ready = useChatStore((state) => state.ready)
  const initError = useChatStore((state) => state.initError)
  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const sessionLoadError = useChatStore((state) =>
    state.activeId === null ? false : state.sessionLoadErrors[state.activeId] === true
  )
  const streaming = useChatStore((state) =>
    state.activeId === null ? false : Object.hasOwn(state.streaming, state.activeId)
  )

  const [showLoadingText, setShowLoadingText] = useState(false)
  useEffect(() => {
    setShowLoadingText(false)
    if (ready) {
      return
    }
    const timer = window.setTimeout(() => setShowLoadingText(true), 150)
    return () => window.clearTimeout(timer)
  }, [ready, activeId, session])

  if (!ready || (activeId !== null && !session)) {
    const loadFailed = !ready ? initError : sessionLoadError
    return (
      <div className={styles.loadingView}>
        {isMobile ? <MobileHeader /> : null}
        <div className={styles.loadingState} role="status" aria-live="polite">
          {loadFailed || showLoadingText ? (
            <span className={loadFailed ? undefined : styles.loadingText}>
              {t(
                loadFailed
                  ? !ready
                    ? 'sessionListLoadFailed'
                    : 'sessionLoadFailed'
                  : 'sessionLoading'
              )}
            </span>
          ) : null}
          {loadFailed ? (
            <Button
              variant="outlined"
              size="m"
              onClick={() => {
                if (!ready) {
                  void initChat()
                } else if (activeId !== null) {
                  selectSession(activeId)
                }
              }}
            >
              {t('retry')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  return session ? (
    <SessionView session={session} streaming={streaming} siderCollapsed={siderCollapsed} />
  ) : (
    <Welcome />
  )
})

export const App = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const androidWide = useIsAndroidWide()
  const configured = useSettings((state) => Boolean(state.apiKey || state.chatConfig.endpoint))
  const needsApiKey = Boolean(android && !configured)
  const drawerOpen = useMobileSider((state) => state.open)
  const searchOpen = useMobileSider((state) => state.searchOpen)
  const modalDrawerOpen = drawerOpen && !androidWide
  const mainRef = useRef<HTMLElement>(null)
  const prevAndroidWideRef = useRef(androidWide)
  const prevWideForAnimRef = useRef(androidWide)
  const prevDrawerOpenRef = useRef(drawerOpen)
  const sideAnimationsRef = useRef(new Map<HTMLElement, Animation>())
  const locale = useSettings((state) => state.locale)
  const fontSize = useSettings((state) => state.fontSize)
  // 移动端侧边栏以独立抽屉管理开合状态
  const siderCollapsed = useSettings((state) => state.siderCollapsed) && !isMobile
  const saveErrors = useChatStore((state) => state.sessionSaveErrors)
  const saveError = Object.values(saveErrors).some(Boolean)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const frameRef = useMobileViewport(isMobile && !android && !needsApiKey)
  const drawerGesture = useAndroidDrawerGesture(
    frameRef,
    Boolean(android && !androidWide && !needsApiKey)
  )
  const activeId = useChatStore((state) => state.activeId)

  useAndroidBackInterception(modalDrawerOpen || (drawerOpen && searchOpen))
  usePreventPageScroll(isMobile && !android)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    if (android) {
      const size = fontSize === null ? android.systemFontScale() : 1 + (fontSize - 2) * 0.1
      document.documentElement.style.setProperty('--android-chat-font-scale', String(size))
    }
  }, [fontSize])

  useEffect(() => {
    setInert(mainRef.current, Boolean(android && modalDrawerOpen))
  }, [modalDrawerOpen])

  // Android 平板端可能上报 hover: hover，仅在真实鼠标移动时启用悬停样式，触控/手写笔点击不残留高亮。
  useEffect(() => {
    if (!android) {
      return
    }
    const root = document.documentElement
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') {
        root.setAttribute('data-android-hover', '')
      }
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') {
        root.removeAttribute('data-android-hover')
      }
    }
    const onTouchStart = () => {
      root.removeAttribute('data-android-hover')
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true, capture: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    return () => {
      root.removeAttribute('data-android-hover')
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('touchstart', onTouchStart, true)
    }
  }, [])

  // 宽屏侧栏开合使用纯 GPU FLIP 平移动画，避免 transition padding/margin 逐帧重排与连点卡顿。
  useLayoutEffect(() => {
    const prevWide = prevWideForAnimRef.current
    const prevOpen = prevDrawerOpenRef.current
    prevWideForAnimRef.current = androidWide
    prevDrawerOpenRef.current = drawerOpen
    const animations = sideAnimationsRef.current
    if (!android || !androidWide) {
      animations.forEach((animation) => animation.cancel())
      animations.clear()
      return
    }
    if (!prevWide || prevOpen === drawerOpen) {
      return
    }
    const main = mainRef.current
    if (!main || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    const targets = Array.from(main.querySelectorAll<HTMLElement>('[data-side-shift]'))
    const starts = targets.map((element) => {
      const currentX = animations.has(element) ? readTranslateX(element) : 0
      const shift = element.dataset.sideShift === 'edge' ? SIDE_DRAWER_WIDTH : SIDE_DRAWER_WIDTH / 2
      return currentX + (drawerOpen ? -shift : shift)
    })
    targets.forEach((element, index) => {
      animations.get(element)?.cancel()
      if (typeof element.animate !== 'function') {
        return
      }
      const animation = element.animate(
        [{ transform: `translateX(${starts[index]}px)` }, { transform: 'translateX(0)' }],
        { duration: SIDE_DRAWER_MS, easing: SIDE_DRAWER_EASING }
      )
      animations.set(element, animation)
      const clear = () => {
        if (animations.get(element) === animation) {
          animations.delete(element)
        }
      }
      animation.onfinish = clear
      animation.oncancel = clear
    })
  }, [androidWide, drawerOpen])

  useEffect(() => {
    const animations = sideAnimationsRef.current
    return () => {
      animations.forEach((animation) => animation.cancel())
      animations.clear()
    }
  }, [])

  // 文件数、存储空间达到上限时，附件上只显示「上传失败」，原因用 toast 说明
  useEffect(() => onUploadNotice(showToast), [])

  const storageAlert = useChatStore((state) => state.storageAlert)
  useEffect(() => {
    if (storageAlert === null) {
      return
    }
    showToast(storageAlert, 6000)
    useChatStore.setState({ storageAlert: null })
  }, [storageAlert])
  useEffect(bindChatPersistence, [])

  // 搜索结果面板只属于当前会话
  useEffect(closeSearchPanel, [activeId])
  // 切换会话时停止朗读
  useEffect(stopReadAloud, [activeId])
  // Web 窄屏切换布局时收起抽屉；Android 跨 840dp 断点时与官方一致（窄→宽展开，宽→窄收起）
  useEffect(() => {
    if (!android) {
      if (isMobile) {
        closeMobileSider()
      }
      return
    }
    if (prevAndroidWideRef.current === androidWide) {
      return
    }
    prevAndroidWideRef.current = androidWide
    if (androidWide) {
      openMobileSider()
    } else {
      closeMobileSider()
    }
  }, [androidWide, isMobile])

  useEffect(() => {
    void initChat()
    // 首次打开先在设置里输入 API Key
    if (!android) {
      ensureApiKey()
    }
  }, [])

  useEffect(() => {
    if (!android) {
      return
    }
    const onBack = (event: Event) => {
      if (useSettingsDialog.getState().open) {
        return
      }
      if (document.querySelector('[role="dialog"]')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
      } else if (useSearchPanel.getState().entry) {
        closeSearchPanel()
      } else if (useMobileSider.getState().open && useMobileSider.getState().searchOpen) {
        closeDrawerSearch()
      } else if (!isAndroidWide() && useMobileSider.getState().open) {
        closeMobileSider()
      } else {
        return
      }
      event.preventDefault()
    }
    window.addEventListener('android-back', onBack)
    return () => window.removeEventListener('android-back', onBack)
  }, [])

  if (needsApiKey) {
    return <ApiKeyScreen />
  }

  return (
    <>
      <div
        ref={frameRef}
        className={styles.frame}
        data-drawer-open={drawerOpen}
        data-drawer-search={android && searchOpen ? 'true' : undefined}
        data-drawer-layout={android ? (androidWide ? 'side' : 'modal') : undefined}
        {...(android && !androidWide ? drawerGesture : {})}
      >
        {isMobile ? <MobileSider /> : siderCollapsed ? null : <Sider />}
        <main ref={mainRef} className={styles.main}>
          {saveError ? (
            <div className={styles.saveError} role="alert">
              <span>{t('sessionSaveFailed')}</span>
              <Button
                variant="outlined"
                size="s"
                disabled={importingHistory}
                onClick={retrySaveSessions}
              >
                {t('retry')}
              </Button>
            </div>
          ) : null}
          <div className={styles.content}>
            {siderCollapsed ? <CollapsedSider /> : null}
            <ChatContent isMobile={isMobile} siderCollapsed={siderCollapsed} />
          </div>
        </main>
        <SearchPanel />
      </div>
      {android ? <AndroidSettings chatFrame={frameRef} /> : <SettingsDialog />}
      <Toast />
    </>
  )
}
