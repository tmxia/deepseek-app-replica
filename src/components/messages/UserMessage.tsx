import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconCopyOutline16, IconEditOutline16, IconSelectTextOutline16 } from '../base/icons.js'
import { startMessageEdit } from '../../services/chat/drafts.js'
import { editMessage, retryUpload } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { copyText } from '../../utils/clipboard.js'
import { AndroidTextSelection } from './AndroidTextSelection.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  editingTarget = false,
  searchHighlightNonce = null,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  editingTarget?: boolean
  searchHighlightNonce?: number | null
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [collapsed, setCollapsed] = useState(true)
  const [needsFold, setNeedsFold] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const bubbleTextRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const isMobile = useIsMobile()
  const canSend = !busy && (draft.trim() !== '' || message.files.length > 0)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  useLayoutEffect(() => {
    const el = bubbleTextRef.current
    if (!el || editing) {
      return
    }
    let cancelled = false
    const measure = () => {
      if (cancelled || !bubbleTextRef.current) {
        return
      }
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24
      setNeedsFold(el.scrollHeight > lineHeight * 4 + lineHeight * 0.5)
    }
    measure()
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    }
    if (document.fonts && typeof document.fonts.ready !== 'undefined') {
      void document.fonts.ready.then(() => {
        if (!cancelled) {
          measure()
        }
      })
    }
    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [message.content, editing])

  const sendEdit = () => {
    if (canSend && ensureApiKey() && editMessage(sessionId, message.id, draft.trim())) {
      stopReadAloud()
      setEditing(false)
    }
  }

  const startEdit = () => {
    if (busy) {
      return
    }
    setSelecting(false)
    if (android) {
      startMessageEdit(sessionId, message)
      window.dispatchEvent(new CustomEvent('android-focus-composer', { detail: sessionId }))
      return
    }
    setDraft(message.content)
    setEditing(true)
  }

  const stopSelecting = useCallback(() => {
    setSelecting(false)
  }, [])

  const startSelecting = () => {
    setSelecting(true)
  }

  const copyMessage = () => {
    void copyText(message.content).then((copied) =>
      showToast({ key: copied ? 'copied' : 'copyFailed' }, copied ? 1990 : undefined)
    )
  }

  return (
    <div
      className={clsx(
        styles.container,
        isFirst && styles.isFirst,
        searchHighlightNonce !== null && styles.searchHighlighted
      )}
      data-message-id={message.id}
      data-editing-target={editingTarget ? 'true' : undefined}
    >
      {searchHighlightNonce !== null ? (
        <div key={searchHighlightNonce} className={styles.searchHighlight} aria-hidden="true" />
      ) : null}
      {message.files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            message.files.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {message.files.map((file) => (
            <MessageFile
              key={file.id}
              sessionId={sessionId}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
            />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            enterKeyHint={android || isMobile ? 'enter' : undefined}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.ctrlKey &&
                !android &&
                !isMobile
              ) {
                event.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? (
            <div
              ref={bubbleRef}
              className={clsx(
                styles.bubble,
                needsFold && collapsed && styles.bubbleCollapsed
              )}
              data-editing-bubble={editingTarget ? 'true' : undefined}
              role={android ? 'button' : undefined}
              tabIndex={android ? 0 : undefined}
              aria-disabled={android && busy ? true : undefined}
              onClick={android ? (selecting ? stopSelecting : startEdit) : undefined}
              onKeyDown={(event) => {
                if (android && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault()
                  startEdit()
                }
              }}
              onContextMenu={(event) => {
                if (android) {
                  event.preventDefault()
                  stopSelecting()
                  menuTriggerRef.current?.click()
                }
              }}
            >
              <div
                ref={bubbleTextRef}
                className={styles.bubbleText}
              >
                {message.content}
              </div>
              {needsFold ? (
                <button
                  type="button"
                  className={styles.foldToggle}
                  onClick={(event) => {
                    event.stopPropagation()
                    setCollapsed((show) => !show)
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {collapsed ? t('expandBlock') : t('collapseBlock')}
                </button>
              ) : null}
              {android ? (
                <>
                  <AndroidTextSelection
                    active={selecting}
                    containerRef={bubbleRef}
                    contentRef={bubbleTextRef}
                    initialMode="all"
                    onExit={stopSelecting}
                  />
                  <Menu
                    variant="userMessage"
                    anchorClassName={styles.menuAnchor}
                    options={[
                      {
                        key: 'copy',
                        label: t('copy'),
                        icon: (
                          <span className={styles.menuCopyIcon}>
                            <IconCopyOutline16 />
                          </span>
                        ),
                        onSelect: copyMessage,
                      },
                      {
                        key: 'selectText',
                        label: t('androidSelectText'),
                        icon: <IconSelectTextOutline16 />,
                        onSelect: startSelecting,
                      },
                      {
                        key: 'edit',
                        label: t('androidEditMessage'),
                        icon: <IconEditOutline16 />,
                        onSelect: startEdit,
                      },
                    ]}
                  >
                    {({ toggle }) => (
                      <button
                        ref={menuTriggerRef}
                        className={styles.menuTrigger}
                        type="button"
                        aria-hidden="true"
                        tabIndex={-1}
                        onClick={(event) => {
                          event.stopPropagation()
                          toggle()
                        }}
                      />
                    )}
                  </Menu>
                </>
              ) : null}
            </div>
          ) : null}
          {!android || versions.ids.length > 1 ? (
            <div className={styles.bottom}>
              {!android ? (
                <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
                  {message.content ? <CopyButton text={message.content} /> : null}
                  <IconButton
                    icon={<IconEditOutline16 />}
                    tooltip={t('editMessage')}
                    tooltipPlacement="bottom"
                    disabled={busy}
                    onClick={startEdit}
                  />
                </div>
              ) : null}
              <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
})
