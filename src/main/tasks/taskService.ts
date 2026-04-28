import {
  type CreateChecklistItemInput,
  type CreateTaskInput,
  type TaskDocument,
  type TaskRecord,
  type TaskStatus,
  type TimeLog,
  type UpdateTaskInput
} from '@shared/schema'
import { FileStorage } from '@main/storage/fileStorage'
import { DEFAULT_TASK_DOCUMENT } from '@main/storage/defaults'

const createId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
const IMMEDIATE_WRITE_MS = 0

const normalizeMinutes = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : fallback

const calculateDurationMinutes = (startAt: string, endAt: string): number => {
  const startMs = Date.parse(startAt)
  const endMs = Date.parse(endAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0
  }

  return Math.max(0, Math.round((endMs - startMs) / 60000))
}

type NormalizedTaskDocument = {
  stored: TaskDocument
  runtime: TaskDocument
  changed: boolean
}

export class TaskService {
  constructor(private readonly storage: FileStorage) {}

  async getTaskDocument(): Promise<TaskDocument> {
    const document = await this.getPersistedTaskDocument()
    if (document.categories?.length > 0) {
      return this.normalizeDocument(document).runtime
    }

    return this.saveDocument({
      ...document,
      categories: DEFAULT_TASK_DOCUMENT.categories
    })
  }

  async createTask(input: CreateTaskInput): Promise<TaskDocument> {
    const title = input.title.trim()
    if (!title) {
      throw new Error('Task title is required.')
    }

    const document = await this.getPersistedTaskDocument()
    const now = new Date().toISOString()
    const categoryId = this.resolveCategoryId(document, input.categoryId)

    const nextTask: TaskRecord = {
      id: createId(),
      title,
      description: input.description?.trim() ?? '',
      status: 'todo',
      priority: input.priority ?? 'medium',
      categoryId,
      estimatedMinutes: normalizeMinutes(input.estimatedMinutes, 30),
      actualMinutes: 0,
      dueDate: input.dueDate ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      checklist: []
    }

    return this.saveDocument({
      ...document,
      tasks: [nextTask, ...document.tasks]
    })
  }

  async updateTask(taskId: string, input: UpdateTaskInput): Promise<TaskDocument> {
    const document = await this.getPersistedTaskDocument()
    const targetTask = document.tasks.find((task) => task.id === taskId)

    if (!targetTask) {
      throw new Error('Task not found.')
    }

    if (targetTask.status === 'archived' && input.status !== 'archived') {
      throw new Error('Archived tasks are read-only.')
    }

    if (input.status === 'in_progress') {
      return this.startTaskTimer(document, taskId)
    }

    if (targetTask.status === 'in_progress' && input.status) {
      return this.stopTaskTimer(document, taskId, input.status as Exclude<TaskStatus, 'in_progress'>, input)
    }

    const nextStatus = input.status ?? targetTask.status
    const nextDocument: TaskDocument = {
      ...document,
      tasks: document.tasks.map((task) => {
        if (task.id !== taskId) {
          return task
        }

        const now = new Date().toISOString()
        return {
          ...task,
          title: input.title?.trim() ? input.title.trim() : task.title,
          description: input.description !== undefined ? input.description.trim() : task.description,
          priority: input.priority ?? task.priority,
          categoryId: input.categoryId ? this.resolveCategoryId(document, input.categoryId) : task.categoryId,
          estimatedMinutes: normalizeMinutes(input.estimatedMinutes, task.estimatedMinutes),
          dueDate: input.dueDate !== undefined ? input.dueDate : task.dueDate,
          status: nextStatus,
          completedAt:
            nextStatus === 'done'
              ? task.completedAt ?? now
              : nextStatus === 'archived'
                ? task.completedAt
                : null,
          updatedAt: now
        }
      })
    }

    return this.saveDocument(nextDocument)
  }

  async removeTask(taskId: string): Promise<TaskDocument> {
    const document = await this.getPersistedTaskDocument()
    return this.saveDocument({
      ...document,
      tasks: document.tasks.filter((task) => task.id !== taskId),
      timeLogs: document.timeLogs.filter((timeLog) => timeLog.taskId !== taskId)
    })
  }

  async addChecklistItem(taskId: string, input: CreateChecklistItemInput): Promise<TaskDocument> {
    const content = input.content.trim()
    if (!content) {
      throw new Error('Checklist content is required.')
    }

    const document = await this.getPersistedTaskDocument()
    const nextDocument = this.mapEditableTask(document, taskId, (task) => ({
      ...task,
      checklist: [
        ...task.checklist,
        {
          id: createId(),
          content,
          isChecked: false
        }
      ]
    }))

    return this.saveDocument(nextDocument)
  }

  async toggleChecklistItem(taskId: string, checklistItemId: string): Promise<TaskDocument> {
    const document = await this.getPersistedTaskDocument()
    const nextDocument = this.mapEditableTask(document, taskId, (task) => ({
      ...task,
      checklist: task.checklist.map((item) =>
        item.id === checklistItemId ? { ...item, isChecked: !item.isChecked } : item
      )
    }))

    return this.saveDocument(nextDocument)
  }

  async removeChecklistItem(taskId: string, checklistItemId: string): Promise<TaskDocument> {
    const document = await this.getPersistedTaskDocument()
    const nextDocument = this.mapEditableTask(document, taskId, (task) => ({
      ...task,
      checklist: task.checklist.filter((item) => item.id !== checklistItemId)
    }))

    return this.saveDocument(nextDocument)
  }

  private mapEditableTask(
    document: TaskDocument,
    taskId: string,
    mapper: (task: TaskRecord) => TaskRecord
  ): TaskDocument {
    const targetTask = document.tasks.find((task) => task.id === taskId)
    if (!targetTask) {
      throw new Error('Task not found.')
    }

    if (targetTask.status === 'archived') {
      throw new Error('Archived tasks are read-only.')
    }

    return {
      ...document,
      tasks: document.tasks.map((task) => {
        if (task.id !== taskId) {
          return task
        }

        return {
          ...mapper(task),
          updatedAt: new Date().toISOString()
        }
      })
    }
  }

  private async getPersistedTaskDocument(): Promise<TaskDocument> {
    const document = await this.storage.readDocument('tasks')
    const normalized = this.normalizeDocument(document)
    if (normalized.changed) {
      await this.storage.scheduleWrite('tasks', normalized.stored, IMMEDIATE_WRITE_MS)
      return normalized.stored
    }

    return normalized.stored
  }

  private normalizeDocument(document: TaskDocument): NormalizedTaskDocument {
    const now = new Date().toISOString()
    const categories =
      Array.isArray(document.categories) && document.categories.length > 0
        ? document.categories
        : DEFAULT_TASK_DOCUMENT.categories
    const tasks = (Array.isArray(document.tasks) ? document.tasks : []).map((task) => ({
      ...task,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority ?? 'medium',
      categoryId: task.categoryId,
      estimatedMinutes: normalizeMinutes(task.estimatedMinutes, 30),
      actualMinutes: normalizeMinutes(task.actualMinutes, 0),
      dueDate: task.dueDate ?? null,
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? task.createdAt ?? now,
      completedAt: task.completedAt ?? null,
      checklist: task.checklist ?? []
    }))

    let timeLogs = (Array.isArray(document.timeLogs) ? document.timeLogs : [])
      .filter((timeLog) => tasks.some((task) => task.id === timeLog.taskId))
      .map((timeLog) => ({
        ...timeLog,
        durationMinutes:
          timeLog.endAt === null ? 0 : calculateDurationMinutes(timeLog.startAt, timeLog.endAt)
      }))

    const activeLogs = timeLogs.filter((timeLog) => timeLog.endAt === null)

    for (const activeLog of activeLogs) {
      const activeTask = tasks.find((task) => task.id === activeLog.taskId)
      if (activeTask && (activeTask.status === 'done' || activeTask.status === 'archived')) {
        timeLogs = timeLogs.map((timeLog) =>
          timeLog.id === activeLog.id
            ? {
                ...timeLog,
                endAt: now,
                durationMinutes: calculateDurationMinutes(timeLog.startAt, now)
              }
            : timeLog
        )
      }
    }

    const resolvedActiveLogs = timeLogs.filter((timeLog) => timeLog.endAt === null)
    const stored = this.buildDocument(
      document.version ?? DEFAULT_TASK_DOCUMENT.version,
      tasks,
      categories,
      timeLogs,
      now,
      false,
      resolvedActiveLogs
    )
    const runtime = this.buildDocument(
      document.version ?? DEFAULT_TASK_DOCUMENT.version,
      tasks,
      categories,
      timeLogs,
      now,
      true,
      resolvedActiveLogs
    )

    return {
      stored,
      runtime,
      changed: JSON.stringify(document) !== JSON.stringify(stored)
    }
  }

  private buildDocument(
    version: number,
    tasks: TaskRecord[],
    categories: TaskDocument['categories'],
    timeLogs: TimeLog[],
    now: string,
    includeActiveElapsed: boolean,
    activeLogs: TimeLog[]
  ): TaskDocument {
    return {
      version,
      categories,
      timeLogs,
      tasks: tasks.map((task) => {
        const taskTimeLogs = timeLogs.filter((timeLog) => timeLog.taskId === task.id)
        const closedMinutes = taskTimeLogs
          .filter((timeLog) => timeLog.endAt !== null)
          .reduce((sum, timeLog) => sum + timeLog.durationMinutes, 0)
        const activeLog = activeLogs.find((log) => log.taskId === task.id)
        const isActive = activeLog !== undefined
        const activeMinutes =
          isActive && includeActiveElapsed
            ? calculateDurationMinutes(activeLog.startAt, now)
            : 0

        return {
          ...task,
          actualMinutes: isActive && !includeActiveElapsed ? normalizeMinutes(task.actualMinutes, closedMinutes) : closedMinutes + activeMinutes,
          status: isActive ? 'in_progress' : task.status
        }
      })
    }
  }

  private async startTaskTimer(document: TaskDocument, taskId: string): Promise<TaskDocument> {
    const targetTask = document.tasks.find((task) => task.id === taskId)
    if (!targetTask) {
      throw new Error('Task not found.')
    }

    if (targetTask.status === 'done') {
      throw new Error('Completed tasks cannot start a timer.')
    }

    const existingActiveLog = document.timeLogs.find(
      (timeLog) => timeLog.endAt === null && timeLog.taskId === taskId
    )
    if (existingActiveLog) {
      return this.normalizeDocument(document).runtime
    }

    const now = new Date().toISOString()
    const nextDocument: TaskDocument = {
      ...document,
      tasks: document.tasks.map((task) => {
        if (task.id === taskId) {
          return {
            ...task,
            status: 'in_progress',
            completedAt: null,
            updatedAt: now
          }
        }

        return task
      }),
      timeLogs: [
        ...document.timeLogs,
        {
          id: createId(),
          taskId,
          startAt: now,
          endAt: null,
          durationMinutes: 0
        }
      ]
    }

    return this.saveDocument(nextDocument, IMMEDIATE_WRITE_MS)
  }

  private async stopTaskTimer(
    document: TaskDocument,
    taskId: string,
    nextStatus: Exclude<TaskStatus, 'in_progress'>,
    input: UpdateTaskInput
  ): Promise<TaskDocument> {
    const activeLog = document.timeLogs.find((timeLog) => timeLog.endAt === null) ?? null
    if (!activeLog || activeLog.taskId !== taskId) {
      throw new Error('Task timer is not active.')
    }

    const now = new Date().toISOString()
    const nextDocument: TaskDocument = {
      ...document,
      tasks: document.tasks.map((task) => {
        if (task.id !== taskId) {
          return task
        }

        return {
          ...task,
          title: input.title?.trim() ? input.title.trim() : task.title,
          description: input.description !== undefined ? input.description.trim() : task.description,
          priority: input.priority ?? task.priority,
          categoryId: input.categoryId ? this.resolveCategoryId(document, input.categoryId) : task.categoryId,
          estimatedMinutes: normalizeMinutes(input.estimatedMinutes, task.estimatedMinutes),
          dueDate: input.dueDate !== undefined ? input.dueDate : task.dueDate,
          status: nextStatus,
          completedAt:
            nextStatus === 'done'
              ? task.completedAt ?? now
              : nextStatus === 'archived'
                ? task.completedAt
                : null,
          updatedAt: now
        }
      }),
      timeLogs: document.timeLogs.map((timeLog) =>
        timeLog.id === activeLog.id
          ? {
              ...timeLog,
              endAt: now,
              durationMinutes: calculateDurationMinutes(timeLog.startAt, now)
            }
          : timeLog
      )
    }

    return this.saveDocument(nextDocument, IMMEDIATE_WRITE_MS)
  }

  private async saveDocument(document: TaskDocument, debounceMs?: number): Promise<TaskDocument> {
    const normalized = this.normalizeDocument(document)
    const saved = await this.storage.scheduleWrite('tasks', normalized.stored, debounceMs)
    return this.normalizeDocument(saved).runtime
  }

  private resolveCategoryId(document: TaskDocument, categoryId: string | undefined): string {
    if (!categoryId) {
      return document.categories[0]?.id ?? 'work'
    }

    return document.categories.some((category) => category.id === categoryId)
      ? categoryId
      : document.categories[0]?.id ?? 'work'
  }
}
