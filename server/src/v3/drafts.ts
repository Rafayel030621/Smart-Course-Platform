import type { IncomingMessage, ServerResponse } from 'node:http'
import { transaction, type V3Database } from './db.js'
import {
  assertProjectRevision,
  bumpProjectRevision,
  loadProject,
  requiredText,
  type MaterialRow,
  type UnderstandingItemRow,
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
} from './http.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from './idempotency.js'
import type { AuthContext } from './auth.js'
import type { V3Runtime } from './runtime.js'

/**
 * 材料理解草稿五动作（docs/contracts.md 22.7 / v3.2）
 * ----------------------------------------------------------------------------
 * 确认、修改、移除、撤销确认、整份确认。
 * 所有写操作在单事务内完成；projectRevision 一次成功请求只 +1 一次。
 */

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return requireRecord(await readJsonBody(req, 256 * 1024))
  } catch (error) {
    throw bodyReadError(error)
  }
}

interface DraftContext {
  db: V3Database
  runtime: V3Runtime
  auth: AuthContext
  projectId: string
  materialId: string
  body: Record<string, unknown>
  requestId: string
  idempotencyKey: string
  projectRevision: number
  materialVersion: number
  material: MaterialRow
  fingerprint: string
  nowText: string
}

function loadCurrentMaterial(
  db: V3Database,
  projectId: string,
  materialId: string,
): MaterialRow {
  const row = db
    .prepare(
      `SELECT * FROM materials
        WHERE project_id = ? AND material_id = ?
        ORDER BY material_version DESC LIMIT 1`,
    )
    .get(projectId, materialId) as MaterialRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

interface SegmentRow {
  segment_id: string
  material_id: string
  material_version: number
  start_line: number
  end_line: number
  text: string
}

function requestedSegmentIds(item: UnderstandingItemRow): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(item.sources_json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids = parsed
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    .map((entry) => (typeof entry.segmentId === 'string' ? entry.segmentId : ''))
    .filter((segmentId) => segmentId !== '')
  return [...new Set(ids)]
}

/**
 * 只信任数据库中与条目 materialId + materialVersion 匹配的真实片段。
 * sources_json 中的 materialId、版本、行号都不可信。
 */
function resolveValidSegments(db: V3Database, item: UnderstandingItemRow): SegmentRow[] {
  const statement = db.prepare(
    `SELECT segment_id, material_id, material_version, start_line, end_line, text
       FROM material_segments
      WHERE material_id = ? AND material_version = ? AND segment_id = ?
        AND length(trim(text)) > 0`,
  )
  const segments: SegmentRow[] = []
  for (const segmentId of requestedSegmentIds(item)) {
    const row = statement.get(
      item.material_id,
      item.material_version,
      segmentId,
    ) as SegmentRow | undefined
    if (row !== undefined) segments.push(row)
  }
  return segments
}

function assertItemHasValidSource(db: V3Database, item: UnderstandingItemRow): void {
  if (resolveValidSegments(db, item).length === 0) {
    throw new V3Error('DRAFT_SOURCE_MISSING')
  }
}

function itemDto(db: V3Database, item: UnderstandingItemRow, materialName: string): Record<string, unknown> {
  const sources = resolveValidSegments(db, item).map((segment) => ({
    materialId: item.material_id,
    materialName,
    materialVersion: item.material_version,
    segmentId: segment.segment_id,
    startLine: segment.start_line,
    endLine: segment.end_line,
  }))

  return {
    itemId: item.item_id,
    kind: item.kind,
    text: item.text,
    originalText: item.original_text,
    sources,
    status: item.status,
    revision: item.revision,
    confirmedAt: item.confirmed_at,
    confirmedByUserId: item.confirmed_by_user_id,
    removedAt: item.removed_at,
  }
}

async function prepare(
  req: IncomingMessage,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  options: { requireItem: boolean; operation: string; resource: string; method: 'POST' | 'PATCH' },
): Promise<{ ctx: DraftContext; expectedRevision: number; itemId: string | null }> {
  const body = await readBody(req)
  requireContractVersion(body)
  const requestId = requireRequestId(body)
  const idempotencyKey = requireIdempotencyKey(body)
  if (body.projectId !== projectId) throw invalidInput('projectId 与路径不一致')
  if (body.materialId !== undefined && body.materialId !== materialId) {
    throw new V3Error('RESOURCE_NOT_FOUND')
  }
  const projectRevision = requirePositiveInteger(body.projectRevision, 'projectRevision')
  const materialVersion = requirePositiveInteger(body.materialVersion, 'materialVersion')

  let expectedRevision = 0
  let itemId: string | null = null
  if (options.requireItem) {
    if (typeof body.itemId !== 'string' || body.itemId === '') {
      throw new V3Error('RESOURCE_NOT_FOUND')
    }
    itemId = body.itemId
    expectedRevision = requirePositiveInteger(body.expectedRevision, 'expectedRevision')
  }

  const db = runtime.getDb()
  const now = runtime.now()
  const nowText = now.toISOString()
  const fingerprint = requestFingerprint({
    method: options.method,
    operation: options.operation,
    resource: options.resource,
    body,
  })

  // 契约 20.6：幂等查询先于版本校验
  const replay = lookupIdempotent(db, auth.user.user_id, idempotencyKey, fingerprint, nowText)
  if (replay !== null) {
    throw new ReplayResponse(replay.statusCode, replay.body)
  }

  const project = loadProject(db, auth.user.user_id, projectId)
  assertProjectRevision(project, projectRevision)
  const material = loadCurrentMaterial(db, projectId, materialId)
  if (material.material_version !== materialVersion) {
    throw new V3Error('MATERIAL_VERSION_OUTDATED')
  }

  return {
    ctx: {
      db,
      runtime,
      auth,
      projectId,
      materialId,
      body,
      requestId,
      idempotencyKey,
      projectRevision,
      materialVersion,
      material,
      fingerprint,
      nowText,
    },
    expectedRevision,
    itemId,
  }
}

class ReplayResponse extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: Record<string, unknown>,
  ) {
    super('replay')
  }
}

function loadItem(
  db: V3Database,
  projectId: string,
  materialId: string,
  materialVersion: number,
  itemId: string,
): UnderstandingItemRow {
  const row = db
    .prepare(
      `SELECT * FROM understanding_items
        WHERE item_id = ? AND project_id = ? AND material_id = ? AND material_version = ?`,
    )
    .get(itemId, projectId, materialId, materialVersion) as UnderstandingItemRow | undefined
  if (row === undefined) throw new V3Error('RESOURCE_NOT_FOUND')
  return row
}

function assertExpectedRevision(item: UnderstandingItemRow, expectedRevision: number): void {
  if (item.revision !== expectedRevision) {
    throw new V3Error('STALE_REVISION', {
      currentProjectRevision: null,
      currentEntityRevision: item.revision,
    })
  }
}

function finish(
  ctx: DraftContext,
  changed: boolean,
  item: UnderstandingItemRow,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const projectRevision = changed
    ? bumpProjectRevision(ctx.db, ctx.projectId, ctx.nowText)
    : loadProject(ctx.db, ctx.auth.user.user_id, ctx.projectId).project_revision

  const payload = successBody(ctx.requestId, ctx.projectId, {
    projectRevision,
    replayed: false,
    data: {
      materialId: ctx.materialId,
      materialVersion: ctx.materialVersion,
      changed,
      item: itemDto(ctx.db, item, ctx.material.name),
      ...extra,
    },
  })
  saveIdempotent(
    ctx.db,
    ctx.auth.user.user_id,
    ctx.idempotencyKey,
    ctx.fingerprint,
    200,
    payload,
    ctx.nowText,
  )
  return payload
}

export type DraftAction = 'confirm' | 'edit' | 'remove' | 'undo'

export async function handleDraftItemAction(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
  itemId: string,
  action: DraftAction,
): Promise<void> {
  try {
    const { ctx, expectedRevision, itemId: bodyItemId } = await prepare(
      req,
      runtime,
      auth,
      projectId,
      materialId,
      {
        requireItem: true,
        method: action === 'edit' ? 'PATCH' : 'POST',
        operation: `draft.${action}`,
        resource: `${projectId}/${materialId}/${itemId}`,
      },
    )
    if (bodyItemId !== itemId) throw new V3Error('RESOURCE_NOT_FOUND')

    const response = transaction(ctx.db, () => {
      const item = loadItem(ctx.db, projectId, materialId, ctx.materialVersion, itemId)

      // undo 先校验 revision 再判断归档；其余动作归档优先
      if (action === 'undo') assertExpectedRevision(item, expectedRevision)
      if (item.status === 'archived') {
        if (action === 'remove') return finish(ctx, false, item)
        throw new V3Error('DRAFT_ITEM_ARCHIVED')
      }
      if (action !== 'undo') assertExpectedRevision(item, expectedRevision)

      if (action === 'confirm') {
        // 学生点击确认不能补足来源：必须有数据库中真实存在的片段。
        // 即使历史数据已是 confirmed，只要来源无效也拒绝返回成功。
        assertItemHasValidSource(ctx.db, item)
        if (item.status === 'confirmed') return finish(ctx, false, item)
        ctx.db.prepare(
          `UPDATE understanding_items
              SET status = 'confirmed', confirmed_at = ?, confirmed_by_user_id = ?,
                  revision = revision + 1, updated_at = ?
            WHERE item_id = ?`,
        ).run(ctx.nowText, ctx.auth.user.user_id, ctx.nowText, itemId)
      } else if (action === 'edit') {
        const text = requiredText(ctx.body.text, 300, 'text')
        if (text === item.text) return finish(ctx, false, item)
        ctx.db.prepare(
          `UPDATE understanding_items
              SET text = ?, status = 'modified', confirmed_at = NULL, confirmed_by_user_id = NULL,
                  revision = revision + 1, updated_at = ?
            WHERE item_id = ?`,
        ).run(text, ctx.nowText, itemId)
      } else if (action === 'remove') {
        ctx.db.prepare(
          `UPDATE understanding_items
              SET status = 'archived', removed_at = ?, confirmed_at = NULL, confirmed_by_user_id = NULL,
                  revision = revision + 1, updated_at = ?
            WHERE item_id = ?`,
        ).run(ctx.nowText, ctx.nowText, itemId)
      } else {
        if (item.status !== 'confirmed') return finish(ctx, false, item)
        const nextStatus = item.text === item.original_text ? 'pending' : 'modified'
        ctx.db.prepare(
          `UPDATE understanding_items
              SET status = ?, confirmed_at = NULL, confirmed_by_user_id = NULL,
                  revision = revision + 1, updated_at = ?
            WHERE item_id = ?`,
        ).run(nextStatus, ctx.nowText, itemId)
      }

      const updated = loadItem(ctx.db, projectId, materialId, ctx.materialVersion, itemId)
      return finish(ctx, true, updated)
    })

    sendV3Json(res, 200, response)
  } catch (error) {
    if (error instanceof ReplayResponse) {
      sendV3Json(res, error.statusCode, error.body)
      return
    }
    throw error
  }
}

interface ConfirmAllEntry {
  itemId: string
  expectedRevision: number
}

function readConfirmItems(body: Record<string, unknown>): ConfirmAllEntry[] {
  if (!Array.isArray(body.items)) throw invalidInput('items 必须是数组')
  if (body.items.length < 1 || body.items.length > 50) {
    throw invalidInput('items 需要 1～50 条')
  }
  const entries = body.items.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidInput('items 结构不合法')
    }
    const record = entry as Record<string, unknown>
    if (typeof record.itemId !== 'string' || record.itemId === '') {
      throw invalidInput('items.itemId 为必填项')
    }
    return {
      itemId: record.itemId,
      expectedRevision: requirePositiveInteger(record.expectedRevision, 'items.expectedRevision'),
    }
  })
  if (new Set(entries.map((entry) => entry.itemId)).size !== entries.length) {
    throw invalidInput('items 不能重复')
  }
  return entries
}

export async function handleConfirmAllDraft(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
  auth: AuthContext,
  projectId: string,
  materialId: string,
): Promise<void> {
  try {
    const { ctx } = await prepare(req, runtime, auth, projectId, materialId, {
      requireItem: false,
      method: 'POST',
      operation: 'draft.confirm-all',
      resource: `${projectId}/${materialId}`,
    })
    const entries = readConfirmItems(ctx.body)

    // 契约 22.7.2.2：所有版本与 revision 校验通过后才进入事务
    const rows = ctx.db
      .prepare(
        `SELECT * FROM understanding_items
          WHERE project_id = ? AND material_id = ? AND material_version = ?`,
      )
      .all(projectId, materialId, ctx.materialVersion) as UnderstandingItemRow[]

    const byId = new Map(rows.map((row) => [row.item_id, row]))
    for (const entry of entries) {
      if (!byId.has(entry.itemId)) throw new V3Error('RESOURCE_NOT_FOUND')
    }

    // archived 检查先于 revision 校验，且整单拒绝
    for (const entry of entries) {
      if (byId.get(entry.itemId)?.status === 'archived') {
        throw new V3Error('DRAFT_ITEM_ARCHIVED')
      }
    }

    const activeRows = rows.filter((row) => row.status !== 'archived')
    if (activeRows.length !== entries.length) {
      throw invalidInput('整份确认需要包含当前版本的全部理解条目')
    }
    const requested = new Set(entries.map((entry) => entry.itemId))
    for (const row of activeRows) {
      if (!requested.has(row.item_id)) {
        throw invalidInput('整份确认需要包含当前版本的全部理解条目')
      }
    }

    for (const entry of entries) {
      const item = byId.get(entry.itemId) as UnderstandingItemRow
      if (item.revision !== entry.expectedRevision) {
        throw new V3Error('STALE_REVISION', {
          currentProjectRevision: null,
          currentEntityRevision: item.revision,
        })
      }
    }

    // 任一条目没有真实来源就整单失败；此时尚未进入事务、尚未写入任何字段
    for (const entry of entries) {
      assertItemHasValidSource(ctx.db, byId.get(entry.itemId) as UnderstandingItemRow)
    }

    const response = transaction(ctx.db, () => {
      let confirmedCount = 0
      let skippedCount = 0
      for (const entry of entries) {
        const item = byId.get(entry.itemId) as UnderstandingItemRow
        if (item.status === 'confirmed') {
          skippedCount += 1
          continue
        }
        ctx.db.prepare(
          `UPDATE understanding_items
              SET status = 'confirmed', confirmed_at = ?, confirmed_by_user_id = ?,
                  revision = revision + 1, updated_at = ?
            WHERE item_id = ?`,
        ).run(ctx.nowText, ctx.auth.user.user_id, ctx.nowText, entry.itemId)
        confirmedCount += 1
      }

      const changed = confirmedCount > 0
      const projectRevision = changed
        ? bumpProjectRevision(ctx.db, projectId, ctx.nowText)
        : loadProject(ctx.db, auth.user.user_id, projectId).project_revision

      const finalRows = ctx.db
        .prepare(
          `SELECT * FROM understanding_items
            WHERE project_id = ? AND material_id = ? AND material_version = ?`,
        )
        .all(projectId, materialId, ctx.materialVersion) as UnderstandingItemRow[]
      const finalById = new Map(finalRows.map((row) => [row.item_id, row]))

      const payload = successBody(ctx.requestId, projectId, {
        projectRevision,
        replayed: false,
        data: {
          materialId,
          materialVersion: ctx.materialVersion,
          changed,
          confirmedCount,
          skippedCount,
          items: entries.map((entry) => {
            const item = finalById.get(entry.itemId) as UnderstandingItemRow
            return { itemId: item.item_id, status: item.status, revision: item.revision }
          }),
        },
      })
      saveIdempotent(
        ctx.db,
        auth.user.user_id,
        ctx.idempotencyKey,
        ctx.fingerprint,
        200,
        payload,
        ctx.nowText,
      )
      return payload
    })

    sendV3Json(res, 200, response)
  } catch (error) {
    if (error instanceof ReplayResponse) {
      sendV3Json(res, error.statusCode, error.body)
      return
    }
    throw error
  }
}
