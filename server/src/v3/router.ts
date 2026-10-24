import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleLogin, handleLogout, handleMe, handleRegister, requireAuth } from './auth.js'
import {
  handleEvidenceCreate,
  handleEvidenceLinks,
  handleEvidenceList,
} from './evidence.js'
import { V3Error, toFailureBody } from './errors.js'
import {
  getRecordedRequestId,
  getRecordedUserId,
  handleV3Cors,
  isV3Error,
  logCategoryFor,
  requireJsonContentType,
  sendV3Json,
} from './http.js'
import { safeUserRef, sanitizeLogFields } from './logger.js'
import { handleMigrateLocal, handleMigrationStatus } from './migration.js'
import {
  handleMilestoneAction,
  handleMilestoneCreate,
  handleMilestoneList,
  handleMilestonePatch,
  handleMilestoneReorder,
} from './milestones.js'
import { createMilestoneCandidatesHandler } from './milestoneCandidates.js'
import { handleProgressCreate, handleProgressList, handleProgressSupersede } from './progress.js'
import {
  handleProjectAction,
  handleProjectCreate,
  handleProjectGet,
  handleProjectList,
  handleProjectPatch,
} from './projects.js'
import {
  handleConfirmAllDraft,
  handleDraftItemAction,
  type DraftAction,
} from './drafts.js'
import {
  handleTaskAction,
  handleTaskCreate,
  handleTaskLinkMilestone,
  handleTaskPatch,
} from './tasks.js'
import { handleTaskGet, handleTaskList } from './taskReads.js'
import {
  handleMaterialGet,
  handleMaterialList,
  handleMaterialSegments,
  handleMaterialUnderstanding,
} from './materialReads.js'
import {
  handleMaterialArchive,
  handleMaterialReparse,
  handleMaterialRestore,
  handleMaterialUpload,
} from './materialWrites.js'
import type { V3Runtime } from './runtime.js'

/**
 * V3 路由
 * ----------------------------------------------------------------------------
 * 挂载在现有 V2 路由之后；只接管 /api/auth/* 与 /api/projects*，
 * 不改变 /api/advisor/*、/api/materials* 的行为。
 */

const PROJECT_ROUTE_PREFIX = '/api/projects'
const AUTH_ROUTE_PREFIX = '/api/auth'

function isV3Path(pathname: string): boolean {
  return (
    pathname === AUTH_ROUTE_PREFIX ||
    pathname.startsWith(`${AUTH_ROUTE_PREFIX}/`) ||
    pathname === PROJECT_ROUTE_PREFIX ||
    pathname.startsWith(`${PROJECT_ROUTE_PREFIX}/`)
  )
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new V3Error('RESOURCE_NOT_FOUND')
  }
}

function pathProjectId(segments: string[]): string | null {
  return segments[1] === 'projects' && segments.length >= 3 ? decodeSegment(segments[2] as string) : null
}

function assertMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new V3Error('RESOURCE_NOT_FOUND')
}

export async function handleV3Request(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: V3Runtime,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (!isV3Path(pathname)) return false

  const method = (req.method ?? 'GET').toUpperCase()
  const category = logCategoryFor(method, pathname)
  const startedAt = Date.now()
  const segments = pathname.split('/').filter((segment) => segment !== '')
  const projectId = pathProjectId(segments)

  // 成功请求只记录安全字段；失败请求由 catch 记录错误码
  res.once('finish', () => {
    if (res.statusCode >= 400) return
    runtime.logger.info(
      'v3 request completed',
      sanitizeLogFields({
        category,
        status: res.statusCode,
        requestId: getRecordedRequestId(req),
        userRef: safeUserRef(getRecordedUserId(req)),
        durationMs: Date.now() - startedAt,
      }),
    )
  })

  try {
    const cors = handleV3Cors(req, res, runtime.allowedOrigins)
    if (cors.handled) return true

    if (method !== 'GET' && method !== 'HEAD') requireJsonContentType(req)

    const db = runtime.getDb()
    const now = runtime.now()

    if (pathname === '/api/auth/register') {
      assertMethod(method, 'POST')
      await handleRegister(req, res, runtime)
      return true
    }
    if (pathname === '/api/auth/login') {
      assertMethod(method, 'POST')
      await handleLogin(req, res, runtime)
      return true
    }
    if (pathname === '/api/auth/logout') {
      assertMethod(method, 'POST')
      await handleLogout(req, res, runtime)
      return true
    }
    if (pathname === '/api/auth/me') {
      assertMethod(method, 'GET')
      handleMe(req, res, runtime)
      return true
    }
    // 未知 /api/auth/* 直接 404，不解析请求体，避免客户端文字进入日志上下文
    if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    const auth = requireAuth(db, req, now)

    if (pathname === '/api/projects') {
      if (method === 'GET') await handleProjectList(req, res, runtime, auth, url)
      else if (method === 'POST') await handleProjectCreate(req, res, runtime, auth)
      else throw new V3Error('RESOURCE_NOT_FOUND')
      return true
    }

    if (pathname === '/api/projects/migrate-local') {
      assertMethod(method, 'POST')
      await handleMigrateLocal(req, res, runtime, auth)
      return true
    }

    if (segments[0] === 'api' && segments[1] === 'projects' && segments[2] === 'migrations') {
      assertMethod(method, 'GET')
      const migrationId = decodeSegment(segments[3] ?? '')
      if (migrationId === '') throw new V3Error('RESOURCE_NOT_FOUND')
      await handleMigrationStatus(res, runtime, auth, migrationId)
      return true
    }

    if (projectId === null) throw new V3Error('RESOURCE_NOT_FOUND')
    const rest = segments.slice(3).map(decodeSegment)

    if (rest.length === 0) {
      if (method === 'GET') await handleProjectGet(res, runtime, auth, projectId)
      else if (method === 'PATCH') await handleProjectPatch(req, res, runtime, auth, projectId)
      else throw new V3Error('RESOURCE_NOT_FOUND')
      return true
    }

    if (rest.length === 1 && ['archive', 'restore', 'delete', 'restore-deleted'].includes(rest[0] as string)) {
      assertMethod(method, 'POST')
      await handleProjectAction(req, res, runtime, auth, projectId, rest[0] as string)
      return true
    }

    if (rest[0] === 'milestones') {
      if (rest.length === 1) {
        if (method === 'GET') await handleMilestoneList(res, runtime, auth, projectId, url)
        else if (method === 'POST') await handleMilestoneCreate(req, res, runtime, auth, projectId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }
      if (rest.length === 2 && rest[1] === 'candidates') {
        assertMethod(method, 'POST')
        await createMilestoneCandidatesHandler({
          runtime,
          provider: runtime.candidateProvider,
        })(req, res, auth, projectId)
        return true
      }
      if (rest.length === 2 && rest[1] === 'reorder') {
        assertMethod(method, 'POST')
        await handleMilestoneReorder(req, res, runtime, auth, projectId)
        return true
      }
      const milestoneId = rest[1] as string
      if (rest.length === 2) {
        assertMethod(method, 'PATCH')
        await handleMilestonePatch(req, res, runtime, auth, projectId, milestoneId)
        return true
      }
      if (rest.length === 3) {
        assertMethod(method, 'POST')
        await handleMilestoneAction(req, res, runtime, auth, projectId, milestoneId, rest[2] as string)
        return true
      }
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    if (rest[0] === 'tasks') {
      if (rest.length === 1) {
        if (method === 'GET') await handleTaskList(res, runtime, auth, projectId, url)
        else if (method === 'POST') await handleTaskCreate(req, res, runtime, auth, projectId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }
      const taskId = rest[1] as string
      if (rest.length === 2) {
        if (method === 'GET') await handleTaskGet(res, runtime, auth, projectId, taskId, url)
        else if (method === 'PATCH') await handleTaskPatch(req, res, runtime, auth, projectId, taskId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }
      if (rest.length === 3) {
        assertMethod(method, 'POST')
        const action = rest[2] as string
        if (action === 'link-milestone') {
          await handleTaskLinkMilestone(req, res, runtime, auth, projectId, taskId)
        } else {
          await handleTaskAction(req, res, runtime, auth, projectId, taskId, action)
        }
        return true
      }
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    if (rest[0] === 'progress') {
      if (rest.length === 1) {
        if (method === 'GET') await handleProgressList(res, runtime, auth, projectId, url)
        else if (method === 'POST') await handleProgressCreate(req, res, runtime, auth, projectId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }
      if (rest.length === 3 && rest[2] === 'supersede') {
        assertMethod(method, 'POST')
        await handleProgressSupersede(req, res, runtime, auth, projectId, rest[1] as string)
        return true
      }
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    if (rest[0] === 'evidence') {
      if (rest.length === 1) {
        if (method === 'GET') await handleEvidenceList(res, runtime, auth, projectId, url)
        else if (method === 'POST') await handleEvidenceCreate(req, res, runtime, auth, projectId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }
      if (rest.length === 3 && rest[2] === 'links') {
        assertMethod(method, 'POST')
        await handleEvidenceLinks(req, res, runtime, auth, projectId, rest[1] as string)
        return true
      }
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    if (rest[0] === 'materials') {
      const materialId = rest[1] as string | undefined
      if (materialId === undefined) {
        if (method === 'GET') await handleMaterialList(res, runtime, auth, projectId, url)
        else if (method === 'POST') await handleMaterialUpload(req, res, runtime, auth, projectId)
        else throw new V3Error('RESOURCE_NOT_FOUND')
        return true
      }

      if (rest.length === 2) {
        assertMethod(method, 'GET')
        await handleMaterialGet(res, runtime, auth, projectId, materialId, url)
        return true
      }

      if (rest[2] === 'segments' && rest.length === 3) {
        assertMethod(method, 'GET')
        await handleMaterialSegments(res, runtime, auth, projectId, materialId, url)
        return true
      }

      if (rest[2] === 'understanding' && rest.length === 3) {
        assertMethod(method, 'GET')
        await handleMaterialUnderstanding(res, runtime, auth, projectId, materialId, url)
        return true
      }

      if (rest.length === 3 && rest[2] === 'archive') {
        assertMethod(method, 'POST')
        await handleMaterialArchive(req, res, runtime, auth, projectId, materialId)
        return true
      }

      if (rest.length === 3 && rest[2] === 'restore') {
        assertMethod(method, 'POST')
        await handleMaterialRestore(req, res, runtime, auth, projectId, materialId)
        return true
      }

      if (rest.length === 3 && rest[2] === 'reparse') {
        assertMethod(method, 'POST')
        await handleMaterialReparse(req, res, runtime, auth, projectId, materialId)
        return true
      }

      if (rest[2] !== 'understanding') {
        throw new V3Error('RESOURCE_NOT_FOUND')
      }
      if (rest[3] === 'confirm-all' && rest.length === 4) {
        assertMethod(method, 'POST')
        await handleConfirmAllDraft(req, res, runtime, auth, projectId, materialId)
        return true
      }
      if (rest[3] === 'items' && rest.length >= 5) {
        const itemId = rest[4] as string
        if (rest.length === 5) {
          assertMethod(method, 'PATCH')
          await handleDraftItemAction(req, res, runtime, auth, projectId, materialId, itemId, 'edit')
          return true
        }
        if (rest.length === 6) {
          const action = rest[5] as DraftAction
          if (!['confirm', 'remove', 'undo'].includes(action)) {
            throw new V3Error('RESOURCE_NOT_FOUND')
          }
          assertMethod(method, 'POST')
          await handleDraftItemAction(req, res, runtime, auth, projectId, materialId, itemId, action)
          return true
        }
      }
      throw new V3Error('RESOURCE_NOT_FOUND')
    }

    throw new V3Error('RESOURCE_NOT_FOUND')
  } catch (error) {
    const v3Error = isV3Error(error) ? error : new V3Error('INTERNAL')
    const requestId = getRecordedRequestId(req)
    runtime.logger.warn(
      'v3 request failed',
      sanitizeLogFields({
        category,
        code: v3Error.code,
        status: v3Error.status,
        requestId,
        userRef: safeUserRef(getRecordedUserId(req)),
        durationMs: Date.now() - startedAt,
      }),
    )
    if (!res.headersSent) {
      sendV3Json(res, v3Error.status, toFailureBody(v3Error, requestId, v3Error.projectId ?? projectId))
    } else {
      res.end()
    }
    return true
  }
}
