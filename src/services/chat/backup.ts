import { formatDate } from '../../utils/format.js'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import { useSettings } from '../settings.js'
import * as db from './db.js'
import type { ArchiveProgress, ImportMode } from './history/importArchive.js'
import { mergeHistory, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'
export type { ImportMode } from './history/importArchive.js'

export type ImportHistoryResult =
  | { mode: 'replace'; count: number }
  | { mode: 'merge'; added: number; merged: number; unchanged: number }

type ExportHistoryResult = { name: string; blob: Blob; skipped: number; unreadableImages: number }

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。个别会话在主库中缺失时跳过，由 skipped 带回数量。 */
export const exportHistory = (): Promise<ExportHistoryResult> =>
  enqueueBackup(async () => {
    // 列表、置顶和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    const pinnedIds = new Set(useSettings.getState().pinnedSessions)
    let skipped = 0
    let unreadableImages = 0
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id).catch((error: unknown) => {
              db.reportStorageError('read session for export')(error)
              return undefined
            })
        if (!session) {
          skipped += 1
          continue
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), pinnedIds, () => {
      unreadableImages += 1
    })
    return { name: backupFileName(now), blob, skipped, unreadableImages }
  })

export const formatExportWarning = ({
  skipped,
  unreadableImages,
}: ExportHistoryResult): TranslationMessage | undefined => {
  if (unreadableImages) {
    return skipped
      ? {
          key: 'historyExportSkippedWithImages',
          params: { count: skipped, images: unreadableImages },
        }
      : { key: 'historyExportUnreadableImages', params: { images: unreadableImages } }
  }
  if (skipped) {
    return { key: 'historyExportSkipped', params: { count: skipped } }
  }
  return undefined
}

/** 确认导入后调用：支持合并（默认）或覆盖。先校验 ZIP 并写入暂存，通过后再提交。 */
export const importHistory = (
  file: File,
  onProgress?: (status: TranslationMessage) => void,
  mode: ImportMode = 'merge'
): Promise<ImportHistoryResult> =>
  enqueueBackup(async () => {
    onProgress?.({ key: 'historyImporting' })
    const { importOffMainThread } = await import('./history/importOffMainThread.js')
    const started = performance.now()
    const trackProgress = (progress: ArchiveProgress) => {
      if (!onProgress) {
        return
      }
      if (!progress) {
        onProgress({ key: 'historyImportFinishing' })
        return
      }
      const { bytes, total, count } = progress
      const fraction = total > 0 ? bytes / total : 0
      const percent = Math.min(99, Math.floor(fraction * 100))
      const elapsed = performance.now() - started
      const params = { percent, count }
      if (elapsed < 4000 || fraction < 0.03 || fraction >= 1) {
        onProgress({ key: 'historyImportProgress', params })
        return
      }
      const seconds = Math.ceil((elapsed * (1 - fraction)) / fraction / 1000)
      const eta =
        seconds < 60
          ? translate('historyImportEtaSeconds', { seconds })
          : translate('historyImportEtaMinutes', { minutes: Math.ceil(seconds / 60) })
      onProgress({ key: 'historyImportProgressEta', params: { ...params, eta } })
    }

    if (mode === 'merge') {
      const summary = await mergeHistory(
        (importId) => importOffMainThread(file, importId, trackProgress, 'merge'),
        { onCommit: () => onProgress?.({ key: 'historyImportMerging' }), clearInBackground: true }
      )
      return { mode: 'merge', ...summary }
    }

    const count = await replaceHistory(
      (importId) => importOffMainThread(file, importId, trackProgress, 'replace'),
      { onCommit: () => onProgress?.({ key: 'historyImportReplacing' }), clearInBackground: true }
    )
    return { mode: 'replace', count }
  })

export const formatImportResult = (result: ImportHistoryResult): TranslationMessage => {
  if (result.mode === 'replace') {
    return {
      key: result.count === 1 ? 'historyImportedOne' : 'historyImported',
      params: { count: result.count },
    }
  }
  const { added, merged, unchanged } = result
  if (added === 0 && merged === 0) {
    return unchanged === 0
      ? { key: 'historyMergedEmpty' }
      : { key: 'historyMergedNoChange', params: { unchanged } }
  }
  if (merged === 0 && unchanged === 0) {
    return added === 1
      ? { key: 'historyMergedAddedOne' }
      : { key: 'historyMergedAddedOnly', params: { added } }
  }
  if (added === 0 && unchanged === 0) {
    return merged === 1
      ? { key: 'historyMergedUpdatedOne' }
      : { key: 'historyMergedUpdatedOnly', params: { merged } }
  }
  return { key: 'historyMergedSummary', params: { added, merged, unchanged } }
}

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => ({ summaries: [], pinnedIds: [] }))
  })
