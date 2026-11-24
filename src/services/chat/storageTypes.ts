import { toSessionSummary, type Session, type SessionSummary } from './types.js'

export type StoredFile = { id: string; blob: Blob }
export type StoredSessionSummary = SessionSummary & { fileIds: string[] }

export type StagingWriter = {
  summaries: SessionSummary[]
  getActiveFileTypes(ids: string[]): Promise<Map<string, string>>
  addSessions(sessions: Session[]): Promise<void>
  addFiles(files: StoredFile[]): Promise<void>
  updateFileTypes(ids: string[], types: ReadonlyMap<string, string>): Promise<void>
}

export type MergeCommitResult = {
  summaries: SessionSummary[]
  added: number
  merged: number
  unchanged: number
  updatedIds: string[]
}

export type MergeOptions = {
  localOverrides?: ReadonlyMap<string, { session: Session; files?: StoredFile[] }>
  clearInBackground?: boolean
}

export type HistoryStaging = {
  importId: string
  commit(clearInBackground: boolean): Promise<void>
  commitMerge(options?: MergeOptions): Promise<MergeCommitResult>
  discard(): Promise<void>
}

export const storedSummary = (session: Session): StoredSessionSummary => {
  const fileIds = new Set<string>()
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files ?? []) {
        fileIds.add(file.id)
      }
    }
  }
  return { ...toSessionSummary(session), fileIds: [...fileIds] }
}

export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
