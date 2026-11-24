import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { DEFAULT_CHAT_MODEL } from '../api/chatConfig.js'
import { ApiError, streamChatMessage } from '../api/client.js'
import type { CreateMessageRequest, MessageParam } from '../api/types.js'
import {
  extractFileIds,
  getFileErrorCode,
  getRejectedImagePosition,
  isContextOverflow,
  isRetryableApiError,
} from '../api/errors.js'
import {
  cancelUpload,
  describeUploadError,
  uploadAttachment,
  useUploads,
  type AttachmentUpload,
} from '../attachments.js'
import { MANY_IMAGES_COUNT, MANY_IMAGES_MAX_EDGE, MAX_IMAGE_EDGE } from '../imageUpload.js'
import { setPinnedSessions, useSettings } from '../settings.js'
import {
  activateBranch,
  appendBranch,
  getVisibleMessages,
  normalizeSession,
  selectVersion,
} from './branches.js'
import type { ImportArchiveResult } from './history/importArchive.js'
import {
  contextBudget,
  estimateBranchScale,
  estimatePrefixTokens,
  estimateQuestionTokens,
  prepareHistoryContext,
  resolveMaxOutputTokens,
  saveContextCheckpoint,
  WINDOW_TOKENS,
  type HistoryContext,
} from './context.js'
import {
  createContextSummarizer,
  includeContextSummary,
  summarizeCurrentInput,
} from './contextSummary.js'
import { prepareCustomAttachments } from './customAttachments.js'
import * as db from './db.js'
import type { MigrationNotice } from './androidStorage.js'
import {
  cancelMessageEdit,
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  clearSentEdit,
  getDraft,
  prepareDraftMessage,
  type DraftFilePayload,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** DeepSeek Flash 和 Pro 的官方最大输出预算（384K，含思考）。 */
const MAX_OUTPUT_TOKENS = 393_216
/** 长上下文下的最小输出保底（5% 窗口），与 5% 安全缓冲配合对齐 90% 触发线。 */
const MIN_OUTPUT_RESERVE = 52_428
const PROMPT_OVERHEAD_TOKENS = 256
const CUSTOM_OUTPUT_TOKENS = 4_096
const CUSTOM_CONTEXT_WINDOW = 128 * 1024
/** 所有生成请求统一携带的助手身份说明 */
const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 官方对纯算术首条保留原文标题，不进入服务端摘要通道。 */
const SIMPLE_ARITHMETIC =
  /^\s*\d+(?:\.\d+)?(?:\s*[+\-*/×÷]\s*\d+(?:\.\d+)?)+(?:\s*(?:=|等于|\?|？))?\s*$/
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 首次请求开启高级内容审核。 */
const SAFETY_CHECK = { level: 'high' } as const
/** 同一轮请求因 file_id 失效而重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000
/** 限制一次聊天轮次内自动压缩的历史请求数，已成功的批次留给下轮接着处理。 */
const HISTORY_SUMMARY_LIMIT = 6
const HISTORY_OVERFLOW_RETRIES = 3

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean) => {
  const tools: NonNullable<CreateMessageRequest['tools']> = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

export type PendingMessageJump = {
  sessionId: string
  messageId: string
  nonce: number
}

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 搜索点击某条消息后待消费的定位目标；进入对应会话并完成滚动定位后清除 */
  pendingJump: PendingMessageJump | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  storageAlert: TranslationMessage | null
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  pendingJump: null,
  streaming: {},
  storageAlert: null,
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const loadOriginalFile = async (sessionId: string, id: string) =>
  pendingFiles.get(sessionId)?.find((file) => file.id === id)?.blob ?? db.loadFile(id)
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let jumpSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, chatConfig } = useSettings.getState()
  const customEndpoint = Boolean(chatConfig.endpoint)
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: chatConfig.model || DEFAULT_CHAT_MODEL,
    thinking: !customEndpoint && thinking,
    search: !customEndpoint && search,
    prefix: !customEndpoint && chatConfig.format === 'messages',
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('chat-storage-reset', () => {
    set({ storageAlert: { key: 'storageResetDuringUse' } })
  })
  window.addEventListener('chat-storage-migrated', (event) => {
    const { recovered, missing, unverified } = (event as CustomEvent<MigrationNotice>).detail
    set({
      storageAlert:
        missing || unverified
          ? { key: 'storageMigrationIncomplete', params: { missing, unverified } }
          : { key: 'storageMigrationRecovered', params: { count: recovered } },
    })
  })
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const synced = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      const pendingJump = get().pendingJump
      const session =
        pendingJump?.sessionId === id && !getStreamController(id)
          ? activateBranch(synced, pendingJump.messageId)
          : synced
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

let replacingHistory = false

const dedupePinned = (ids: Iterable<string>, validIds: ReadonlySet<string>): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const id of ids) {
    if (validIds.has(id) && !seen.has(id)) {
      seen.add(id)
      result.push(id)
    }
  }
  return result
}

export type MergeHistorySummary = {
  added: number
  merged: number
  unchanged: number
}

/** 先写入暂存。校验通过后暂停会话修改、停止生成，再原子替换历史。 */
export const replaceHistory = async (
  write: (importId: string) => Promise<ImportArchiveResult>,
  {
    onCommit,
    clearInBackground = false,
  }: { onCommit?: () => void; clearInBackground?: boolean } = {}
): Promise<number> => {
  if (replacingHistory) {
    throw new Error('History replacement is already in progress')
  }
  replacingHistory = true
  let staging: db.HistoryStaging | undefined
  try {
    staging = await db.beginStaging()
    const { summaries, pinnedIds } = await write(staging.importId)
    onCommit?.()
    set({ importingHistory: true })
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await staging.commit(clearInBackground)
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    const validIds = new Set(summaries.map((item) => item.id))
    setPinnedSessions(dedupePinned(pinnedIds, validIds))
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
      pendingJump: null,
    })
    return summaries.length
  } catch (error) {
    await staging?.discard().catch(db.reportStorageError('clear unfinished history replacement'))
    throw error
  } finally {
    replacingHistory = false
    if (get().importingHistory) {
      set({ importingHistory: false })
      retrySaveSessions()
      const { activeId, ready } = get()
      // 提交失败时恢复被取消的详情读取。
      if (activeId !== null) {
        void ensureSessionLoaded(activeId)
      } else if (!ready) {
        void initChat()
      }
    }
  }
}

/** 先写入暂存。校验通过后暂停写入与生成，对重叠会话按树与消息语义合并提交，不清空草稿或重置当前会话。 */
export const mergeHistory = async (
  write: (importId: string) => Promise<ImportArchiveResult>,
  {
    onCommit,
    clearInBackground = true,
  }: { onCommit?: () => void; clearInBackground?: boolean } = {}
): Promise<MergeHistorySummary> => {
  if (replacingHistory) {
    throw new Error('History replacement is already in progress')
  }
  replacingHistory = true
  let staging: db.HistoryStaging | undefined
  try {
    staging = await db.beginStaging()
    const { pinnedIds } = await write(staging.importId)
    onCommit?.()
    set({ importingHistory: true })
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()

    const localOverrides = new Map<string, { session: Session; files?: db.StoredFile[] }>()
    for (const id of unsavedSessions) {
      const session = getSession(id)
      if (session) {
        localOverrides.set(id, { session, files: pendingFiles.get(id) })
      }
    }

    const result = await staging.commitMerge({ localOverrides, clearInBackground })
    const { activeId, sessionCache, sessionLoadErrors, sessionSaveErrors } = get()
    const refreshedCache = { ...sessionCache }
    const updatedSet = new Set(result.updatedIds)

    for (const id of result.updatedIds) {
      unsavedSessions.delete(id)
      pendingFiles.delete(id)
      if (Object.hasOwn(refreshedCache, id) || id === activeId) {
        const refreshed = await db.loadSession(id)
        if (refreshed) {
          touchSession(id)
          refreshedCache[id] = refreshed
        }
      }
    }

    const validIds = new Set(result.summaries.map((item) => item.id))
    setPinnedSessions(
      dedupePinned([...useSettings.getState().pinnedSessions, ...pinnedIds], validIds)
    )
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(result.summaries),
      sessionCache: refreshedCache,
      sessionLoadErrors: Object.fromEntries(
        Object.entries(sessionLoadErrors).filter(([id]) => !updatedSet.has(id))
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(sessionSaveErrors).filter(([id]) => !updatedSet.has(id))
      ),
    })
    trimSessionCache()
    return { added: result.added, merged: result.merged, unchanged: result.unchanged }
  } catch (error) {
    await staging?.discard().catch(db.reportStorageError('clear unfinished history merge'))
    throw error
  } finally {
    replacingHistory = false
    if (get().importingHistory) {
      set({ importingHistory: false })
      retrySaveSessions()
      const { activeId, ready } = get()
      if (activeId !== null) {
        void ensureSessionLoaded(activeId)
      } else if (!ready) {
        void initChat()
      }
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    cancelMessageEdit()
    set({ activeId: null, pendingJump: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    cancelMessageEdit()
    touchSession(id)
    set({ activeId: id, pendingJump: null })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 从搜索结果跳转到指定会话的指定消息：若目标消息在非当前分支，自动激活通往该消息的分支路径。 */
export const selectSessionMessage = (sessionId: string, messageId: string) => {
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    !get().sessions.some((session) => session.id === sessionId)
  ) {
    return
  }
  cancelMessageEdit()
  touchSession(sessionId)
  const nonce = ++jumpSequence
  const cached = getSession(sessionId)
  if (cached && !getStreamController(sessionId)) {
    const activated = activateBranch(cached, messageId)
    if (activated !== cached) {
      set((state) => ({
        activeId: sessionId,
        pendingJump: { sessionId, messageId, nonce },
        sessionCache: { ...state.sessionCache, [sessionId]: activated },
      }))
      persist(sessionId)
      trimSessionCache()
      return
    }
  }
  set({ activeId: sessionId, pendingJump: { sessionId, messageId, nonce } })
  void ensureSessionLoaded(sessionId)
  trimSessionCache()
}

export const clearPendingJump = (nonce?: number) => {
  set((state) =>
    state.pendingJump && (nonce === undefined || state.pendingJump.nonce === nonce)
      ? { pendingJump: null }
      : state
  )
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
      pendingJump: state.pendingJump?.sessionId === id ? null : state.pendingJump,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

const stripFileBlobs = (files: readonly DraftFilePayload[]): FileAttachment[] =>
  files.map(({ id, serverId, serverImage, name, size, isImage, mimeType }) => ({
    id,
    serverId,
    serverImage,
    name,
    size,
    isImage,
    mimeType,
  }))

const appendPendingFiles = (sessionId: string, files: readonly DraftFilePayload[]) => {
  const added = files.flatMap((file) => (file.blob ? [{ id: file.id, blob: file.blob }] : []))
  if (added.length > 0) {
    pendingFiles.set(sessionId, [...(pendingFiles.get(sessionId) ?? []), ...added])
  }
}

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const customEndpoint = Boolean(useSettings.getState().chatConfig.endpoint)
  const prepared = prepareDraftMessage(
    getDraft(targetSessionId),
    useUploads.getState().tasks,
    customEndpoint
  )
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: stripFileBlobs(files),
    createdAt: now,
  }
  const reply = createReply()
  cancelMessageEdit()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    title: session.title || (files.length === 0 && SIMPLE_ARITHMETIC.test(text) ? text.trim() : ''),
    updatedAt: now,
  }))
  appendPendingFiles(sessionId, files)
  persist(sessionId)
  clearSentDraft(targetSessionId, customEndpoint)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  cancelMessageEdit()
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本；未显式传入文件列表时保留原消息附件。 */
export const editMessage = (
  sessionId: string,
  messageId: string,
  content: string,
  nextFiles?: DraftFilePayload[]
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  if (previous?.role !== 'user') {
    return false
  }
  const text = content.trim()
  const files = nextFiles ?? previous.files
  if (!text && files.length === 0) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: stripFileBlobs(files),
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  appendPendingFiles(sessionId, files)
  persist(sessionId)
  clearSentEdit(sessionId, messageId, Boolean(useSettings.getState().chatConfig.endpoint))
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  cancelMessageEdit()
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  const { chatConfig } = useSettings.getState()
  if (
    get().importingHistory ||
    deletingSessions.has(sessionId) ||
    chatConfig.endpoint ||
    chatConfig.format !== 'messages'
  ) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? (chatConfig.model || DEFAULT_CHAT_MODEL),
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveUploadedFiles = (sessionId: string, uploads: Map<string, AttachmentUpload>) => {
  if (uploads.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => uploads.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const result = uploads.get(file.id)
              return result ? { ...file, ...result } : file
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (
  apiKey: string,
  file: FileAttachment
): Promise<AttachmentUpload | null> => {
  if (file.serverId) {
    return { serverId: file.serverId, serverImage: file.serverImage }
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return { serverId: task.serverId, serverImage: task.serverImage }
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const resultsById = new Map<string, AttachmentUpload>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const result = await ensureServerId(apiKey, file)
      if (result) {
        resultsById.set(file.id, result)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveUploadedFiles(sessionId, resultsById)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !resultsById.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const result = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (result) {
        saveUploadedFiles(sessionId, new Map([[file.id, result]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  const prepared = refreshRequest(sessionId, request)
  const images = getRequestImages(prepared)
  if (images.length < MANY_IMAGES_COUNT) {
    return prepared
  }

  // API 根据请求里的图片总数降低尺寸限制，历史轮次也计入。
  const oversized = new Map(
    images
      .filter((file) => (file.serverImage?.maxEdge ?? 0) > MANY_IMAGES_MAX_EDGE)
      .map((file) => [file.id, file])
  )
  const constrained = Promise.allSettled(
    [...oversized.values()].map(async (file) => {
      const result = await uploadRequestImage(sessionId, apiKey, file, MANY_IMAGES_MAX_EDGE, signal)
      if (result && epoch === historyEpoch) {
        saveUploadedFiles(sessionId, new Map([[file.id, result]]))
      }
    })
  )
  const constrainedResults = await Promise.race([constrained, aborted])
  const constraintFailure = constrainedResults.find((result) => result.status === 'rejected')
  if (constraintFailure) {
    throw constraintFailure.reason
  }
  return refreshRequest(sessionId, prepared)
}

const getRequestImages = (request: Request) =>
  [request.question, ...getContextRounds(request.history).map(([user]) => user)].flatMap(
    ({ files }) => files.filter((file) => file.isImage && file.serverId)
  )

const uploadRequestImage = async (
  sessionId: string,
  apiKey: string,
  file: FileAttachment,
  maxEdge: number,
  signal: AbortSignal
) => {
  const task = useUploads.getState().tasks[file.id]
  if (
    task?.status === 'done' &&
    task.serverId !== file.serverId &&
    task.serverImage?.converted &&
    task.serverImage.maxEdge <= maxEdge
  ) {
    return { serverId: task.serverId, serverImage: task.serverImage }
  }
  const blob = await loadOriginalFile(sessionId, file.id)
  signal.throwIfAborted()
  if (!blob) {
    return null
  }
  const options = { maxEdge, forceConversion: true }
  const result = await uploadAttachment(apiKey, file.id, blob, file.name, true, options)
  // 同一附件可能有另一轮上传正在进行，复用它之前先核对图片尺寸和格式。
  if (result.serverImage?.converted && result.serverImage.maxEdge <= maxEdge) {
    return result
  }
  signal.throwIfAborted()
  return uploadAttachment(apiKey, file.id, blob, file.name, true, options)
}

/** 旧附件或原始格式被 Messages API 拒绝时，按实际发送的消息和块索引只修复那一张。 */
const repairRejectedImage = async (
  sessionId: string,
  request: Request,
  messages: MessageParam[],
  error: unknown,
  signal: AbortSignal
): Promise<boolean> => {
  const position = getRejectedImagePosition(error)
  if (!position) {
    return false
  }
  const message = messages[position.message]
  if (message?.role !== 'user' || !Array.isArray(message.content)) {
    return false
  }
  const block = message.content[position.block]
  if (block?.type !== 'image' || block.source.type !== 'file') {
    return false
  }
  const { file_id: fileId } = block.source
  const images = getRequestImages(refreshRequest(sessionId, request))
  const file = images.find(({ serverId }) => serverId === fileId)
  const maxEdge = images.length >= MANY_IMAGES_COUNT ? MANY_IMAGES_MAX_EDGE : MAX_IMAGE_EDGE
  if (!file || (file.serverImage?.converted && file.serverImage.maxEdge <= maxEdge)) {
    return false
  }
  const epoch = historyEpoch
  const apiKey = useSettings.getState().apiKey ?? ''
  const result = await uploadRequestImage(sessionId, apiKey, file, maxEdge, signal)
  if (!result || signal.aborted || epoch !== historyEpoch) {
    return false
  }
  saveUploadedFiles(sessionId, new Map([[file.id, result]]))
  return true
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null, serverImage: undefined }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端拒绝附件时尝试重新补传后重发。失效的 file_id 退避重试，图片按报错中指明的位置修复。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const { apiKey: storedKey, chatConfig } = useSettings.getState()
  const apiKey = storedKey ?? ''
  const custom = Boolean(chatConfig.endpoint)
  const controller = new AbortController()
  const stopped = new Promise<false>((resolve) => {
    controller.signal.addEventListener('abort', () => resolve(false), { once: true })
  })
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = custom
    ? {
        ...initial,
        model: chatConfig.model || DEFAULT_CHAT_MODEL,
        thinking: false,
        search: false,
        prefix: false,
      }
    : initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  const signal = controller.signal
  const summarize = createContextSummarizer(apiKey, signal, chatConfig)
  const requestModel = reply.model ?? DEFAULT_CHAT_MODEL
  const initialOutputTokens = custom ? CUSTOM_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS
  const minOutputReserve = custom ? CUSTOM_OUTPUT_TOKENS : MIN_OUTPUT_RESERVE
  const fallbackOutputTokens = custom ? 1_024 : initial.thinking ? 32_768 : 8_192
  const window = custom ? CUSTOM_CONTEXT_WINDOW : undefined
  const windowLimit = window ?? WINDOW_TOKENS
  const tokenScale = estimateBranchScale(
    request.history,
    requestModel,
    getSession(sessionId)?.contextCheckpoints
  )
  const scaleEstimate = (tokens: number) =>
    tokenScale === 1 ? tokens : Math.ceil(tokens * tokenScale)
  const budget = contextBudget(minOutputReserve, window)
  let historyBudget = Math.max(
    0,
    budget.input -
      scaleEstimate(
        estimateQuestionTokens(request.question) + estimatePrefixTokens(request.prefix)
      ) -
      PROMPT_OVERHEAD_TOKENS
  )
  let historyRetries = 0
  let historySummaryRequests = 0
  let context: HistoryContext | undefined
  let maxOutputTokens = initialOutputTokens
  let reduceInput = false
  let reducedInput: Awaited<ReturnType<typeof summarizeCurrentInput>> = null
  let invalidatedRetries = 0
  try {
    for (;;) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = false
      let receivedContent = false
      let messages: MessageParam[] = []
      let attempt = request
      let estimatedInput = 0
      let requestMaxOutput = maxOutputTokens
      try {
        context ??= await prepareHistoryContext({
          history: request.history,
          checkpoints: getSession(sessionId)?.contextCheckpoints,
          budget: historyBudget,
          recentBudget: budget.recent,
          scale: tokenScale,
          summarize: (input) =>
            historySummaryRequests++ < HISTORY_SUMMARY_LIMIT
              ? summarize(input)
              : Promise.resolve(null),
          save: (checkpoint) => {
            updateSession(sessionId, (session) => ({
              ...session,
              contextCheckpoints: saveContextCheckpoint(session.contextCheckpoints, checkpoint),
            }))
            persist(sessionId)
          },
          signal,
        })
        signal.throwIfAborted()
        attempt = { ...request, history: context.history }
        let prepared = attempt
        if (!custom) {
          preparing = true
          prepared = await prepareFiles(sessionId, attempt, signal)
          preparing = false
        }
        const inlineFiles = custom
          ? await prepareCustomAttachments(
              chatConfig.format,
              prepared.history,
              reducedInput?.question ?? prepared.question,
              (id) => loadOriginalFile(sessionId, id),
              signal
            )
          : undefined
        if (reduceInput && !reducedInput) {
          reducedInput = await summarizeCurrentInput({
            apiKey,
            question: prepared.question,
            prefix: prepared.prefix,
            summarize,
            loadFile: (id) => loadOriginalFile(sessionId, id),
            signal,
            inlineFiles: inlineFiles?.get(prepared.question.id),
          })
          if (!reducedInput) {
            throw new ApiError('protocol', { key: 'replyInputTooLong' })
          }
          historyBudget = Math.max(
            0,
            Math.min(
              budget.recent,
              contextBudget(Math.min(minOutputReserve, maxOutputTokens), window).input -
                scaleEstimate(
                  estimateQuestionTokens(reducedInput.question) +
                    estimatePrefixTokens(reducedInput.prefix)
                ) -
                PROMPT_OVERHEAD_TOKENS
            )
          )
          context = undefined
          continue
        }
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = custom
          ? undefined
          : prepared.prefix
            ? prepared.prefix.latestReminder
            : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const activeQuestion = reducedInput?.question ?? prepared.question
        const activePrefix = reducedInput ? reducedInput.prefix : prepared.prefix
        messages = toRequestMessages(
          prepared.history,
          activeQuestion,
          activePrefix,
          initial.thinking ?? false,
          latestReminder,
          inlineFiles
        )
        includeContextSummary(messages, context.summary)
        estimatedInput =
          context.tokens +
          scaleEstimate(
            estimateQuestionTokens(activeQuestion) + estimatePrefixTokens(activePrefix)
          ) +
          PROMPT_OVERHEAD_TOKENS
        requestMaxOutput = resolveMaxOutputTokens(
          maxOutputTokens,
          estimatedInput,
          Math.min(minOutputReserve, maxOutputTokens),
          window
        )
        const body: CreateMessageRequest = {
          model: requestModel,
          max_tokens: requestMaxOutput,
          system: custom ? '' : SYSTEM_PROMPT,
          messages,
          thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
          safety_check: SAFETY_CHECK,
          tools: serverTools(initial.search ?? false),
          ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
        }
        const events = streamChatMessage(chatConfig, apiKey, body, signal)
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        if (
          (custom || chatConfig.format !== 'messages') &&
          titleRequests.has(controller) &&
          !get().importingHistory
        ) {
          const title =
            request.question.content.trim().split(/\r?\n/, 1)[0] || request.question.files[0]?.name
          if (title) {
            const preview = Array.from(title).slice(0, 64).join('')
            updateSession(sessionId, (session) =>
              session.title ? session : { ...session, title: preview }
            )
          }
        }
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (!receivedContent) {
          if (isContextOverflow(error)) {
            if (
              requestMaxOutput > fallbackOutputTokens &&
              estimatedInput + requestMaxOutput >= Math.floor(windowLimit * 0.85)
            ) {
              // 高输入场景下因 max_tokens 占满窗口导致的溢出，优先缩小输出预算，不误砍历史。
              maxOutputTokens = fallbackOutputTokens
              continue
            }
            if (context?.tokens) {
              // 每次严格收紧历史预算。最后一次保留本轮输入，验证是否是输入本身过长。
              historyBudget =
                ++historyRetries < HISTORY_OVERFLOW_RETRIES ? Math.floor(context.tokens / 2) : 0
              context = undefined
              continue
            }
            if (maxOutputTokens > fallbackOutputTokens) {
              maxOutputTokens = fallbackOutputTokens
              continue
            }
            if (!reduceInput) {
              reduceInput = true
              continue
            }
            reply = settleReply(reply, 'error', Date.now(), {
              kind: error.kind,
              message: error.message,
              localMessage: { key: 'replyInputTooLong' },
            })
            break
          }
          if (!custom) {
            if (
              invalidatedRetries < FILE_RETRY_LIMIT &&
              reuploadInvalidatedFiles(sessionId, attempt, error)
            ) {
              await waitForRetry(invalidatedRetries++, controller.signal)
              if (!controller.signal.aborted) {
                continue
              }
            } else if (chatConfig.format === 'messages') {
              const repaired = await Promise.race([
                stopped,
                repairRejectedImage(sessionId, attempt, messages, error, signal).catch(() => false),
              ])
              if (repaired) {
                continue
              }
            }
          }
        }
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (receivedContent && isContextOverflow(error)) {
          reply = settleReply(reply, 'stopped', Date.now())
        } else if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
  }
}
