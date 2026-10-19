import type { ServerResponse } from 'node:http'
import type { V3Database } from './db.js'
import {
  loadProject,
  toUnderstandingItemDto,
  type MaterialRow,
  type UnderstandingItemRow,
} from './domain.js'
import { V3Error, invalidInput } from './errors.js'
import { parseLimit, queryParam, requirePositiveInteger, sendV3Json } from './http.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/**
 * 材料只读接口（PR2B 第一阶段）
 * ----------------------------------------------------------------------------
 * - 列表默认只返回每个 materialId 的当前版本；
 * - 单材料/片段/草稿可通过 version 读取旧版本，响应 readOnly=true；
 * - 旧版本和归档材料不会改变任何状态，也不递增 projectRevision。
 */

function includeArchived(url: URL): boolean {
  return queryParam(url, 'includeArchived') === 'true'
}

function parseVersion(url: URL): number | null {
  const raw = queryParam(url, 'version')
  if (raw === null) return null
  if (!/^\d+$/.test(raw)) throw invalidInput('version 必须是 ≥ 1 的整数')
  return requirePositiveInteger(Number(raw), 'version')
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('bad cursor')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw invalidInput('cursor 不合法')
  }
}

interface LoadedMaterial {
  material: MaterialRow
  currentVersion: number
  isCurrent: boolean
  currentArchived: boolean
  projectArchived: boolean
}

function isMaterialArchived(row: MaterialRow): boolean {
  return row.archived_at !== null || row.status === 'archived'
}

function loadMaterial(
  db: V3Database,
  projectId: string,
  materialId: string,
  requestedVersion: number | null,
  allowArchived: boolean,
  projectArchived: boolean,
): LoadedMaterial {
  const current = db
    .prepare(
      `SELECT * FROM materials
        WHERE project_id = ? AND material_id = ?
        ORDER BY material_version DESC LIMIT 1`,
    )
    .get(projectId, materialId) as MaterialRow | undefined
  if (current === undefined) throw new V3Error('RESOURCE_NOT_FOUND')

  const version = requestedVersion ?? current.material_version
  const row =
    version === current.material_version
      ? current
      : (db
          .prepare(
            `SELECT * FROM materials
              WHERE project_id = ? AND material_id = ? AND material_version = ?`,
          )
          .get(projectId, materialId, version) as MaterialRow | undefined)
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')

  const currentArchived = isMaterialArchived(current)
  if ((currentArchived || isMaterialArchived(row)) && !allowArchived) {
    throw new V3Error('RESOURCE_NOT_FOUND')
  }

  return {
    material: row,
    currentVersion: current.material_version,
    isCurrent: row.material_version === current.material_version,
    currentArchived,
    projectArchived,
  }
}

function toMaterialDto(loaded: LoadedMaterial): Record<string, unknown> {
  const { material, isCurrent, currentArchived, projectArchived } = loaded
  return {
    materialId: material.material_id,
    materialVersion: material.material_version,
    name: material.name,
    type: material.type,
    size: material.size,
    encoding: material.encoding,
    status: material.status,
    revision: material.revision,
    sha256: material.sha256,
    failureReason: material.failure_reason,
    createdAt: material.created_at,
    updatedAt: material.updated_at,
    archivedAt: material.archived_at,
    isCurrent,
    readOnly:
      !isCurrent || currentArchived || projectArchived || isMaterialArchived(material),
  }
}

export async function handleMaterialList(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const include = includeArchived(url)
  const limit = parseLimit(queryParam(url, 'limit'))
  const cursorRaw = queryParam(url, 'cursor')

  const conditions = [
    'm.project_id = ?',
    `m.material_version = (
       SELECT MAX(m2.material_version) FROM materials m2
        WHERE m2.project_id = m.project_id AND m2.material_id = m.material_id
     )`,
    "(? = 1 OR (m.archived_at IS NULL AND m.status != 'archived'))",
  ]
  const params: Array<string | number> = [projectId, include ? 1 : 0]

  if (cursorRaw !== null) {
    const cursor = decodeCursor(cursorRaw)
    if (typeof cursor.updatedAt !== 'string' || typeof cursor.materialId !== 'string') {
      throw invalidInput('cursor 不合法')
    }
    conditions.push(
      '(m.updated_at < ? OR (m.updated_at = ? AND m.material_id < ?))',
    )
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.materialId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT m.* FROM materials m
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.updated_at DESC, m.material_id DESC
        LIMIT ?`,
    )
    .all(...params) as MaterialRow[]

  const items = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          updatedAt: items[items.length - 1]?.updated_at,
          materialId: items[items.length - 1]?.material_id,
        })
      : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: {
      materials: items.map((row) =>
        toMaterialDto({
          material: row,
          currentVersion: row.material_version,
          isCurrent: true,
          currentArchived: isMaterialArchived(row),
          projectArchived: project.status === 'archived',
        }),
      ),
      nextCursor,
    },
  })
}

export async function handleMaterialGet(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const loaded = loadMaterial(
    db,
    projectId,
    materialId,
    parseVersion(url),
    includeArchived(url),
    project.status === 'archived',
  )

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: { material: toMaterialDto(loaded) },
  })
}

interface SegmentRow {
  material_id: string
  material_version: number
  segment_id: string
  idx: number
  start_line: number
  end_line: number
  text: string
  char_count: number
  created_at: string
}

export async function handleMaterialSegments(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const loaded = loadMaterial(
    db,
    projectId,
    materialId,
    parseVersion(url),
    includeArchived(url),
    project.status === 'archived',
  )
  const limit = parseLimit(queryParam(url, 'limit'), 100, 200)
  const cursorRaw = queryParam(url, 'cursor')

  const conditions = [
    's.material_id = ?',
    's.material_version = ?',
    'm.project_id = ?',
  ]
  const params: Array<string | number> = [
    materialId,
    loaded.material.material_version,
    projectId,
  ]
  if (cursorRaw !== null) {
    const cursor = decodeCursor(cursorRaw)
    if (typeof cursor.idx !== 'number' || typeof cursor.segmentId !== 'string') {
      throw invalidInput('cursor 不合法')
    }
    conditions.push('(s.idx > ? OR (s.idx = ? AND s.segment_id > ?))')
    params.push(cursor.idx, cursor.idx, cursor.segmentId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT s.* FROM material_segments s
         JOIN materials m
           ON m.material_id = s.material_id
          AND m.material_version = s.material_version
        WHERE ${conditions.join(' AND ')}
        ORDER BY s.idx ASC, s.segment_id ASC
        LIMIT ?`,
    )
    .all(...params) as SegmentRow[]

  const items = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          idx: items[items.length - 1]?.idx,
          segmentId: items[items.length - 1]?.segment_id,
        })
      : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: {
      materialId,
      materialVersion: loaded.material.material_version,
      isCurrent: loaded.isCurrent,
      readOnly:
        !loaded.isCurrent ||
        loaded.currentArchived ||
        loaded.projectArchived ||
        isMaterialArchived(loaded.material),
      segments: items.map((row) => ({
        segmentId: row.segment_id,
        materialId: row.material_id,
        materialVersion: row.material_version,
        index: row.idx,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        charCount: row.char_count,
        status: loaded.isCurrent ? 'active' : 'superseded',
        createdAt: row.created_at,
      })),
      nextCursor,
    },
  })
}

export async function handleMaterialUnderstanding(
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  url: URL,
): Promise<void> {
  const db = runtime.getDb()
  const project = loadProject(db, auth.user.user_id, projectId)
  const loaded = loadMaterial(
    db,
    projectId,
    materialId,
    parseVersion(url),
    includeArchived(url),
    project.status === 'archived',
  )
  const include = includeArchived(url)
  const limit = parseLimit(queryParam(url, 'limit'), 100, 200)
  const cursorRaw = queryParam(url, 'cursor')

  const conditions = ['project_id = ?', 'material_id = ?', 'material_version = ?']
  const params: Array<string | number> = [
    projectId,
    materialId,
    loaded.material.material_version,
  ]
  if (!include) conditions.push("status != 'archived'")
  if (cursorRaw !== null) {
    const cursor = decodeCursor(cursorRaw)
    if (typeof cursor.createdAt !== 'string' || typeof cursor.itemId !== 'string') {
      throw invalidInput('cursor 不合法')
    }
    conditions.push(
      '(created_at > ? OR (created_at = ? AND item_id > ?))',
    )
    params.push(cursor.createdAt, cursor.createdAt, cursor.itemId)
  }
  params.push(limit + 1)

  const rows = db
    .prepare(
      `SELECT * FROM understanding_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at ASC, item_id ASC
        LIMIT ?`,
    )
    .all(...params) as UnderstandingItemRow[]

  const items = rows.slice(0, limit)
  const nextCursor =
    rows.length > limit && items.length > 0
      ? encodeCursor({
          createdAt: items[items.length - 1]?.created_at,
          itemId: items[items.length - 1]?.item_id,
        })
      : null

  sendV3Json(res, 200, {
    contractVersion: '3.0',
    projectId,
    projectRevision: project.project_revision,
    data: {
      materialId,
      materialVersion: loaded.material.material_version,
      isCurrent: loaded.isCurrent,
      readOnly:
        !loaded.isCurrent ||
        loaded.currentArchived ||
        loaded.projectArchived ||
        isMaterialArchived(loaded.material),
      items: items.map((item) =>
        toUnderstandingItemDto(db, item, loaded.material.name),
      ),
      nextCursor,
    },
  })
}
