import type { TranslationKey } from '../../../i18n/index.js'
import * as db from '../db.js'
import { BackupError } from './errors.js'
import type { ArchiveProgress, ImportArchiveResult, ImportMode } from './importArchive.js'

export type { ImportArchiveResult, ImportMode } from './importArchive.js'

type StagingMethods = Pick<
  db.StagingWriter,
  'addSessions' | 'addFiles' | 'updateFileTypes' | 'getActiveFileTypes'
>
export type StagingCall = {
  [Method in keyof StagingMethods]: [method: Method, ...args: Parameters<StagingMethods[Method]>]
}[keyof StagingMethods]
export type StagingReply = {
  type: 'staging-reply'
  id: number
  value?: Map<string, string>
  error?: string
}

export type ImportRequest = { file: File; importId: string; mode: ImportMode; native?: boolean }
export type ImportResponse =
  | { type: 'ready'; supported: boolean }
  | { type: 'unavailable' }
  | { type: 'progress'; value: ArchiveProgress }
  | { type: 'staging'; id: number; call: StagingCall }
  | { type: 'done'; result: ImportArchiveResult }
  | { type: 'error'; key?: TranslationKey; message: string }

const executeStaging = (writer: db.StagingWriter, call: StagingCall) => {
  switch (call[0]) {
    case 'getActiveFileTypes':
      return writer.getActiveFileTypes(call[1])
    case 'addSessions':
      return writer.addSessions(call[1])
    case 'addFiles':
      return writer.addFiles(call[1])
    case 'updateFileTypes':
      return writer.updateFileTypes(call[1], call[2])
  }
}

const runInWorker = (request: ImportRequest, onProgress: (progress: ArchiveProgress) => void) =>
  new Promise<ImportArchiveResult | undefined>((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(
        new URL(/* webpackChunkName: "history-import" */ './import.worker.ts', import.meta.url)
      )
    } catch {
      resolve(undefined)
      return
    }
    let started = false
    let closed = false
    const writer = request.native ? db.stagingWriter(request.importId) : undefined
    const close = () => {
      closed = true
      clearTimeout(timer)
      worker.terminate()
    }
    const onFailure = () => {
      if (closed) {
        return
      }
      close()
      if (started) {
        reject(new Error('History import worker stopped'))
      } else {
        resolve(undefined)
      }
    }
    const timer = setTimeout(onFailure, 4000)
    worker.addEventListener('error', onFailure)
    worker.addEventListener('messageerror', onFailure)
    worker.addEventListener('message', ({ data }: MessageEvent<ImportResponse>) => {
      if (closed) {
        return
      }
      switch (data.type) {
        case 'ready':
          if (!data.supported && !request.native) {
            onFailure()
            return
          }
          clearTimeout(timer)
          try {
            worker.postMessage(request)
            started = true
          } catch {
            onFailure()
          }
          return
        case 'progress':
          onProgress(data.value)
          return
        case 'staging': {
          const reply = (value?: Map<string, string>, error?: string) => {
            if (!closed) {
              const response: StagingReply = {
                type: 'staging-reply',
                id: data.id,
                value: value ?? undefined,
                error,
              }
              try {
                worker.postMessage(response)
              } catch {
                onFailure()
              }
            }
          }
          if (!writer) {
            onFailure()
            return
          }
          void executeStaging(writer, data.call).then(
            (value) => reply(value ?? undefined),
            (error: unknown) =>
              reply(undefined, error instanceof Error ? error.message : String(error))
          )
          return
        }
        case 'unavailable':
          close()
          resolve(undefined)
          return
        case 'done':
          close()
          resolve(data.result)
          return
        case 'error':
          close()
          reject(data.key ? new BackupError(data.key) : new Error(data.message))
      }
    })
  })

export const importOffMainThread = async (
  file: File,
  importId: string,
  onProgress: (progress: ArchiveProgress) => void,
  mode: ImportMode = 'replace'
): Promise<ImportArchiveResult> => {
  const result = await runInWorker(
    { file, importId, mode, native: db.usesNativeChatStorage },
    onProgress
  )
  if (result) {
    return result
  }
  // 老版本 WebView 可能不支持加载本地 Worker 或跨线程传递系统文件选择器的 File。
  const { importArchive } = await import('./importArchive.js')
  return importArchive(file, importId, onProgress, mode)
}
