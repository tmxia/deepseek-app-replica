import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { android } from '../../app/android.js'
import { useTranslate } from '../../i18n/index.js'
import { useUploads } from '../../services/attachments.js'
import { loadFile, reportStorageError } from '../../services/chat/db.js'
import { addDraftFiles } from '../../services/chat/drafts.js'
import { useChatStore } from '../../services/chat/store.js'
import type { FileAttachment } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { IconPhotoErrorFill20, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { AndroidImageViewer } from '../files/AndroidImageViewer.js'
import { FileCard } from '../files/FileCard.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import styles from './MessageFile.module.css'

type FileSource = { blob: Blob; url: string }

/** 读取本地原件并生成预览地址。undefined 表示加载中，null 表示原件不可用。 */
const useFileSource = (id: string) => {
  const [fileSource, setFileSource] = useState<{ id: string; source: FileSource | null }>()
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    void loadFile(id)
      .then((blob) => {
        if (!cancelled) {
          objectUrl = blob ? URL.createObjectURL(blob) : null
          setFileSource({ id, source: blob && objectUrl ? { blob, url: objectUrl } : null })
        }
      })
      .catch((error: unknown) => {
        reportStorageError('read message attachment')(error)
        if (!cancelled) {
          setFileSource({ id, source: null })
        }
      })
    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [id])
  return fileSource?.id === id ? fileSource.source : undefined
}

/** 历史或失效附件的补传状态：只在还没有 serverId 时显示 */
const useUploadState = (file: FileAttachment) =>
  useUploads((state) => {
    if (file.serverId) {
      return null
    }
    const task = state.tasks[file.id]
    return task?.status === 'uploading' || task?.status === 'error' ? task : null
  })

/**
 * 消息里的附件：
 * - 图片：纯图片显示 120×120 缩略图，与文件混排时为 64×64；上传中显示 loading 蒙层，
 *   上传失败显示品牌色描边 + 中心重试图标（可重试）或 photo-error 图标（不可重试）。
 * - 文件：显示文件卡片。
 */
export const MessageFile = ({
  sessionId,
  file,
  onRetry,
}: {
  sessionId: string
  file: FileAttachment
  /** 本条消息补传失败且可重试时提供 */
  onRetry: (() => void) | null
}) => {
  const t = useTranslate()
  const source = useFileSource(file.id)
  const url = source?.url
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const [viewedUrl, setViewedUrl] = useState<string>()
  const upload = useUploadState(file)
  const uploading = upload?.status === 'uploading'
  const failed = upload?.status === 'error'
  const retryable = failed && upload.retryable
  const errorText = failed ? t(upload.error.key, upload.error.params) : undefined

  const retry = retryable ? onRetry : null

  if (file.isImage && source !== null) {
    const preview = url ? (
      failedUrl === url ? (
        <span className={styles.failedIcon} role="img" aria-label={file.name}>
          <IconPhotoErrorFill20 />
        </span>
      ) : (
        <img src={url} alt={file.name} onError={() => setFailedUrl(url)} />
      )
    ) : null

    // 上传中先在蒙层下显示本地原件。
    if (uploading) {
      return (
        <div className={clsx(styles.image, styles.imageThumb)} title={file.name}>
          {preview}
          <div className={styles.overlay}>
            <span className={styles.spinner} />
          </div>
        </div>
      )
    }

    // 「上传失败」只显示状态，其余原因写在图片底部的渐变上
    const reason =
      errorText && errorText !== t('uploadFileStatusFailed') ? (
        <span className={styles.reason}>{errorText}</span>
      ) : null

    // 上传失败不可重试：保留缩略图，底部渐变显示原因
    if (failed && !retry) {
      return (
        <div
          className={clsx(styles.image, styles.imageThumb)}
          title={errorText}
          aria-label={errorText}
        >
          {preview ?? (
            <span className={styles.failedIcon}>
              <IconPhotoErrorFill20 />
            </span>
          )}
          {reason}
        </div>
      )
    }

    // 上传失败可重试：缩略图 + 红色描边 + 蒙层重试图标，原因在底部
    if (failed && retry) {
      const retryLabel = t('uploadRetry', { message: errorText ?? t('uploadFileStatusFailed') })
      return (
        <Tooltip content={retryLabel}>
          <button
            type="button"
            className={clsx(styles.image, styles.imageThumb, styles.retryImage)}
            aria-label={retryLabel}
            onClick={retry}
          >
            {preview}
            <div className={clsx(styles.overlay, styles.retryOverlay)}>
              <IconRefreshOutline16 />
            </div>
            {reason}
          </button>
        </Tooltip>
      )
    }

    if (android && source) {
      if (failedUrl === source.url) {
        return <div className={styles.image}>{preview}</div>
      }
      return (
        <>
          <button
            className={clsx(styles.image, styles.imageThumb)}
            type="button"
            title={file.name}
            onClick={() => setViewedUrl(source.url)}
          >
            {preview}
          </button>
          {viewedUrl === source.url ? (
            <AndroidImageViewer
              blob={source.blob}
              name={file.name}
              source={source.url}
              canDownload
              onClose={() => setViewedUrl(undefined)}
              onConfirm={(cropped) => {
                if (useChatStore.getState().importingHistory || !ensureApiKey(true)) {
                  setViewedUrl(undefined)
                  return null
                }
                const error = addDraftFiles(
                  sessionId,
                  [cropped],
                  useSettings.getState().apiKey ?? ''
                )
                if (!error) {
                  setViewedUrl(undefined)
                  window.dispatchEvent(
                    new CustomEvent('android-focus-composer', { detail: sessionId })
                  )
                }
                return error
              }}
            />
          ) : null}
        </>
      )
    }

    // 桌面端仍用新标签打开原件。
    return url ? (
      <a
        className={clsx(styles.image, styles.imageThumb)}
        href={url}
        target="_blank"
        rel="noreferrer"
        title={file.name}
      >
        {preview}
      </a>
    ) : (
      // 原件还没加载出来（极短暂）
      <div className={styles.image} />
    )
  }

  return (
    <FileCard
      name={file.name}
      size={file.size}
      status={uploading ? 'uploading' : failed ? 'error' : 'done'}
      error={errorText}
      onRetry={retry ?? undefined}
      onOpen={
        !android && url && !upload ? () => window.open(url, '_blank', 'noreferrer') : undefined
      }
    />
  )
}
