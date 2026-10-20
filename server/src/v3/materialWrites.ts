import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  assertProjectWritable,
  bumpProjectRevision,
  loadProject,
  requiredText,
  type MaterialRow,
  type ProjectRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import {
  bodyReadError,
  readJsonBody,
  requireContractVersion,
  requireIdempotencyKey,
  requirePositiveInteger,
  requireRecord,
  requireRequestId,
  sendV3Json,
  successBody,
  type WriteEnvelope,
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import { newId } from './ids.js'
import {
  MATERIAL_LIMITS,
  decodeBase64Strict,
  decodeMaterialText,
  materialTypeFromName,
} from '../materials/validation.js'
import { MATERIAL_ERROR_MESSAGES } from '../materials/types.js'
import { parseText } from '../materials/parseText.js'
import {
  isMaterialArchived,
  toMaterialDto,
  toSegmentDto,
  type SegmentRow,
} from './materialReads.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/**
 * V3 材料写入（PR2 材料写链路）
 * - materialId / materialVersion 只由服务端生成；
 * - 上传和重新解析都在单事务内写 materials + material_segments + content_text；
 * - 同项目 sha256 重复上传直接返回既有材料，不新建版本；
 * - 归档项目在 loadProject 后统一返回 PROJECT_ARCHIVED。
 */

const RESPONSE_SEGMENT_LIMIT = 20

interface ParsedUpload {
  name: string
  type: 'md' | 'txt'
  size: number
  encoding: 'utf-8' | 'gbk'
  sha256: string
  contentText: string
  segments: ReturnType<typeof parseText>
  failureReason: string | null
}

async function readUploadBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, MATERIAL_LIMITS.uploadBodyBytes))
  } catch (error) {
    throw bodyReadError(error)
  }
}

async function readSmallBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

/**
 * 材料写接口允许省略 body.projectId（路径已提供）；省略按路径处理，
 * 显式提供时仍必须与路径一致。其余字段沿用统一写信封。
 */
function readMaterialEnvelope(
  body: Record<string, unknown>,
  projectId: string,
): WriteEnvelope {
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  if (body.projectId !== undefined && body.projectId !== projectId) {
    throw invalidInput('projectId 与路径不一致')
  }
  const projectRevision = requirePositiveInteger(body.projectRevision, 'projectRevision')
  return { requestId, idempotencyKey, projectId, projectRevision, expectedRevision: null }
}

function parseUpload(body: Record<string, unknown>): ParsedUpload {
  const name = requiredText(body.name, MATERIAL_LIMITS.nameLength, 'name')
  const type = materialTypeFromName(name)
  if (type === null) throw new V3Error('UNSUPPORTED_MATERIAL_TYPE')

  const rawContent = body.contentBase64
  if (typeof rawContent !== 'string') {
    throw invalidInput('contentBase64 必须是字符串')
  }
  const contentBase64 = rawContent.trim()
  const bytes =
    contentBase64 === '' ? Buffer.alloc(0) : decodeBase64Strict(contentBase64)
  if (bytes === null) throw invalidInput('contentBase64 不是合法的 base64')
  if (bytes.length > MATERIAL_LIMITS.maxFileBytes) {
    throw new V3Error('MATERIAL_TOO_LARGE')
  }

  const decoded = decodeMaterialText(bytes)
  if (decoded === null) throw new V3Error('MATERIAL_ENCODING_UNREADABLE')
  if (decoded.text.includes('\u0000')) throw new V3Error('UNSUPPORTED_MATERIAL_TYPE')
  if (decoded.text.trim() === '') throw new V3Error('EMPTY_MATERIAL')

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let segments: ReturnType<typeof parseText> = []
  let failureReason: string | null = null
  try {
    segments = parseText(decoded.text)
    if (segments.length === 0) {
      failureReason = MATERIAL_ERROR_MESSAGES.MATERIAL_PARSE_FAILED
    }
  } catch {
    failureReason = MATERIAL_ERROR_MESSAGES.MATERIAL_PARSE_FAILED
  }

  return {
    name,
    type,
    size: bytes.length,
    encoding: decoded.encoding,
    sha256,
    contentText: decoded.text,
    segments,
    failureReason,
  }
}

function findCurrentMaterial(
  db: V3Database,
  projectId: string,
  materialId: string,
): MaterialRow | null {
  const row = db
    .prepare(
      `SELECT * FROM materials
        WHERE project_id = ? AND material_id = ?
        ORDER BY material_version DESC LIMIT 1`,
    )
    .get(projectId, materialId) as MaterialRow | undefined
  return row ?? null
}

function requireCurrentMaterial(
  db: V3Database,
  projectId: string,
  materialId: string,
): MaterialRow {
  const row = findCurrentMaterial(db, projectId, materialId)
  if (row === null) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

function materialDtoForRow(
  db: V3Database,
  project: ProjectRow,
  row: MaterialRow,
): { dto: Record<string, unknown>; isCurrent: boolean } {
  const current = findCurrentMaterial(db, project.project_id, row.material_id)
  if (current === null) throw new V3Error('RESOURCE_NOT_FOUND')
  return {
    dto: toMaterialDto({
      material: row,
      currentVersion: current.material_version,
      isCurrent: row.material_version === current.material_version,
      currentArchived: isMaterialArchived(current),
      projectArchived: project.status === 'archived',
    }),
    isCurrent: row.material_version === current.material_version,
  }
}

function segmentRows(
  db: V3Database,
  row: MaterialRow,
): { segments: SegmentRow[]; segmentCount: number } {
  const segments = db
    .prepare(
      `SELECT * FROM material_segments
        WHERE material_id = ? AND material_version = ?
        ORDER BY idx ASC, segment_id ASC
        LIMIT ?`,
    )
    .all(row.material_id, row.material_version, RESPONSE_SEGMENT_LIMIT) as SegmentRow[]
  const count = db
    .prepare(
      'SELECT COUNT(*) AS count FROM material_segments WHERE material_id = ? AND material_version = ?',
    )
    .get(row.material_id, row.material_version) as { count: number }
  return { segments, segmentCount: count.count }
}

function materialPayload(
  db: V3Database,
  project: ProjectRow,
  row: MaterialRow,
  requestId: string,
  projectRevision: number,
  deduplicated: boolean,
): Record<string, unknown> {
  const { dto, isCurrent } = materialDtoForRow(db, project, row)
  const { segments, segmentCount } = segmentRows(db, row)
  return successBody(requestId, project.project_id, {
    projectRevision,
    replayed: false,
    data: {
      material: dto,
      segments: segments.map((segment) => toSegmentDto(segment, isCurrent)),
      segmentCount,
      deduplicated,
    },
  })
}

function insertMaterial(
  db: V3Database,
  input: {
    materialId: string
    materialVersion: number
    projectId: string
    userId: string
    name: string
    type: string
    size: number
    encoding: string
    status: string
    sha256: string | null
    failureReason: string | null
    contentText: string
    nowText: string
  },
): void {
  db.prepare(
    `INSERT INTO materials
       (material_id, material_version, project_id, user_id, name, type, size, encoding,
        status, revision, sha256, failure_reason, created_at, updated_at, archived_at,
        content_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    input.materialId,
    input.materialVersion,
    input.projectId,
    input.userId,
    input.name,
    input.type,
    input.size,
    input.encoding,
    input.status,
    input.sha256,
    input.failureReason,
    input.nowText,
    input.nowText,
    input.contentText,
  )
}

function insertSegments(
  db: V3Database,
  materialId: string,
  materialVersion: number,
  segments: ReturnType<typeof parseText>,
  nowText: string,
): void {
  const statement = db.prepare(
    `INSERT INTO material_segments
       (material_id, material_version, segment_id, idx, start_line, end_line, text, char_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const segment of segments) {
    statement.run(
      materialId,
      materialVersion,
      segment.segmentId,
      segment.index,
      segment.startLine,
      segment.endLine,
      segment.text,
      [...segment.text].length,
      nowText,
    )
  }
}

export async function handleMaterialUpload(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
): Promise<void> {
  const body = await readUploadBody(req)
  const envelope = readMaterialEnvelope(body, projectId)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'material.upload',
    resource: projectId,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  // 项目存在性、归档状态和版本校验先于内容校验：
  // 他人项目不能被 base64/编码错误探测，归档项目必须先返回 PROJECT_ARCHIVED。
  const project = loadProject(db, userId, projectId)
  assertProjectWritable(project)
  assertProjectRevision(project, envelope.projectRevision)

  const parsed = parseUpload(body)
  const existing = db
    .prepare(
      `SELECT m.* FROM materials m
        WHERE m.project_id = ? AND m.sha256 = ?
          AND m.material_version = (
            SELECT MAX(m2.material_version)
              FROM materials m2
             WHERE m2.project_id = m.project_id
               AND m2.material_id = m.material_id
          )
          AND m.archived_at IS NULL AND m.status != 'archived'
        ORDER BY m.created_at DESC
        LIMIT 1`,
    )
    .get(projectId, parsed.sha256) as MaterialRow | undefined

  if (existing !== undefined) {
    const response = transaction(db, () => {
      const payload = materialPayload(
        db,
        project,
        existing,
        envelope.requestId,
        project.project_revision,
        true,
      )
      saveIdempotent(
        db,
        userId,
        envelope.idempotencyKey,
        fingerprint,
        200,
        payload,
        nowText,
      )
      return payload
    })
    sendV3Json(res, 200, response)
    return
  }

  const materialId = newId('mat', now.getTime())
  const status = parsed.failureReason === null ? 'parsed' : 'parse_failed'
  const response = transaction(db, () => {
    insertMaterial(db, {
      materialId,
      materialVersion: 1,
      projectId,
      userId,
      name: parsed.name,
      type: parsed.type,
      size: parsed.size,
      encoding: parsed.encoding,
      status,
      sha256: parsed.sha256,
      failureReason: parsed.failureReason,
      contentText: parsed.contentText,
      nowText,
    })
    insertSegments(db, materialId, 1, parsed.segments, nowText)
    const projectRevision = bumpProjectRevision(db, projectId, nowText)
    const row = requireCurrentMaterial(db, projectId, materialId)
    const payload = materialPayload(
      db,
      project,
      row,
      envelope.requestId,
      projectRevision,
      false,
    )
    saveIdempotent(
      db,
      userId,
      envelope.idempotencyKey,
      fingerprint,
      200,
      payload,
      nowText,
    )
    return payload
  })

  sendV3Json(res, 200, response)
}

function parseSegmentsOrFailure(text: string): {
  segments: ReturnType<typeof parseText>
  failureReason: string | null
} {
  try {
    const segments = parseText(text)
    if (segments.length === 0) {
      return { segments: [], failureReason: MATERIAL_ERROR_MESSAGES.MATERIAL_PARSE_FAILED }
    }
    return { segments, failureReason: null }
  } catch {
    return { segments: [], failureReason: MATERIAL_ERROR_MESSAGES.MATERIAL_PARSE_FAILED }
  }
}

async function handleMaterialStateAction(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  action: 'archive' | 'restore',
): Promise<void> {
  const body = await readSmallBody(req)
  const envelope = readMaterialEnvelope(body, projectId)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: `material.${action}`,
    resource: `${projectId}/${materialId}`,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectWritable(project)
  assertProjectRevision(project, envelope.projectRevision)
  const current = requireCurrentMaterial(db, projectId, materialId)
  const archived = isMaterialArchived(current)

  if (action === 'archive' && archived) {
    throw new V3Error('INVALID_STATE_TRANSITION')
  }
  if (action === 'restore' && !archived) {
    throw new V3Error('INVALID_STATE_TRANSITION')
  }

  const response = transaction(db, () => {
    let nextStatus: string
    if (action === 'archive') {
      nextStatus = 'archived'
    } else {
      const segments = db
        .prepare(
          'SELECT COUNT(*) AS count FROM material_segments WHERE material_id = ? AND material_version = ?',
        )
        .get(materialId, current.material_version) as { count: number }
      nextStatus =
        segments.count > 0
          ? 'parsed'
          : current.failure_reason !== null
            ? 'parse_failed'
            : current.type === 'md' || current.type === 'txt'
              ? 'registered'
              : 'unsupported'
    }
    db.prepare(
      `UPDATE materials
          SET status = ?, archived_at = ?, revision = revision + 1, updated_at = ?
        WHERE project_id = ? AND material_id = ? AND material_version = ?`,
    ).run(
      nextStatus,
      action === 'archive' ? nowText : null,
      nowText,
      projectId,
      materialId,
      current.material_version,
    )
    const projectRevision = bumpProjectRevision(db, projectId, nowText)
    const updated = requireCurrentMaterial(db, projectId, materialId)
    const payload = successBody(envelope.requestId, projectId, {
      projectRevision,
      replayed: false,
      data: { material: materialDtoForRow(db, project, updated).dto },
    })
    saveIdempotent(
      db,
      userId,
      envelope.idempotencyKey,
      fingerprint,
      200,
      payload,
      nowText,
    )
    return payload
  })

  sendV3Json(res, 200, response)
}

export async function handleMaterialArchive(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
): Promise<void> {
  await handleMaterialStateAction(req, res, runtime, auth, projectId, materialId, 'archive')
}

export async function handleMaterialRestore(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
): Promise<void> {
  await handleMaterialStateAction(req, res, runtime, auth, projectId, materialId, 'restore')
}

export async function handleMaterialReparse(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
): Promise<void> {
  const body = await readSmallBody(req)
  const envelope = readMaterialEnvelope(body, projectId)
  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const userId = auth.user.user_id
  const fingerprint = requestFingerprint({
    method: 'POST',
    operation: 'material.reparse',
    resource: `${projectId}/${materialId}`,
    body,
  })

  const replay = lookupIdempotent(db, userId, envelope.idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    sendV3Json(res, replay.statusCode, replay.body)
    return
  }

  const project = loadProject(db, userId, projectId)
  assertProjectWritable(project)
  assertProjectRevision(project, envelope.projectRevision)
  const current = requireCurrentMaterial(db, projectId, materialId)
  if (isMaterialArchived(current)) {
    throw new V3Error('INVALID_STATE_TRANSITION')
  }
  if (current.content_text === null) {
    throw new V3Error('MATERIAL_CONTENT_UNAVAILABLE')
  }

  const parsed = parseSegmentsOrFailure(current.content_text)
  const nextVersion = current.material_version + 1
  const status = parsed.failureReason === null ? 'parsed' : 'parse_failed'
  const response = transaction(db, () => {
    insertMaterial(db, {
      materialId,
      materialVersion: nextVersion,
      projectId,
      userId,
      name: current.name,
      type: current.type,
      size: current.size,
      encoding: current.encoding,
      status,
      sha256: current.sha256,
      failureReason: parsed.failureReason,
      contentText: current.content_text as string,
      nowText,
    })
    insertSegments(db, materialId, nextVersion, parsed.segments, nowText)
    const projectRevision = bumpProjectRevision(db, projectId, nowText)
    const row = requireCurrentMaterial(db, projectId, materialId)
    const payload = materialPayload(
      db,
      project,
      row,
      envelope.requestId,
      projectRevision,
      false,
    )
    saveIdempotent(
      db,
      userId,
      envelope.idempotencyKey,
      fingerprint,
      200,
      payload,
      nowText,
    )
    return payload
  })

  sendV3Json(res, 200, response)
}
