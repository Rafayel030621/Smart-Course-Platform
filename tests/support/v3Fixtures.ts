import { vi } from 'vitest'
import type {
  CloudEvidence,
  CloudMaterial,
  CloudMaterialSegment,
  CloudMilestone,
  CloudProject,
  CloudProjectSummary,
  CloudTask,
  CloudUnderstandingItem,
  ProgressRecord,
  V3User,
} from '@/types/platform'

export const FIXED_ISO = '2026-10-19T02:30:00.000Z'

export function makeUser(overrides: Partial<V3User> = {}): V3User {
  return {
    userId: 'usr_1',
    account: 'student01',
    displayName: '李同学',
    status: 'active',
    revision: 1,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  }
}

export function makeMilestoneStats(overrides: Partial<CloudMilestone['taskStats']> = {}) {
  return { total: 0, done: 0, doing: 0, todo: 0, archived: 0, progress: 0, ...overrides }
}

export function makeCloudMilestone(overrides: Partial<CloudMilestone> = {}): CloudMilestone {
  return {
    milestoneId: 'ms_1',
    name: '数据获取与预处理',
    goal: '拿到可复现的样例数据',
    doneCriteria: '样例数据可下载，字段说明完整',
    dueAt: null,
    status: 'active',
    orderIndex: 0,
    revision: 1,
    source: 'manual',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    completedAt: null,
    archivedAt: null,
    taskStats: makeMilestoneStats(),
    ...overrides,
  }
}

export function makeCloudTask(overrides: Partial<CloudTask> = {}): CloudTask {
  return {
    taskId: 'tsk_1',
    projectId: 'prj_1',
    milestoneId: 'ms_1',
    milestoneName: '数据获取与预处理',
    title: '跑通 ERA5 下载链路',
    doneCriteria: '下载一段样例数据',
    status: 'doing',
    assigneeUserId: null,
    orderIndex: 0,
    source: 'manual',
    revision: 1,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  }
}

export function makeEvidence(overrides: Partial<CloudEvidence> = {}): CloudEvidence {
  return {
    evidenceId: 'evd_1',
    projectId: 'prj_1',
    taskId: 'tsk_1',
    milestoneId: 'ms_1',
    milestoneNameSnapshot: '数据获取与预处理',
    submissionId: 'sub_00000001',
    didWhat: '下载了 2024 年 1 月的 ERA5 样例数据',
    foundWhat: '字段完整',
    stillUnsure: null,
    attachmentName: null,
    status: 'active',
    revision: 1,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    redactedAt: null,
    ...overrides,
  }
}

export function makeProgress(overrides: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    progressId: 'prg_1',
    milestoneId: 'ms_1',
    taskId: 'tsk_1',
    summary: '完成样例数据下载',
    evidenceIds: ['evd_1'],
    occurredAt: FIXED_ISO,
    status: 'active',
    supersedesProgressId: null,
    revision: 1,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  }
}

/* ------------------------------------------------ 材料（契约 22.8 DTO） */

export function makeCloudMaterial(overrides: Partial<CloudMaterial> = {}): CloudMaterial {
  return {
    materialId: 'mat_1',
    materialVersion: 1,
    name: '实验手册.md',
    type: 'md',
    size: 2048,
    encoding: 'utf-8',
    status: 'parsed',
    revision: 1,
    sha256: null,
    failureReason: null,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    archivedAt: null,
    isCurrent: true,
    readOnly: false,
    ...overrides,
  }
}

export function makeMaterialSegment(overrides: Partial<CloudMaterialSegment> = {}): CloudMaterialSegment {
  return {
    segmentId: 'seg_0',
    materialId: 'mat_1',
    materialVersion: 1,
    index: 0,
    startLine: 1,
    endLine: 3,
    text: '确认过的正文',
    charCount: 6,
    status: 'active',
    createdAt: FIXED_ISO,
    ...overrides,
  }
}

export function makeUnderstandingItem(overrides: Partial<CloudUnderstandingItem> = {}): CloudUnderstandingItem {
  return {
    itemId: 'it_1',
    kind: 'goalCandidates',
    text: '目标',
    originalText: null,
    sources: [
      {
        materialId: 'mat_1',
        materialName: '实验手册.md',
        materialVersion: 1,
        segmentId: 'seg_0',
        startLine: 1,
        endLine: 3,
      },
    ],
    status: 'pending',
    revision: 1,
    confirmedAt: null,
    confirmedByUserId: null,
    removedAt: null,
    ...overrides,
  }
}

export function emptyProfile() {
  return {
    goal: null,
    expectedOutcome: null,
    memberNames: [] as string[],
    researchPeriod: null,
    scope: null,
    outOfScope: null,
  }
}

export function makeCloudProject(overrides: Partial<CloudProject> = {}): CloudProject {
  return {
    projectId: 'prj_1',
    ownerUserId: 'usr_1',
    name: '极端风浪事件分析',
    short: '极端风浪',
    profile: emptyProfile(),
    status: 'active',
    visibility: 'private',
    projectRevision: 1,
    currentMilestoneId: 'ms_1',
    currentMilestone: '数据获取与预处理',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    archivedAt: null,
    deletedAt: null,
    milestones: [makeCloudMilestone()],
    taskStats: { total: 0, done: 0, doing: 0, todo: 0, progress: 0 },
    ...overrides,
  }
}

export function makeProjectSummary(overrides: Partial<CloudProjectSummary> = {}): CloudProjectSummary {
  return {
    projectId: 'prj_1',
    name: '极端风浪事件分析',
    short: '极端风浪',
    status: 'active',
    projectRevision: 1,
    currentMilestoneId: 'ms_1',
    currentMilestone: '数据获取与预处理',
    milestoneCount: 1,
    taskCount: 0,
    doneTaskCount: 0,
    updatedAt: FIXED_ISO,
    ...overrides,
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function envelope(
  data: unknown,
  overrides: Partial<{
    contractVersion: string
    requestId: string
    projectId: string | null
    projectRevision: number | null
    replayed: boolean
    changed: boolean
  }> = {},
): Record<string, unknown> {
  return {
    contractVersion: '3.0',
    requestId: 'req_test',
    projectId: null,
    projectRevision: null,
    replayed: false,
    data,
    ...overrides,
  }
}

/**
 * 按 URL + method 路由的 fetch mock。
 * handler 返回 undefined 表示未匹配，直接抛错以暴露测试漏配。
 */
export function installFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const response = await handler(url, init)
    if (response === undefined) throw new Error(`未配置的请求：${init.method ?? 'GET'} ${url}`)
    return response
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

export function requestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('请求体不是字符串')
  return JSON.parse(init.body) as Record<string, unknown>
}

/** 读接口包络：契约不返回 requestId / replayed */
export function readEnvelope(
  data: unknown,
  projectId: string | null,
  projectRevision: number | null,
): Record<string, unknown> {
  return { contractVersion: '3.0', projectId, projectRevision, data }
}

export interface CloudRouteFixture {
  project: CloudProject
  evidence?: CloudEvidence[]
  progress?: ProgressRecord[]
  tasks?: CloudTask[]
  materials?: CloudMaterial[]
  materialSegments?: Record<string, CloudMaterialSegment[]>
  materialItems?: Record<string, CloudUnderstandingItem[]>
}

/** 云端项目读取路由：项目 / 证据 / 进展 / 任务 / 材料 + 按 materialId@version 的片段与条目 */
export function cloudRoutes(
  fixture: CloudRouteFixture,
): (url: string, init: RequestInit) => Response | undefined {
  const projectId = fixture.project.projectId
  const revision = fixture.project.projectRevision
  const base = `/api/projects/${projectId}`
  return (url, init) => {
    if ((init.method ?? 'GET') !== 'GET') return undefined
    const path = url.split('?')[0] ?? url
    if (path.endsWith(base)) {
      return jsonResponse(readEnvelope({ project: fixture.project }, projectId, revision))
    }
    if (path.endsWith(`${base}/evidence`)) {
      return jsonResponse(readEnvelope({ evidence: fixture.evidence ?? [], nextCursor: null }, projectId, revision))
    }
    if (path.endsWith(`${base}/progress`)) {
      return jsonResponse(readEnvelope({ progress: fixture.progress ?? [], nextCursor: null }, projectId, revision))
    }
    if (path.endsWith(`${base}/tasks`)) {
      return jsonResponse(readEnvelope({ tasks: fixture.tasks ?? [], nextCursor: null }, projectId, revision))
    }
    if (path.endsWith(`${base}/materials`)) {
      return jsonResponse(readEnvelope({ materials: fixture.materials ?? [], nextCursor: null }, projectId, revision))
    }
    const detail = /\/materials\/([^/]+)(?:\/(segments|understanding))?$/.exec(path)
    if (detail !== null && path.includes(base)) {
      const materialId = decodeURIComponent(detail[1] as string)
      const kind = detail[2]
      const material = (fixture.materials ?? []).find((item) => item.materialId === materialId)
      if (material === undefined) return undefined
      const key = `${materialId}@${material.materialVersion}`
      if (kind === undefined) {
        return jsonResponse(readEnvelope({ material }, projectId, revision))
      }
      if (kind === 'segments') {
        return jsonResponse(
          readEnvelope(
            {
              materialId,
              materialVersion: material.materialVersion,
              isCurrent: material.isCurrent,
              readOnly: material.readOnly,
              segments: fixture.materialSegments?.[key] ?? [],
              nextCursor: null,
            },
            projectId,
            revision,
          ),
        )
      }
      return jsonResponse(
        readEnvelope(
          {
            materialId,
            materialVersion: material.materialVersion,
            isCurrent: material.isCurrent,
            readOnly: material.readOnly,
            items: fixture.materialItems?.[key] ?? [],
            nextCursor: null,
          },
          projectId,
          revision,
        ),
      )
    }
    return undefined
  }
}

/** 按请求体里的 requestId / projectId 回显包络，模拟真实后端 */
export function echoEnvelope(
  init: RequestInit,
  data: unknown,
  overrides: Partial<{
    projectId: string | null
    projectRevision: number | null
    replayed: boolean
    changed: boolean
  }> = {},
): Record<string, unknown> {
  const body = requestBody(init)
  return envelope(data, {
    requestId: String(body['requestId']),
    projectId: typeof body['projectId'] === 'string' ? body['projectId'] : null,
    projectRevision: typeof body['projectRevision'] === 'number' ? body['projectRevision'] : null,
    ...overrides,
  })
}
