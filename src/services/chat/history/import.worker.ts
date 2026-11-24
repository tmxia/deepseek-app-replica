import { BackupError } from './errors.js'
import { ArchiveSourceError, importArchive } from './importArchive.js'
import { toSessionSummary, type SessionSummary } from '../types.js'
import type { StagingWriter } from '../db.js'
import type {
  ImportRequest,
  ImportResponse,
  StagingCall,
  StagingReply,
} from './importOffMainThread.js'

const send = (response: ImportResponse) => globalThis.postMessage(response)

// Android injects the native bridge into the page. The worker retains ZIP parsing
// and waits for the page to acknowledge each batch written to SQLite.
const remoteWriter = (): StagingWriter => {
  const summaries: SessionSummary[] = []
  let nextId = 0
  const invoke = (call: StagingCall) =>
    new Promise<Map<string, string> | undefined>((resolve, reject) => {
      const id = nextId++
      const receive = ({ data }: MessageEvent<StagingReply>) => {
        if (data.type === 'staging-reply' && data.id === id) {
          globalThis.removeEventListener('message', receive)
          if (data.error) {
            reject(new Error(data.error))
          } else {
            resolve(data.value)
          }
        }
      }
      globalThis.addEventListener('message', receive)
      send({ type: 'staging', id, call })
    })
  return {
    summaries,
    async getActiveFileTypes(ids) {
      return (await invoke(['getActiveFileTypes', ids])) ?? new Map()
    },
    async addSessions(sessions) {
      await invoke(['addSessions', sessions])
      summaries.push(...sessions.map(toSessionSummary))
    },
    async addFiles(files) {
      await invoke(['addFiles', files])
    },
    async updateFileTypes(ids, types) {
      await invoke(['updateFileTypes', ids, types])
    },
  }
}

globalThis.addEventListener(
  'message',
  ({ data }: MessageEvent<ImportRequest>) => {
    void importArchive(
      data.file,
      data.importId,
      (value) => send({ type: 'progress', value }),
      data.mode,
      data.native ? remoteWriter() : undefined
    ).then(
      (result) => send({ type: 'done', result }),
      (error: unknown) => {
        if (error instanceof ArchiveSourceError) {
          send({ type: 'unavailable' })
          return
        }
        send({
          type: 'error',
          key: error instanceof BackupError ? error.key : undefined,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    )
  },
  { once: true }
)

send({ type: 'ready', supported: typeof indexedDB !== 'undefined' })
