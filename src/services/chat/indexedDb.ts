import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import { createId } from '../../utils/id.js'
import { mergeSessions } from './history/mergeSessions.js'
import {
  reportStorageError,
  storedSummary,
  type MergeCommitResult,
  type StoredFile,
  type StoredSessionSummary,
} from './storageTypes.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/** IndexedDB 存储结构版本；新增或调整存储、索引时递增。 */
const DB_VERSION = 13

type HistoryState = { slot: 'primary' | 'alternate'; importId?: string }
type RetiredHistory = { slot: HistoryState['slot']; importId: string }

const slots = {
  primary: { sessions: 'sessions', summaries: 'sessionSummaries', files: 'files' },
  alternate: {
    sessions: 'sessionsStaging',
    summaries: 'sessionSummariesStaging',
    files: 'filesStaging',
  },
} as const

const historyStores = [
  'historyState',
  'historyCleanup',
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'sessionSummariesStaging',
  'filesStaging',
] as const

type HistoryStore = (typeof historyStores)[number]

type HistoryTransaction<Mode extends 'readonly' | 'readwrite'> = IDBPTransaction<
  ChatDB,
  readonly HistoryStore[],
  Mode
>

interface ChatDB extends DBSchema {
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  files: { key: string; value: StoredFile }
  sessionsStaging: { key: string; value: Session }
  sessionSummariesStaging: ChatDB['sessionSummaries']
  filesStaging: { key: string; value: StoredFile }
  historyState: { key: 'active'; value: HistoryState }
  historyCleanup: { key: 'retired'; value: RetiredHistory }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null
/** 本进程是否已成功打开过库；用于区分首装（oldVersion 0 正常）和运行期被外部清空重建。 */
let openedOnce = false
let resetDetected = false

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () => {
  if (resetDetected) {
    return Promise.reject(new Error('IndexedDB was reset during this page session'))
  }
  if (dbPromise) {
    return dbPromise
  }
  const invalidate = () => {
    if (dbPromise === opening) {
      dbPromise = null
    }
  }
  const opening = openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion === 0 && openedOnce) {
        resetDetected = true
        tx.abort()
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('chat-storage-reset'))
        }
        return
      }
      // 现有历史继续使用原来的存储，只有完成一次导入后才切换。
      for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      for (const { summaries: name } of Object.values(slots)) {
        const summaries = db.objectStoreNames.contains(name)
          ? tx.objectStore(name)
          : db.createObjectStore(name, { keyPath: 'id' })
        if (!summaries.indexNames.contains('fileIds')) {
          summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
        }
      }
      if (!db.objectStoreNames.contains('historyState')) {
        db.createObjectStore('historyState')
      }
      if (!db.objectStoreNames.contains('historyCleanup')) {
        db.createObjectStore('historyCleanup')
      }
    },
    blocking() {
      invalidate()
      void opening.then((db) => db.close())
    },
    terminated: invalidate,
  })
    .then((db) => {
      openedOnce = true
      return db
    })
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      invalidate()
      throw error
    })
  dbPromise = opening
  return opening
}

const transact = async <Mode extends 'readonly' | 'readwrite', Result>(
  scope: readonly HistoryStore[],
  mode: Mode,
  run: (tx: HistoryTransaction<Mode>) => Promise<Result>
): Promise<Result> => {
  const connection = getDB()
  const db = await connection
  let tx: HistoryTransaction<Mode>
  try {
    tx = db.transaction(scope, mode)
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') {
      throw error
    }
    // WebView 可能先关闭连接，再通知 close。事务尚未开始，可以安全重开一次。
    if (dbPromise === connection) {
      dbPromise = null
    }
    tx = (await getDB()).transaction(scope, mode)
  }
  const [result] = await Promise.all([
    (async () => {
      try {
        return await run(tx)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
  return result
}

type HistoryOperation<Mode extends 'readonly' | 'readwrite', Result> = (
  tx: HistoryTransaction<Mode>,
  state: HistoryState
) => Promise<Result>

const withHistory = <Mode extends 'readonly' | 'readwrite', Result>(
  mode: Mode,
  run: HistoryOperation<Mode, Result>,
  scope: readonly HistoryStore[] = historyStores
) =>
  transact(scope, mode, async (tx) => {
    const state = await tx.objectStore('historyState').get('active')
    return run(tx, state ?? { slot: 'primary' })
  })

let preferredSlot: HistoryState['slot'] = 'primary'

// 普通读写只锁当前使用的一组存储。每次在同一事务内核对指针，换库后按新指针重试。
const withActive = async <Mode extends 'readonly' | 'readwrite', Result>(
  mode: Mode,
  run: HistoryOperation<Mode, Result>
): Promise<Result> => {
  for (;;) {
    const expected = preferredSlot
    const attempt = await withHistory(
      mode,
      async (tx, state) =>
        state.slot === expected
          ? { match: true as const, value: await run(tx, state) }
          : { match: false as const, slot: state.slot },
      ['historyState', ...Object.values(slots[expected])]
    )
    if (attempt.match) {
      return attempt.value
    }
    preferredSlot = attempt.slot
  }
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const summaries = await withActive('readonly', (tx, { slot }) =>
    tx.objectStore(slots[slot].summaries).getAll()
  )
  scheduleRetiredCleanup()
  return summaries.map(toSessionSummary)
}

export const loadSession = (id: string): Promise<Session | undefined> =>
  withActive('readonly', (tx, { slot }) => tx.objectStore(slots[slot].sessions).get(id))

/** 在单次只读事务中按游标流式扫描会话，避免逐条开事务或一次性将全部会话驻留内存。 */
export const scanSessions = async (
  onSession: (session: Session) => boolean,
  skipIds?: ReadonlySet<string>
): Promise<void> => {
  await withActive('readonly', async (tx, { slot }) => {
    let cursor = await tx.objectStore(slots[slot].sessions).openCursor()
    while (cursor) {
      if (!skipIds?.has(cursor.primaryKey)) {
        if (!onSession(cursor.value)) {
          break
        }
      }
      cursor = await cursor.continue()
    }
  })
}

export const saveSession = (session: Session, files: StoredFile[] = []): Promise<void> =>
  withActive('readwrite', async (tx, { slot }) => {
    const stores = slots[slot]
    const summary = storedSummary(session)
    await Promise.all([
      ...files.map((file) => tx.objectStore(stores.files).put(file)),
      tx.objectStore(stores.sessions).put(session),
      tx.objectStore(stores.summaries).put(summary),
    ])
  })

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = (id: string, title: string): Promise<void> =>
  withActive('readwrite', async (tx, { slot }) => {
    const sessions = tx.objectStore(slots[slot].sessions)
    const session = await sessions.get(id)
    if (session) {
      session.title = title
      await Promise.all([
        sessions.put(session),
        tx.objectStore(slots[slot].summaries).put(storedSummary(session)),
      ])
    }
  })

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = (sessionId: string): Promise<void> =>
  withActive('readwrite', async (tx, { slot }) => {
    const stores = slots[slot]
    const summaries = tx.objectStore(stores.summaries)
    const summary = await summaries.get(sessionId)
    await Promise.all([
      tx.objectStore(stores.sessions).delete(sessionId),
      summaries.delete(sessionId),
    ])
    for (const id of summary?.fileIds ?? []) {
      if ((await summaries.index('fileIds').count(id)) === 0) {
        await tx.objectStore(stores.files).delete(id)
      }
    }
  })

export const saveFiles = (files: StoredFile[]): Promise<void> =>
  withActive('readwrite', async (tx, { slot }) => {
    const store = tx.objectStore(slots[slot].files)
    await Promise.all(files.map((file) => store.put(file)))
  })

export const loadFile = (id: string): Promise<Blob | undefined> =>
  withActive(
    'readonly',
    async (tx, { slot }) => (await tx.objectStore(slots[slot].files).get(id))?.blob
  )

const inactiveSlot = (slot: HistoryState['slot']) => (slot === 'primary' ? 'alternate' : 'primary')

const clearSlot = (tx: HistoryTransaction<'readwrite'>, slot: HistoryState['slot']) =>
  Promise.all(Object.values(slots[slot]).map((name) => tx.objectStore(name).clear()))

const setHistoryState = (tx: HistoryTransaction<'readwrite'>, state: HistoryState) =>
  tx.objectStore('historyState').put(state, 'active')

const CLEANUP_BATCH_SIZE = 256
let cleanupQueue = Promise.resolve()

const clearRetiredHistory = async () => {
  const retired = await (await getDB()).get('historyCleanup', 'retired')
  if (!retired) {
    return
  }
  const names = Object.values(slots[retired.slot])
  let more = true
  while (more) {
    // 分批清理旧数据，给正在使用的 IndexedDB 事务让出执行机会。
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    more = await transact(['historyCleanup', ...names], 'readwrite', async (tx) => {
      const cleanup = tx.objectStore('historyCleanup')
      const pending = await cleanup.get('retired')
      if (pending?.importId !== retired.importId) {
        return false
      }
      const remaining = await Promise.all(
        names.map(async (name) => {
          const store = tx.objectStore(name)
          const keys = await store.getAllKeys(null, CLEANUP_BATCH_SIZE)
          const last = keys.at(-1)
          if (last !== undefined) {
            await store.delete(IDBKeyRange.upperBound(last))
          }
          return keys.length === CLEANUP_BATCH_SIZE
        })
      )
      if (!remaining.some(Boolean)) {
        await cleanup.delete('retired')
        return false
      }
      return true
    })
  }
}

const scheduleRetiredCleanup = () => {
  cleanupQueue = cleanupQueue
    .then(clearRetiredHistory)
    .catch(reportStorageError('clear replaced history'))
}

// 导入线程只持有标识。每次写入都在事务内核对标识，防止过期任务写入新的暂存区。
const withStaging = <Result>(
  importId: string,
  run: (tx: HistoryTransaction<'readwrite'>, slot: HistoryState['slot']) => Promise<Result>
) =>
  withHistory('readwrite', (tx, state) => {
    if (state.importId !== importId) {
      throw new Error('History import was replaced by another import')
    }
    return run(tx, state.slot)
  })

export const stagingWriter = (importId: string) => {
  const summaries: SessionSummary[] = []
  return {
    summaries,
    async getActiveFileTypes(ids: string[]) {
      const result = new Map<string, string>()
      if (ids.length === 0) {
        return result
      }
      const unique = [...new Set(ids)]
      await withHistory(
        'readonly',
        async (tx, state) => {
          if (state.importId !== importId) {
            throw new Error('History import was replaced by another import')
          }
          const store = tx.objectStore(slots[state.slot].files)
          await Promise.all(
            unique.map(async (id) => {
              const file = await store.get(id)
              if (file) {
                result.set(id, file.blob.type)
              }
            })
          )
        },
        ['historyState', 'files', 'filesStaging']
      )
      return result
    },
    async addSessions(sessions: Session[]) {
      const batch = sessions.map(storedSummary)
      await withStaging(importId, async (tx, slot) => {
        const stores = slots[inactiveSlot(slot)]
        const details = tx.objectStore(stores.sessions)
        const index = tx.objectStore(stores.summaries)
        await Promise.all([
          ...sessions.map((session) => details.add(session)),
          ...batch.map((summary) => index.add(summary)),
        ])
      })
      for (const summary of batch) {
        summaries.push(toSessionSummary(summary))
      }
    },
    async addFiles(files: StoredFile[]) {
      await withStaging(importId, async (tx, slot) => {
        const store = tx.objectStore(slots[inactiveSlot(slot)].files)
        await Promise.all(files.map((file) => store.put(file)))
      })
    },
    async updateFileTypes(ids: string[], types: ReadonlyMap<string, string>) {
      await withStaging(importId, async (tx, slot) => {
        const store = tx.objectStore(slots[inactiveSlot(slot)].sessions)
        await Promise.all(
          ids.map(async (id) => {
            const session = await store.get(id)
            if (!session) {
              throw new Error(`Staged session disappeared: ${id}`)
            }
            let changed = false
            for (const message of session.messages) {
              if (message.role !== 'user') {
                continue
              }
              for (const file of message.files) {
                const type = types.get(file.id) ?? ''
                if (file.mimeType !== type) {
                  file.mimeType = type
                  changed = true
                }
              }
            }
            if (changed) {
              await store.put(session)
            }
          })
        )
      })
    },
  }
}

const MERGE_FILE_BATCH_SIZE = 8
const MERGE_ADD_BATCH_SIZE = 32
const MERGE_OVERLAP_BATCH_SIZE = 16

/** 两组存储轮流使用，界面线程拥有提交和清理权限。 */
export const beginStaging = async () => {
  const importId = createId()
  await withHistory('readwrite', async (tx, { slot }) => {
    await clearSlot(tx, inactiveSlot(slot))
    await tx.objectStore('historyCleanup').delete('retired')
    await setHistoryState(tx, { slot, importId })
  })
  return {
    importId,
    async commit(clearInBackground: boolean) {
      preferredSlot = await withStaging(importId, async (tx, slot) => {
        const next = inactiveSlot(slot)
        if (clearInBackground) {
          await tx.objectStore('historyCleanup').put({ slot, importId }, 'retired')
        } else {
          await clearSlot(tx, slot)
        }
        await setHistoryState(tx, { slot: next })
        return next
      })
      if (clearInBackground) {
        scheduleRetiredCleanup()
      }
    },
    async commitMerge({
      localOverrides,
      clearInBackground = false,
    }: {
      localOverrides?: ReadonlyMap<string, { session: Session; files?: StoredFile[] }>
      clearInBackground?: boolean
    } = {}): Promise<MergeCommitResult> {
      const { activeSummaryMap, existingFileIds, stagedSessionIds, stagedFileIds } =
        await withHistory('readonly', async (tx, state) => {
          if (state.importId !== importId) {
            throw new Error('History import was replaced by another import')
          }
          const active = slots[state.slot]
          const staged = slots[inactiveSlot(state.slot)]
          const [activeSummaries, existingKeys, sessionKeys, fileKeys] = await Promise.all([
            tx.objectStore(active.summaries).getAll(),
            tx.objectStore(active.files).getAllKeys(),
            tx.objectStore(staged.summaries).getAllKeys(),
            tx.objectStore(staged.files).getAllKeys(),
          ])
          return {
            activeSummaryMap: new Map(activeSummaries.map((item) => [item.id, item])),
            existingFileIds: new Set(existingKeys),
            stagedSessionIds: sessionKeys,
            stagedFileIds: fileKeys,
          }
        })

      const missingFileIds = stagedFileIds.filter((id) => !existingFileIds.has(id))
      for (let i = 0; i < missingFileIds.length; i += MERGE_FILE_BATCH_SIZE) {
        const batch = missingFileIds.slice(i, i + MERGE_FILE_BATCH_SIZE)
        await withStaging(importId, async (tx, slot) => {
          const activeFiles = tx.objectStore(slots[slot].files)
          const stagedFiles = tx.objectStore(slots[inactiveSlot(slot)].files)
          await Promise.all(
            batch.map(async (id) => {
              if ((await activeFiles.getKey(id)) === undefined) {
                const file = await stagedFiles.get(id)
                if (file) {
                  await activeFiles.put(file)
                }
              }
            })
          )
        })
      }

      const newIds: string[] = []
      const overlapIds: string[] = []
      for (const id of stagedSessionIds) {
        if (activeSummaryMap.has(id) || localOverrides?.has(id)) {
          overlapIds.push(id)
        } else {
          newIds.push(id)
        }
      }

      const overrideFiles = overlapIds.flatMap((id) => localOverrides?.get(id)?.files ?? [])
      for (let i = 0; i < overrideFiles.length; i += MERGE_FILE_BATCH_SIZE) {
        const batch = overrideFiles.slice(i, i + MERGE_FILE_BATCH_SIZE)
        await withStaging(importId, async (tx, slot) => {
          const activeFiles = tx.objectStore(slots[slot].files)
          await Promise.all(batch.map((file) => activeFiles.put(file)))
        })
      }

      let added = 0
      let merged = 0
      let unchanged = 0
      const updatedIds: string[] = []

      for (let i = 0; i < newIds.length; i += MERGE_ADD_BATCH_SIZE) {
        const batch = newIds.slice(i, i + MERGE_ADD_BATCH_SIZE)
        await withStaging(importId, async (tx, slot) => {
          const active = slots[slot]
          const staged = slots[inactiveSlot(slot)]
          const activeSessions = tx.objectStore(active.sessions)
          const activeSummaries = tx.objectStore(active.summaries)
          const activeFiles = tx.objectStore(active.files)
          const stagedSessions = tx.objectStore(staged.sessions)
          await Promise.all(
            batch.map(async (id) => {
              const incoming = await stagedSessions.get(id)
              if (!incoming) {
                throw new Error(`Staged session disappeared: ${id}`)
              }
              const missingMimeIds = new Set<string>()
              for (const message of incoming.messages) {
                if (message.role === 'user') {
                  for (const file of message.files) {
                    if (file.isImage && !file.mimeType) {
                      missingMimeIds.add(file.id)
                    }
                  }
                }
              }
              if (missingMimeIds.size > 0) {
                const fileTypes = new Map<string, string>()
                await Promise.all(
                  [...missingMimeIds].map(async (fileId) => {
                    const file = await activeFiles.get(fileId)
                    if (file?.blob.type) {
                      fileTypes.set(fileId, file.blob.type)
                    }
                  })
                )
                if (fileTypes.size > 0) {
                  for (const message of incoming.messages) {
                    if (message.role === 'user') {
                      for (const file of message.files) {
                        if (!file.mimeType) {
                          file.mimeType = fileTypes.get(file.id) ?? ''
                        }
                      }
                    }
                  }
                }
              }
              const summary = storedSummary(incoming)
              await Promise.all([activeSessions.put(incoming), activeSummaries.put(summary)])
              activeSummaryMap.set(id, summary)
              added += 1
            })
          )
        })
      }

      for (let i = 0; i < overlapIds.length; i += MERGE_OVERLAP_BATCH_SIZE) {
        const batch = overlapIds.slice(i, i + MERGE_OVERLAP_BATCH_SIZE)
        await withStaging(importId, async (tx, slot) => {
          const active = slots[slot]
          const staged = slots[inactiveSlot(slot)]
          const activeSessions = tx.objectStore(active.sessions)
          const activeSummaries = tx.objectStore(active.summaries)
          const activeFiles = tx.objectStore(active.files)
          const stagedSessions = tx.objectStore(staged.sessions)
          await Promise.all(
            batch.map(async (id) => {
              const incoming = await stagedSessions.get(id)
              if (!incoming) {
                throw new Error(`Staged session disappeared: ${id}`)
              }
              const override = localOverrides?.get(id)
              const local = override?.session ?? (await activeSessions.get(id))
              if (!local) {
                const summary = storedSummary(incoming)
                await Promise.all([activeSessions.put(incoming), activeSummaries.put(summary)])
                activeSummaryMap.set(id, summary)
                added += 1
                updatedIds.push(id)
                return
              }
              const neededFileIds = new Set<string>()
              for (const session of [local, incoming]) {
                for (const message of session.messages) {
                  if (message.role === 'user') {
                    for (const file of message.files) {
                      if (!file.mimeType) {
                        neededFileIds.add(file.id)
                      }
                    }
                  }
                }
              }
              const fileTypes = new Map<string, string>()
              if (neededFileIds.size > 0) {
                await Promise.all(
                  [...neededFileIds].map(async (fileId) => {
                    const stored = await activeFiles.get(fileId)
                    if (stored?.blob.type) {
                      fileTypes.set(fileId, stored.blob.type)
                    }
                  })
                )
              }
              const result = mergeSessions(local, incoming, { fileTypes })
              if (result.changed || override) {
                const summary = storedSummary(result.session)
                await Promise.all([
                  activeSessions.put(result.session),
                  activeSummaries.put(summary),
                ])
                activeSummaryMap.set(id, summary)
                if (result.changed) {
                  merged += 1
                } else {
                  unchanged += 1
                }
                updatedIds.push(id)
              } else {
                unchanged += 1
              }
            })
          )
        })
      }

      const backgroundCleanup =
        clearInBackground && stagedSessionIds.length + stagedFileIds.length > CLEANUP_BATCH_SIZE
      await withStaging(importId, async (tx, slot) => {
        const inactive = inactiveSlot(slot)
        if (backgroundCleanup) {
          await tx.objectStore('historyCleanup').put({ slot: inactive, importId }, 'retired')
        } else {
          await clearSlot(tx, inactive)
        }
        await setHistoryState(tx, { slot })
      })
      if (backgroundCleanup) {
        scheduleRetiredCleanup()
      }

      return {
        summaries: [...activeSummaryMap.values()].map(toSessionSummary),
        added,
        merged,
        unchanged,
        updatedIds,
      }
    },
    async discard() {
      await withHistory('readwrite', async (tx, state) => {
        if (state.importId === importId) {
          await clearSlot(tx, inactiveSlot(state.slot))
          await setHistoryState(tx, { slot: state.slot })
        }
      })
    },
  }
}

/** Upgrade reads the existing active slot without upgrading or creating the legacy database. */
export const openLegacyHistory = async () => {
  let missing = false
  const db = await openDB<ChatDB>('chat-demo', undefined, {
    upgrade(_db, version, _next, tx) {
      if (version === 0) {
        missing = true
        tx.abort()
      }
    },
  }).catch((error: unknown) => {
    if (!missing) {
      throw error
    }
  })
  if (!db) {
    return undefined
  }
  try {
    const state = db.objectStoreNames.contains('historyState')
      ? await db.get('historyState', 'active')
      : undefined
    const { sessions, summaries, files } = slots[state?.slot ?? 'primary']
    const keys = async (name: typeof sessions | typeof summaries | typeof files) =>
      db.objectStoreNames.contains(name) ? await db.getAllKeys(name) : []
    return {
      close: () => db.close(),
      sessionIds: () => keys(sessions),
      summaryIds: () => keys(summaries),
      fileIds: () => keys(files),
      session: (id: string) => db.get(sessions, id),
      file: (id: string) => db.get(files, id),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

export const deleteLegacyHistory = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('chat-demo')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Legacy history cleanup is blocked'))
  })
