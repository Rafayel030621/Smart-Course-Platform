import type { V3Database } from './db.js'
import { V3Error } from './errors.js'

/** 服务端重新读取后的权威材料片段；客户端传入的 name/行号/正文一律丢弃。 */
export interface GatedMaterialSegment {
  segmentId: string
  startLine: number
  endLine: number
  text: string
}

export interface GatedMaterial {
  materialId: string
  materialName: string
  materialVersion: number
  type: 'md' | 'txt'
  segments: GatedMaterialSegment[]
}

export interface ConfirmedMaterialInput {
  materialId: string
  name: string
  type: 'md' | 'txt'
  version: number
  segments: Array<{
    segmentId: string
    startLine: number
    endLine: number
    text: string
  }>
}

interface MaterialVersionRow {
  material_version: number
  name: string
  type: string
  status: string
  archived_at: string | null
}

interface SegmentRow {
  segment_id: string
  start_line: number
  end_line: number
  text: string
}

function parseSourceSegmentIds(json: string): Set<string> {
  const ids = new Set<string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return ids
  }
  if (!Array.isArray(parsed)) return ids
  for (const entry of parsed) {
    if (entry !== null && typeof entry === 'object') {
      const segmentId = (entry as Record<string, unknown>).segmentId
      if (typeof segmentId === 'string' && segmentId !== '') ids.add(segmentId)
    }
  }
  return ids
}

function confirmedSegmentIds(
  db: V3Database,
  projectId: string,
  materialId: string,
  materialVersion: number,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT sources_json FROM understanding_items
        WHERE project_id = ? AND material_id = ? AND material_version = ?
          AND status = 'confirmed'`,
    )
    .all(projectId, materialId, materialVersion) as Array<{ sources_json: string }>
  const ids = new Set<string>()
  for (const row of rows) {
    for (const id of parseSourceSegmentIds(row.sources_json)) ids.add(id)
  }
  return ids
}

function assertCurrentUnarchivedMaterial(
  db: V3Database,
  projectId: string,
  materialId: string,
  materialVersion: number,
): MaterialVersionRow {
  const current = db
    .prepare(
      `SELECT material_version, name, type, status, archived_at
         FROM materials
        WHERE project_id = ? AND material_id = ?
        ORDER BY material_version DESC LIMIT 1`,
    )
    .get(projectId, materialId) as MaterialVersionRow | undefined
  if (
    current === undefined ||
    current.material_version !== materialVersion ||
    current.archived_at !== null ||
    current.status === 'archived'
  ) {
    throw new V3Error('MATERIAL_VERSION_OUTDATED')
  }
  return current
}

/**
 * D15 门禁：客户端只提供材料/片段标识；名称、版本、行号、正文全部从数据库回填。
 * 只有被 confirmed 理解条目引用、且属于当前未归档材料版本的片段才有效。
 */
export function gateConfirmedMaterials(
  db: V3Database,
  projectId: string,
  confirmedMaterials: ConfirmedMaterialInput[],
  segmentIds: readonly string[],
): GatedMaterial[] {
  const requested = new Set(segmentIds)
  const declared = new Set<string>()
  for (const material of confirmedMaterials) {
    for (const segment of material.segments) declared.add(segment.segmentId)
  }
  for (const segmentId of requested) {
    if (!declared.has(segmentId)) throw new V3Error('UNCONFIRMED_MATERIAL')
  }

  const result: GatedMaterial[] = []
  for (const material of confirmedMaterials) {
    const current = assertCurrentUnarchivedMaterial(
      db,
      projectId,
      material.materialId,
      material.version,
    )
    const confirmed = confirmedSegmentIds(db, projectId, material.materialId, material.version)
    const segmentStatement = db.prepare(
      `SELECT segment_id, start_line, end_line, text
         FROM material_segments
        WHERE material_id = ? AND material_version = ? AND segment_id = ?`,
    )
    const segments: GatedMaterialSegment[] = []
    for (const declaredSegment of material.segments) {
      if (requested.size > 0 && !requested.has(declaredSegment.segmentId)) continue
      if (!confirmed.has(declaredSegment.segmentId)) {
        throw new V3Error('UNCONFIRMED_MATERIAL')
      }
      const row = segmentStatement.get(
        material.materialId,
        material.version,
        declaredSegment.segmentId,
      ) as SegmentRow | undefined
      if (row === undefined) throw new V3Error('UNCONFIRMED_MATERIAL')
      segments.push({
        segmentId: row.segment_id,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
      })
    }
    if (segments.length > 0) {
      result.push({
        materialId: material.materialId,
        materialName: current.name,
        materialVersion: material.version,
        type: current.type === 'txt' ? 'txt' : 'md',
        segments,
      })
    }
  }
  return result
}

/**
 * 阶段候选使用：从项目数据库读取当前未归档材料，以及被 confirmed 条目引用的片段。
 * 不读取客户端草稿，也不把未确认条目放入来源。
 */
export function loadProjectConfirmedMaterials(
  db: V3Database,
  projectId: string,
): GatedMaterial[] {
  const materials = db
    .prepare(
      `SELECT m.material_id, m.material_version, m.name, m.type
         FROM materials m
        WHERE m.project_id = ?
          AND m.material_version = (
            SELECT MAX(m2.material_version) FROM materials m2
             WHERE m2.project_id = m.project_id AND m2.material_id = m.material_id
          )
          AND m.archived_at IS NULL AND m.status != 'archived'
        ORDER BY m.created_at ASC, m.material_id ASC
        LIMIT 3`,
    )
    .all(projectId) as Array<{
    material_id: string
    material_version: number
    name: string
    type: string
  }>

  const result: GatedMaterial[] = []
  for (const material of materials) {
    const confirmed = confirmedSegmentIds(
      db,
      projectId,
      material.material_id,
      material.material_version,
    )
    if (confirmed.size === 0) continue
    const segments = db
      .prepare(
        `SELECT segment_id, start_line, end_line, text
           FROM material_segments
          WHERE material_id = ? AND material_version = ?
          ORDER BY idx ASC, segment_id ASC`,
      )
      .all(material.material_id, material.material_version) as SegmentRow[]
    const selected = segments
      .filter((segment) => confirmed.has(segment.segment_id))
      .slice(0, 20)
      .map((segment) => ({
        segmentId: segment.segment_id,
        startLine: segment.start_line,
        endLine: segment.end_line,
        text: segment.text,
      }))
    if (selected.length > 0) {
      result.push({
        materialId: material.material_id,
        materialName: material.name,
        materialVersion: material.material_version,
        type: material.type === 'txt' ? 'txt' : 'md',
        segments: selected,
      })
    }
  }
  return result
}

/** 把客户端结构替换为门禁后的权威结构；调用方不得继续使用原对象。 */
export function toConfirmedMaterials(materials: GatedMaterial[]): ConfirmedMaterialInput[] {
  return materials.map((material) => ({
    materialId: material.materialId,
    name: material.materialName,
    type: material.type,
    version: material.materialVersion,
    segments: material.segments.map((segment) => ({
      segmentId: segment.segmentId,
      startLine: segment.startLine,
      endLine: segment.endLine,
      text: segment.text,
    })),
  }))
}
