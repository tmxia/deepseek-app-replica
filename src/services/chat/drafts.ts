import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isAttachmentImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import { loadFile } from './db.js'
import type { FileAttachment, UserMessage } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是附件原件与上传任务的 key */
  id: string
  /** 新选或裁剪得到的本地文件；沿用历史附件时为 null */
  file: File | null
  name: string
  size: number
  mimeType: string
  isImage: boolean
  previewUrl: string | null
  /** 进入消息修改时从原消息带入的附件元数据，未改动发送时直接复用 */
  existing?: FileAttachment
  /** 原消息图片的本地原件加载状态：undefined 加载中，null 缺失，Blob 已就绪 */
  blob?: Blob | null
  /** 最近图片的本地媒体 ID，用于与选择面板同步选中状态。 */
  recentPhotoId?: string
}

export type DraftFilePayload = FileAttachment & { blob?: Blob }

type Draft = { text: string; attachments: DraftAttachment[] }

export type ActiveMessageEdit = {
  sessionId: string
  messageId: string
  text: string
  attachments: DraftAttachment[]
}

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

let editLoadEpoch = 0

export const editDraftKey = (sessionId: string, messageId: string) => `${sessionId}:${messageId}`

/** 草稿只保存在本次页面的内存中，独立于会话详情缓存；null 是新对话的草稿。 */
export const useDrafts = create<{
  drafts: Map<string | null, Draft>
  editDrafts: Map<string, string>
  editing: ActiveMessageEdit | null
}>(() => ({
  drafts: new Map(),
  editDrafts: new Map(),
  editing: null,
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

export const getEditDraftText = (sessionId: string, messageId: string): string | undefined =>
  useDrafts.getState().editDrafts.get(editDraftKey(sessionId, messageId))

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

const updateActiveEdit = (update: (editing: ActiveMessageEdit) => ActiveMessageEdit) =>
  useDrafts.setState((state) => {
    if (!state.editing) {
      return state
    }
    return { editing: update(state.editing) }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

export const setEditDraftText = (text: string) =>
  useDrafts.setState((state) => {
    if (!state.editing) {
      return state
    }
    const editDrafts = new Map(state.editDrafts)
    editDrafts.set(editDraftKey(state.editing.sessionId, state.editing.messageId), text)
    return {
      editing: { ...state.editing, text },
      editDrafts,
    }
  })

const upload = (attachment: DraftAttachment, apiKey: string) => {
  if (!attachment.file) {
    return
  }
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.name,
    attachment.isImage
  ).catch(() => {})
}

const releaseAttachment = (attachment: DraftAttachment, cancelNew: boolean) => {
  if (cancelNew && !attachment.existing) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

const releaseAttachments = (attachments: DraftAttachment[], cancelNew: boolean) =>
  attachments.forEach((attachment) => releaseAttachment(attachment, cancelNew))

const createFileAttachment = (file: File, recentPhotoId?: string): DraftAttachment => {
  const image = isAttachmentImage(file)
  return {
    id: createId(),
    file,
    name: file.name,
    size: file.size,
    mimeType: resolveMimeType(file),
    isImage: image,
    previewUrl: image ? URL.createObjectURL(file) : null,
    recentPhotoId,
  }
}

const addFilesToList = (
  currentCount: number,
  files: File[],
  apiKey: string | null,
  recentPhotoId: string | undefined,
  append: (added: DraftAttachment[]) => void
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, currentCount)
  if (error) {
    return error
  }
  const added = files.map((file) =>
    createFileAttachment(file, files.length === 1 ? recentPhotoId : undefined)
  )
  append(added)
  if (apiKey !== null) {
    added.forEach((attachment) => upload(attachment, apiKey))
  }
  return null
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string | null,
  recentPhotoId?: string
): TranslationMessage | null =>
  addFilesToList(getDraft(sessionId).attachments.length, files, apiKey, recentPhotoId, (added) =>
    updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  )

export const addEditFiles = (
  files: File[],
  apiKey: string | null,
  recentPhotoId?: string
): TranslationMessage | null => {
  const editing = useDrafts.getState().editing
  if (!editing) {
    return null
  }
  return addFilesToList(editing.attachments.length, files, apiKey, recentPhotoId, (added) =>
    updateActiveEdit((current) => ({ ...current, attachments: [...current.attachments, ...added] }))
  )
}

const retryAttachmentInList = (
  attachments: DraftAttachment[],
  attachmentId: string,
  apiKey: string | null
) => {
  const attachment = attachments.find((item) => item.id === attachmentId)
  if (attachment && !attachment.existing && apiKey !== null) {
    upload(attachment, apiKey)
  }
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string | null
) => retryAttachmentInList(getDraft(sessionId).attachments, attachmentId, apiKey)

export const retryEditAttachment = (attachmentId: string, apiKey: string | null) => {
  const editing = useDrafts.getState().editing
  if (editing) {
    retryAttachmentInList(editing.attachments, attachmentId, apiKey)
  }
}

const replaceImageInList = (
  attachments: DraftAttachment[],
  attachmentId: string,
  file: File,
  apiKey: string | null,
  apply: (original: DraftAttachment, replacement: DraftAttachment) => void
): TranslationMessage | null => {
  const original = attachments.find((item) => item.id === attachmentId && item.isImage)
  if (!original) {
    return null
  }
  const error = validateFiles([file], attachments.length - 1)
  if (error) {
    return error
  }
  // 新 ID 将裁剪结果与原件的上传任务和服务端文件标识隔离。
  const replacement = createFileAttachment(file)
  apply(original, replacement)
  releaseAttachment(original, true)
  if (apiKey !== null) {
    upload(replacement, apiKey)
  }
  return null
}

export const replaceDraftImage = (
  sessionId: string | null,
  attachmentId: string,
  file: File,
  apiKey: string | null
): TranslationMessage | null =>
  replaceImageInList(
    getDraft(sessionId).attachments,
    attachmentId,
    file,
    apiKey,
    (original, replacement) =>
      updateDraft(sessionId, (draft) => ({
        ...draft,
        attachments: draft.attachments.map((item) => (item === original ? replacement : item)),
      }))
  )

export const replaceEditImage = (
  attachmentId: string,
  file: File,
  apiKey: string | null
): TranslationMessage | null => {
  const editing = useDrafts.getState().editing
  if (!editing) {
    return null
  }
  return replaceImageInList(
    editing.attachments,
    attachmentId,
    file,
    apiKey,
    (original, replacement) =>
      updateActiveEdit((current) => ({
        ...current,
        attachments: current.attachments.map((item) => (item === original ? replacement : item)),
      }))
  )
}

/** 发送按钮和实际提交共用规则：有内容，且全部新附件已上传成功。 */
export const prepareDraftMessage = (
  draft: Pick<Draft, 'text' | 'attachments'>,
  tasks: Record<string, UploadTask>,
  localOnly = false
): { text: string; files: DraftFilePayload[] } | null => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: DraftFilePayload[] = []
  for (const attachment of draft.attachments) {
    if (attachment.existing) {
      files.push({ ...attachment.existing })
      continue
    }
    if (!attachment.file) {
      return null
    }
    const task = localOnly ? undefined : tasks[attachment.id]
    const uploaded = task?.status === 'done' ? task : undefined
    if (!localOnly && !uploaded?.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: uploaded?.serverId ?? null,
      serverImage: uploaded?.serverImage,
      name: attachment.name,
      size: attachment.size,
      isImage: attachment.isImage,
      mimeType: attachment.mimeType,
      blob: attachment.file,
    })
  }
  return { text, files }
}

const removeAttachmentFromList = (
  attachments: DraftAttachment[],
  attachmentId: string,
  remove: () => void
) => {
  const attachment = attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  remove()
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) =>
  removeAttachmentFromList(getDraft(sessionId).attachments, attachmentId, () =>
    updateDraft(sessionId, (draft) => ({
      ...draft,
      attachments: draft.attachments.filter((item) => item.id !== attachmentId),
    }))
  )

export const removeEditAttachment = (attachmentId: string) => {
  const editing = useDrafts.getState().editing
  if (!editing) {
    return
  }
  removeAttachmentFromList(editing.attachments, attachmentId, () =>
    updateActiveEdit((current) => ({
      ...current,
      attachments: current.attachments.filter((item) => item.id !== attachmentId),
    }))
  )
}

/** 进入底部修改模式：文字优先恢复未发送修改，附件每次从原消息载入。 */
export const startMessageEdit = (sessionId: string, message: UserMessage) => {
  const current = useDrafts.getState().editing
  if (current?.sessionId === sessionId && current.messageId === message.id) {
    return
  }
  if (current) {
    cancelMessageEdit()
  }
  const epoch = ++editLoadEpoch
  const savedText = getEditDraftText(sessionId, message.id)
  const attachments: DraftAttachment[] = message.files.map((file) => ({
    id: file.id,
    file: null,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    isImage: file.isImage,
    previewUrl: null,
    existing: file,
    blob: file.isImage ? undefined : null,
  }))
  useDrafts.setState({
    editing: {
      sessionId,
      messageId: message.id,
      text: savedText ?? message.content,
      attachments,
    },
  })
  for (const file of message.files) {
    if (!file.isImage) {
      continue
    }
    void loadFile(file.id)
      .then((blob) => {
        if (epoch !== editLoadEpoch) {
          return
        }
        const loadedBlob = blob ?? null
        useDrafts.setState((state) => {
          const active = state.editing
          if (
            !active ||
            active.sessionId !== sessionId ||
            active.messageId !== message.id ||
            !active.attachments.some((item) => item.id === file.id && item.existing)
          ) {
            return state
          }
          const previewUrl = loadedBlob ? URL.createObjectURL(loadedBlob) : null
          return {
            editing: {
              ...active,
              attachments: active.attachments.map((item) => {
                if (item.id === file.id && item.existing) {
                  if (item.previewUrl) {
                    URL.revokeObjectURL(item.previewUrl)
                  }
                  return { ...item, blob: loadedBlob, previewUrl }
                }
                return item
              }),
            },
          }
        })
      })
      .catch(() => {
        if (epoch !== editLoadEpoch) {
          return
        }
        useDrafts.setState((state) => {
          const active = state.editing
          if (!active || active.sessionId !== sessionId || active.messageId !== message.id) {
            return state
          }
          return {
            editing: {
              ...active,
              attachments: active.attachments.map((item) =>
                item.id === file.id && item.existing ? { ...item, blob: null } : item
              ),
            },
          }
        })
      })
  }
}

/** 退出修改而不发送：按消息保留未发送的文字修改，丢弃本轮对附件的增删改。 */
export const cancelMessageEdit = () => {
  const active = useDrafts.getState().editing
  if (!active) {
    return
  }
  editLoadEpoch += 1
  releaseAttachments(active.attachments, true)
  useDrafts.setState((state) => {
    const editDrafts = new Map(state.editDrafts)
    editDrafts.set(editDraftKey(active.sessionId, active.messageId), active.text)
    return { editing: null, editDrafts }
  })
}

export const clearSentEdit = (sessionId: string, messageId: string, localOnly = false) => {
  const active = useDrafts.getState().editing
  const matches = active?.sessionId === sessionId && active.messageId === messageId
  if (matches) {
    editLoadEpoch += 1
    releaseAttachments(active.attachments, localOnly)
  }
  useDrafts.setState((state) => {
    const editDrafts = new Map(state.editDrafts)
    editDrafts.delete(editDraftKey(sessionId, messageId))
    return {
      editDrafts,
      ...(matches ? { editing: null } : {}),
    }
  })
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null, localOnly = false) => {
  releaseAttachments(getDraft(sessionId).attachments, localOnly)
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  releaseAttachments(getDraft(sessionId).attachments, true)
  updateDraft(sessionId, () => EMPTY_DRAFT)
  if (sessionId === null) {
    return
  }
  const active = useDrafts.getState().editing
  const clearActive = active?.sessionId === sessionId
  if (clearActive) {
    editLoadEpoch += 1
    releaseAttachments(active.attachments, true)
  }
  useDrafts.setState((state) => {
    const prefix = `${sessionId}:`
    const editDrafts = new Map(state.editDrafts)
    for (const key of editDrafts.keys()) {
      if (key.startsWith(prefix)) {
        editDrafts.delete(key)
      }
    }
    return {
      editDrafts,
      ...(clearActive ? { editing: null } : {}),
    }
  })
}

export const clearAllDrafts = () => {
  const state = useDrafts.getState()
  for (const draft of state.drafts.values()) {
    releaseAttachments(draft.attachments, true)
  }
  if (state.editing) {
    editLoadEpoch += 1
    releaseAttachments(state.editing.attachments, true)
  }
  useDrafts.setState({ drafts: new Map(), editDrafts: new Map(), editing: null })
}
