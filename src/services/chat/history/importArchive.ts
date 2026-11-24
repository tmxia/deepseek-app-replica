import { stagingWriter, type StagingWriter, type StoredFile } from '../db.js'
import type { Session, SessionSummary } from '../types.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry, decoder: TextDecoder): Promise<unknown> => {
  let text = ''
  for await (const chunk of entry.stream) {
    text += decoder.decode(chunk, { stream: true })
  }
  try {
    return JSON.parse(text + decoder.decode())
  } catch {
    return fail('backupInvalidJson')
  }
}

export type ArchiveProgress = { bytes: number; total: number; count: number } | null

export type ImportMode = 'merge' | 'replace'
export type ImportArchiveResult = { summaries: SessionSummary[]; pinnedIds: string[] }

/** 第一次读取就失败时，暂存尚未写入，可以从另一个线程重试。 */
export class ArchiveSourceError extends Error {}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 批量暂存会话和图片；图片全部读完后只读取可能需要回填 MIME 的会话。
 * 合并模式下跳过已在当前库存在的图片写入，仍完成 ZIP 大小与 CRC 校验。
 */
export const importArchive = async (
  file: File,
  importId: string,
  onProgress: (progress: ArchiveProgress) => void,
  mode: ImportMode = 'replace',
  staging: StagingWriter = stagingWriter(importId)
): Promise<ImportArchiveResult> => {
  const recognized = await isZipFile(file).catch((cause: unknown) => {
    throw new ArchiveSourceError('Unable to read the history archive', { cause })
  })
  if (!recognized) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const pinnedIds = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件或当前库已存在的原件：文件 ID → MIME。同一图片出现在多个会话目录时只处理一次。 */
  const stored = new Map<string, string>()
  const activeFileTypes = new Map<string, string | null>()
  const uncheckedImageIds = new Set<string>()
  const sessionsWithFiles: { id: string; size: number }[] = []
  let sessions: Session[] = []
  let files: StoredFile[] = []
  let sessionBytes = 0
  let fileBytes = 0
  let lastProgress = 0
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  const decoder = new TextDecoder()
  let pendingSessions: Promise<{ error: unknown } | undefined> | undefined

  const waitForSessions = async () => {
    const result = await pendingSessions
    pendingSessions = undefined
    if (result) {
      throw result.error
    }
  }

  const flushSessions = async () => {
    await waitForSessions()
    const batch = sessions
    sessions = []
    const bytes = sessionBytes
    sessionBytes = 0
    if (!batch.length) {
      return
    }
    // 只保留一批待写入数据，解析下一批时让存储层完成上一批。
    pendingSessions = staging.addSessions(batch).then(
      () => undefined,
      (error: unknown) => ({ error })
    )
    if (bytes > 8 * 1024 * 1024) {
      await waitForSessions()
    }
  }
  const flushFiles = async () => {
    if (files.length) {
      await staging.addFiles(files)
    }
    files = []
    fileBytes = 0
  }
  const reportRead = (bytes: number, total: number) => {
    const now = performance.now()
    if (lastProgress && now - lastProgress < 200) {
      return
    }
    lastProgress = now
    onProgress({ bytes, total, count: imported.size })
    // 缓存命中时 ZIP 条目之间不一定有浏览器任务边界，留出绘制进度的机会。
    return typeof document === 'undefined'
      ? undefined
      : new Promise<void>((resolve) => setTimeout(resolve, 0))
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    if (mode === 'merge') {
      if (!activeFileTypes.has(id)) {
        uncheckedImageIds.add(id)
        const activeTypes = await staging.getActiveFileTypes([...uncheckedImageIds])
        for (const uncheckedId of uncheckedImageIds) {
          activeFileTypes.set(uncheckedId, activeTypes.get(uncheckedId) ?? null)
        }
        uncheckedImageIds.clear()
      }
      const existingType = activeFileTypes.get(id)
      if (existingType !== null && existingType !== undefined) {
        stored.set(id, existingType)
        await skipEntry(entry)
        return
      }
    }
    const blob = await readEntry(entry, imageType)
    files.push({ id, blob })
    fileBytes += blob.size
    stored.set(id, blob.type)
    if (files.length >= 32 || fileBytes >= 8 * 1024 * 1024) {
      await flushFiles()
    }
  }

  try {
    for await (const entry of readArchive(file, reportRead)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry, decoder))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        if (entry.size > 8 * 1024 * 1024) {
          await flushSessions()
          await waitForSessions()
        }
        const parsed = readSessionFile(await readJson(entry, decoder))
        const local = toLocalSession(parsed)
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        if (parsed.pinned) {
          pinnedIds.add(sessionId)
        }
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
          if (mode === 'merge' && !activeFileTypes.has(id)) {
            uncheckedImageIds.add(id)
          }
        }
        if (
          local.session.messages.some((message) => message.role === 'user' && message.files.length)
        ) {
          sessionsWithFiles.push({ id: sessionId, size: entry.size })
        }
        sessions.push(local.session)
        sessionBytes += entry.size
        if (sessions.length >= 512 || sessionBytes >= 4 * 1024 * 1024) {
          await flushSessions()
        }
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry, decoder))
        for (const item of index) {
          if (item.pinned) {
            pinnedIds.add(item.id)
          }
        }
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    await pendingSessions
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    await pendingSessions
    fail('backupIncomplete')
  }
  onProgress(null)
  await flushSessions()
  await waitForSessions()
  await flushFiles()
  if (stored.size) {
    let ids: string[] = []
    let bytes = 0
    for (const item of sessionsWithFiles) {
      ids.push(item.id)
      bytes += item.size
      if (ids.length >= 64 || bytes >= 4 * 1024 * 1024) {
        await staging.updateFileTypes(ids, stored)
        ids = []
        bytes = 0
      }
    }
    if (ids.length) {
      await staging.updateFileTypes(ids, stored)
    }
  }
  return { summaries: staging.summaries, pinnedIds: [...pinnedIds] }
}
