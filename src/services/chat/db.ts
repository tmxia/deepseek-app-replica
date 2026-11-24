import * as native from './androidStorage.js'
import * as indexed from './indexedDb.js'

export { reportStorageError } from './storageTypes.js'
export type { HistoryStaging, StagingWriter, StoredFile } from './storageTypes.js'

export const usesNativeChatStorage = native.available

const storage = usesNativeChatStorage ? native : indexed

export const {
  loadSessionSummaries,
  loadSession,
  scanSessions,
  loadFile,
  saveSession,
  renameSession,
  deleteSession,
  beginStaging,
  stagingWriter,
} = storage
