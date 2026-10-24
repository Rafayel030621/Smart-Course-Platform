import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdvisorProvider } from '../advisor/types.js'
import { transaction } from './db.js'
import { assertProjectRevision, loadProject, type ProjectRow } from './domain.js'
import { invalidInput } from './errors.js'
import {
  bodyReadError,
  readJsonBody,
  requireRecord,
  requireWriteEnvelope,
  sendV3Json,
  successBody,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import { loadProjectConfirmedMaterials, type GatedMaterial } from './materialGate.js'
import type { V3Runtime } from './runtime.js'
import type { AuthContext } from './auth.js'
import type { AdvisorLogger, CandidateProviderInput } from '../advisor/types.js'
import { AdvisorProviderError, silentLogger } from '../advisor/types.js'

const CANDIDATE_TTL_MS = 30 * 60 * 1000
const CANDIDATE_MAX = 3
const CANDIDATE_TASKS_MAX = 5
const CANDIDATE_RISKS_MAX = 3

export interface MilestoneCandidateSource {
  materialId: string
  materialName: string
  materialVersion: number
  segmentId: string
  startLine: number
  endLine: number
  itemId: null
}

export interface MilestoneCandidate {
  candidateId: string
  name: string
  goal: string
  doneCriteria: string
  suggestedTasks: Array<{ title: string; doneCriteria: string }>
  risks: string[]
  sources: MilestoneCandidateSource[]
  expiresAt: string
}

interface CandidateDraft {
  name: string
  goal: string
  doneCriteria: string
  suggestedTasks: Array<{ title: string; doneCriteria: string }>
  risks: string[]
  sourceIds: string[]
}

export interface MilestoneCandidatesHandlerOptions {
  runtime: V3Runtime
  provider?: AdvisorProvider
  logger?: AdvisorLogger
  timeoutMs?: number
}

function readText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw invalidInput(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') throw invalidInput(`${field} 不能为空`)
  if (trimmed.length > max) throw invalidInput(`${field} 超过长度上限 ${max}`)
  return trimmed
}

function cleanOptional(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null) return null
  return readText(value, max, field)
}

function parseMaxCandidates(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > CANDIDATE_MAX) {
    throw invalidInput('maxCandidates 必须是 1～3 的整数')
  }
  return value
}

function sourceRefs(materials: GatedMaterial[]): MilestoneCandidateSource[] {
  const refs: MilestoneCandidateSource[] = []
  for (const material of materials) {
    for (const segment of material.segments) {
      refs.push({
        materialId: material.materialId,
        materialName: material.materialName,
        materialVersion: material.materialVersion,
        segmentId: segment.segmentId,
        startLine: segment.startLine,
        endLine: segment.endLine,
        itemId: null,
      })
    }
  }
  return refs
}

function refMap(materials: GatedMaterial[]): Map<string, MilestoneCandidateSource> {
  const map = new Map<string, MilestoneCandidateSource>()
  materials.forEach((material, materialIndex) => {
    material.segments.forEach((segment) => {
      const ref: MilestoneCandidateSource = {
        materialId: material.materialId,
        materialName: material.materialName,
        materialVersion: material.materialVersion,
        segmentId: segment.segmentId,
        startLine: segment.startLine,
        endLine: segment.endLine,
        itemId: null,
      }
      map.set(segment.segmentId, ref)
      map.set(`m${materialIndex + 1}:${segment.segmentId}`, ref)
    })
  })
  return map
}

function projectFocus(project: ProjectRow): string {
  try {
    const profile = JSON.parse(project.profile_json) as Record<string, unknown>
    if (typeof profile.goal === 'string' && profile.goal.trim() !== '') return profile.goal.trim()
  } catch {
    // 资料损坏时只用项目名
  }
  return project.name
}

function fallbackDrafts(
  project: ProjectRow,
  focus: string | null,
  maxCandidates: number,
  refs: MilestoneCandidateSource[],
): CandidateDraft[] {
  const focusText = focus ?? projectFocus(project)
  const drafts: CandidateDraft[] = [
    {
      name: `准备：${focusText.slice(0, 40)}`,
      goal: `围绕“${focusText}”完成可检查的准备工作，明确输入、口径和交付物。`,
      doneCriteria: '形成一份可复核的准备工作清单，并明确下一步的数据或资料缺口。',
      suggestedTasks: [
        {
          title: `梳理“${focusText.slice(0, 30)}”所需资料与口径`,
          doneCriteria: '列出输入资料、字段口径和两个需要确认的不确定点。',
        },
        {
          title: '整理样例并记录缺口',
          doneCriteria: '保存一份样例，记录缺失项和下一步处理方式。',
        },
      ],
      risks: ['规则候选未经过模型评估，需学生确认与项目方向是否一致。'],
      sourceIds: refs.slice(0, 3).map((ref) => ref.segmentId),
    },
  ]
  if (maxCandidates > 1) {
    drafts.push({
      name: `推进：${focusText.slice(0, 40)}`,
      goal: `在已有准备基础上推进“${focusText}”，形成一个可验证的结果。`,
      doneCriteria: '交付一个可检查的结果，并在证据中写清发现、限制和未解决问题。',
      suggestedTasks: [
        {
          title: '完成一轮最小可验证工作',
          doneCriteria: '产生可复核的结果，并记录关键参数或判断依据。',
        },
      ],
      risks: [],
      sourceIds: refs.slice(0, 3).map((ref) => ref.segmentId),
    })
  }
  return drafts.slice(0, maxCandidates)
}

function normalizeCandidateDraft(
  raw: unknown,
  refs: Map<string, MilestoneCandidateSource>,
  logger: AdvisorLogger,
): CandidateDraft | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  let name: string
  let goal: string
  let doneCriteria: string
  try {
    name = readText(item.name, 60, 'name')
    goal = readText(item.goal, 300, 'goal')
    doneCriteria = readText(item.doneCriteria, 300, 'doneCriteria')
  } catch {
    return null
  }

  const tasksRaw = Array.isArray(item.suggestedTasks) ? item.suggestedTasks : []
  const suggestedTasks: Array<{ title: string; doneCriteria: string }> = []
  for (const rawTask of tasksRaw.slice(0, CANDIDATE_TASKS_MAX)) {
    if (rawTask === null || typeof rawTask !== 'object' || Array.isArray(rawTask)) continue
    const task = rawTask as Record<string, unknown>
    try {
      suggestedTasks.push({
        title: readText(task.title, 100, 'suggestedTasks.title'),
        doneCriteria: readText(task.doneCriteria, 200, 'suggestedTasks.doneCriteria'),
      })
    } catch {
      // 单条任务不合法时丢弃，不影响整条候选
    }
  }
  if (suggestedTasks.length === 0) return null

  const risks: string[] = []
  const risksRaw = Array.isArray(item.risks) ? item.risks : []
  for (const rawRisk of risksRaw.slice(0, CANDIDATE_RISKS_MAX)) {
    if (typeof rawRisk === 'string' && rawRisk.trim() !== '' && rawRisk.trim().length <= 100) {
      risks.push(rawRisk.trim())
    }
  }

  const sourceIds: string[] = []
  const idsRaw = Array.isArray(item.segmentIds) ? item.segmentIds : []
  for (const rawId of idsRaw) {
    if (typeof rawId !== 'string') continue
    const id = rawId.trim()
    if (!refs.has(id)) {
      logger.warn('候选返回未知材料引用，已剔除', { segmentId: id })
      continue
    }
    if (!sourceIds.includes(id)) sourceIds.push(id)
    if (sourceIds.length >= 3) break
  }

  return { name, goal, doneCriteria, suggestedTasks, risks, sourceIds }
}

function fallbackReasonOf(error: unknown): string {
  if (error instanceof AdvisorProviderError) return error.reason
  return 'MODEL_UNAVAILABLE'
}

function buildCandidate(
  draft: CandidateDraft,
  refs: Map<string, MilestoneCandidateSource>,
  now: Date,
): MilestoneCandidate {
  const sources: MilestoneCandidateSource[] = []
  for (const id of draft.sourceIds) {
    const ref = refs.get(id)
    if (ref !== undefined && !sources.some((source) => source.segmentId === ref.segmentId)) {
      sources.push(ref)
    }
    if (sources.length >= 3) break
  }
  return {
    candidateId: newId('cand', now.getTime()),
    name: draft.name,
    goal: draft.goal,
    doneCriteria: draft.doneCriteria,
    suggestedTasks: draft.suggestedTasks,
    risks: draft.risks,
    sources,
    expiresAt: new Date(now.getTime() + CANDIDATE_TTL_MS).toISOString(),
  }
}

function loggerWarn(logger: AdvisorLogger, message: string, detail?: Record<string, unknown>): void {
  logger.warn(message, detail)
}

export function createMilestoneCandidatesHandler(
  options: MilestoneCandidatesHandlerOptions,
): (req: IncomingMessage, res: ServerResponse, auth: AuthContext, projectId: string) => Promise<void> {
  const { runtime, provider } = options
  const logger = options.logger ?? silentLogger
  const timeoutMs = options.timeoutMs ?? 20_000

  return async (req, res, auth, projectId): Promise<void> => {
    let body: Record<string, unknown>
    try {
      body = requireRecord(await readJsonBody(req, 256 * 1024))
    } catch (error) {
      throw bodyReadError(error)
    }
    const envelope = requireWriteEnvelope(body, projectId)
    if (body.promptVersion !== 'milestone-candidate-v1') {
      throw invalidInput('promptVersion 必须是 "milestone-candidate-v1"')
    }
    const maxCandidates = parseMaxCandidates(body.maxCandidates)
    const focus = cleanOptional(body.focus, 200, 'focus')

    const db = runtime.getDb()
    const now = runtime.now()
    const nowText = now.toISOString()
    const userId = auth.user.user_id
    const fingerprint = requestFingerprint({
      method: 'POST',
      operation: 'milestone.candidates',
      resource: projectId,
      body,
    })
    const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
    if (replay !== null) {
      sendV3Json(res, replay.statusCode, replay.body)
      return
    }

    const project = loadProject(db, userId, projectId)
    assertProjectRevision(project, envelope.projectRevision)
    const gatedMaterials = loadProjectConfirmedMaterials(db, projectId)
    const refs = refMap(gatedMaterials)
    const providerInput: CandidateProviderInput = {
      projectName: project.name,
      focus,
      maxCandidates,
      confirmedMaterials: gatedMaterials.map((material, index) => ({
        materialName: material.materialName,
        materialVersion: material.materialVersion,
        segments: material.segments.map((segment) => ({
          ref: `m${index + 1}:${segment.segmentId}`,
          startLine: segment.startLine,
          endLine: segment.endLine,
          text: segment.text,
        })),
      })),
    }

    let source: 'model' | 'fallback' = 'fallback'
    let fallbackReason: string | null = null
    let notice: string | null = null
    let drafts: CandidateDraft[] = []
    const generate = provider?.generateCandidates?.bind(provider)
    if (generate !== undefined) {
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          const handle = setTimeout(() => reject(new Error('timeout')), timeoutMs)
          handle.unref()
        })
        const output = await Promise.race([generate(providerInput), timeout])
        const list = Array.isArray(output.candidates) ? output.candidates : []
        drafts = list
          .slice(0, maxCandidates)
          .map((item) => normalizeCandidateDraft(item, refs, logger))
          .filter((item): item is CandidateDraft => item !== null)
        if (drafts.length > 0) {
          source = 'model'
        } else {
          fallbackReason = 'INVALID_MODEL_OUTPUT'
        }
      } catch (error) {
        fallbackReason = fallbackReasonOf(error)
      }
    } else {
      fallbackReason = 'MODEL_NOT_CONFIGURED'
    }

    if (source === 'fallback') {
      drafts = fallbackDrafts(project, focus, maxCandidates, sourceRefs(gatedMaterials))
      notice = '模型未参与，以下为按项目资料生成的规则候选，请学生确认后再创建阶段。'
    }

    const candidates = drafts.map((draft) => buildCandidate(draft, refs, now))
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision: project.project_revision,
      promptVersion: 'milestone-candidate-v1',
      source,
      fallbackReason,
      notice,
      candidates,
    })

    transaction(db, () => {
      const insert = db.prepare(
        `INSERT INTO milestone_candidates
           (candidate_id, project_id, user_id, name, goal, done_criteria,
            payload_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const candidate of candidates) {
        insert.run(
          candidate.candidateId,
          projectId,
          userId,
          candidate.name,
          candidate.goal,
          candidate.doneCriteria,
          JSON.stringify(candidate),
          candidate.expiresAt,
          nowText,
        )
      }
      saveIdempotent(db, userId, envelope.idempotencyKey, fingerprint, 200, payload, nowText)
    })

    if (notice !== null) loggerWarn(logger, '阶段候选使用规则兜底')
    sendV3Json(res, 200, payload)
  }
}
