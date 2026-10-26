import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FetchLike } from '../advisor/types.js'
import { createConsoleLogger, type AdvisorLogger } from '../advisor/types.js'
import type { PapersConfig } from '../config.js'
import { papersConfig as defaultPapersConfig } from '../config.js'
import { requireAuth } from '../v3/auth.js'
import { loadProject } from '../v3/domain.js'
import { invalidInput, V3Error } from '../v3/errors.js'
import { lookupIdempotent, requestFingerprint, saveIdempotent } from '../v3/idempotency.js'
import type { V3Runtime } from '../v3/runtime.js'
import { sendJson } from './health.js'

/**
 * GET /api/papers/search 的 HTTP 层（契约第 29 节）
 * ----------------------------------------------------------------------------
 * 服务端代理 OpenAlex；模型不参与，不生成、不补写论文字段。
 * 上游超时 / 5xx / 429 一律降级成 200 + fallback + 中文 notice + 空数组；
 * 只有项目不存在、参数非法、服务端缺配置才返回 4xx/5xx。
 */

export const PAPERS_SEARCH_PATH = '/api/papers/search'

const OPENALEX_WORKS_URL = 'https://api.openalex.org/works'
const OPENALEX_SELECT =
  'id,doi,display_name,publication_year,authorships,primary_location,cited_by_count,open_access'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MAX_QUERY_LENGTH = 200

const STATUS_BY_CODE = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  PROJECT_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  PAPERS_UPSTREAM_ERROR: 503,
  INTERNAL: 500,
} as const

const MESSAGE_BY_CODE = {
  INVALID_INPUT: '请求内容不合法',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  PROJECT_NOT_FOUND: '项目不存在或无权访问',
  IDEMPOTENCY_CONFLICT: '重复请求的内容不一致，请刷新后重试',
  PAPERS_UPSTREAM_ERROR: '论文检索暂不可用，请稍后重试',
  INTERNAL: '服务内部错误，请稍后重试',
} as const

const RETRYABLE_BY_CODE = {
  INVALID_INPUT: false,
  UNAUTHORIZED: false,
  PROJECT_NOT_FOUND: false,
  IDEMPOTENCY_CONFLICT: false,
  PAPERS_UPSTREAM_ERROR: true,
  INTERNAL: true,
} as const

type PapersFailureCode = keyof typeof STATUS_BY_CODE

export interface Paper {
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  openAccessUrl: string | null
  citedByCount: number
}

export interface PapersSuccessResponse {
  contractVersion: '3.0'
  requestId: string
  projectId: string
  source: 'openalex' | 'fallback'
  notice: string | null
  papers: Paper[]
}

export interface PapersFailureResponse {
  contractVersion: '3.0'
  requestId: string | null
  code: PapersFailureCode
  message: string
  retryable: boolean
  retryAfterSeconds: null
}

export interface PapersRouteOptions {
  runtime: V3Runtime
  logger?: AdvisorLogger
  /** 测试注入；不传时用进程启动时读取的配置 */
  papersConfig?: PapersConfig
  /** 测试注入 fetch；不传时用全局 fetch */
  fetchImpl?: FetchLike
}

interface SearchParams {
  projectId: string
  query: string
  limit: number
  requestId: string
}

type OpenAlexFetchResult =
  | { ok: true; works: unknown[]; attempts: number }
  | { ok: false; reason: 'timeout' | 'upstream' | 'rate-limited' | 'invalid'; attempts: number }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw invalidInput(`limit 必须是 1-${MAX_LIMIT} 的整数`)
  }
  return value
}

function parseSearchParams(url: URL): SearchParams {
  const contractVersion = url.searchParams.get('contractVersion')
  if (contractVersion !== '3.0') throw invalidInput('contractVersion 必须是 "3.0"')

  const requestId = url.searchParams.get('requestId')
  if (requestId === null || !UUID_V4.test(requestId)) {
    throw invalidInput('requestId 必须是 UUID')
  }

  const projectId = url.searchParams.get('projectId')
  if (projectId === null || projectId.trim() === '') {
    throw invalidInput('projectId 不能为空')
  }

  const query = url.searchParams.get('query')
  if (query === null || query.trim() === '') throw invalidInput('query 不能为空')
  const trimmedQuery = query.trim()
  if (trimmedQuery.length > MAX_QUERY_LENGTH) {
    throw invalidInput(`query 不能超过 ${MAX_QUERY_LENGTH} 字`)
  }

  return {
    projectId,
    query: trimmedQuery,
    limit: parseLimit(url.searchParams.get('limit')),
    requestId,
  }
}

function currentMilestoneName(runtime: V3Runtime, projectId: string, milestoneId: string | null): string | null {
  if (milestoneId === null) return null
  const row = runtime
    .getDb()
    .prepare('SELECT name FROM milestones WHERE milestone_id = ? AND project_id = ?')
    .get(milestoneId, projectId) as { name: string } | undefined
  return row?.name ?? null
}

/** 服务端组装最终检索词：项目名 + 当前阶段名 + 学生方向 */
function buildSearchTerm(
  projectName: string,
  milestoneName: string | null,
  query: string,
): string {
  return [projectName, milestoneName, query].filter((part) => part !== null && part !== '').join(' ')
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function fetchOpenAlexWorks(
  searchTerm: string,
  limit: number,
  config: PapersConfig,
  fetchImpl: FetchLike,
): Promise<OpenAlexFetchResult> {
  const url = new URL(OPENALEX_WORKS_URL)
  url.searchParams.set('search', searchTerm)
  url.searchParams.set('per-page', String(limit))
  url.searchParams.set('mailto', config.mailto ?? '')
  url.searchParams.set('select', OPENALEX_SELECT)

  // 超时后重试一次；仍失败才降级。5xx / 429 不重试，直接降级。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })

      if (!response.ok) {
        return {
          ok: false,
          reason: response.status === 429 ? 'rate-limited' : 'upstream',
          attempts: attempt,
        }
      }

      const payload = await readJsonSafely(response)
      const results = isPlainObject(payload) ? payload.results : undefined
      if (!Array.isArray(results)) {
        return { ok: false, reason: 'invalid', attempts: attempt }
      }
      return { ok: true, works: results, attempts: attempt }
    } catch {
      if (controller.signal.aborted) {
        if (attempt === 1) continue
        return { ok: false, reason: 'timeout', attempts: attempt }
      }
      // 网络错误等不重试：按上游不可用降级，不把细节带给学生
      return { ok: false, reason: 'upstream', attempts: attempt }
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, reason: 'timeout', attempts: 2 }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** 按契约 29.3 映射；无标题条目直接过滤，DOI 用于去重 */
export function normalizeOpenAlexWorks(works: unknown[], limit: number): Paper[] {
  const seen = new Set<string>()
  const papers: Paper[] = []

  for (const rawWork of works) {
    if (papers.length >= limit) break
    if (!isPlainObject(rawWork)) continue

    const title = asString(rawWork.display_name)
    if (title === null) continue

    const doi = asString(rawWork.doi)
    const dedupeKey = doi ?? asString(rawWork.id) ?? title
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const authorships = Array.isArray(rawWork.authorships) ? rawWork.authorships : []
    const authors: string[] = []
    for (const rawAuthorship of authorships) {
      if (!isPlainObject(rawAuthorship)) continue
      const author = isPlainObject(rawAuthorship.author) ? rawAuthorship.author : null
      const name = author === null ? null : asString(author.display_name)
      if (name !== null) authors.push(name)
    }

    const primaryLocation = isPlainObject(rawWork.primary_location) ? rawWork.primary_location : null
    const source = primaryLocation !== null && isPlainObject(primaryLocation.source)
      ? primaryLocation.source
      : null
    const openAccess = isPlainObject(rawWork.open_access) ? rawWork.open_access : null

    papers.push({
      title,
      authors,
      year: typeof rawWork.publication_year === 'number' ? rawWork.publication_year : null,
      venue: source === null ? null : asString(source.display_name),
      doi,
      openAccessUrl: openAccess === null ? null : asString(openAccess.oa_url),
      citedByCount: asCount(rawWork.cited_by_count),
    })
  }

  return papers
}

function noticeForReason(reason: 'timeout' | 'upstream' | 'rate-limited' | 'invalid'): string {
  if (reason === 'timeout') return '检索响应太慢，暂时没有找到论文，请稍后重试。'
  if (reason === 'rate-limited') return '检索太频繁了，稍等一下再试。'
  if (reason === 'upstream') return '检索服务暂时不可用，请稍后重试。'
  return '检索服务返回了无法识别的内容，暂时没有找到论文，请稍后重试。'
}

function sendPapersFailure(
  res: ServerResponse,
  code: PapersFailureCode,
  requestId: string | null,
  detail?: string,
): void {
  const body: PapersFailureResponse = {
    contractVersion: '3.0',
    requestId,
    code,
    message: detail === undefined ? MESSAGE_BY_CODE[code] : `${MESSAGE_BY_CODE[code]}：${detail}`,
    retryable: RETRYABLE_BY_CODE[code],
    retryAfterSeconds: null,
  }
  sendJson(res, STATUS_BY_CODE[code], body)
}

/** 创建论文检索处理器。返回 true 表示请求已被处理 */
export function createPapersHandler(
  options: PapersRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const logger = options.logger ?? createConsoleLogger('papers')
  const config = options.papersConfig ?? defaultPapersConfig
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))

  return async function handlePapers(req, res): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== PAPERS_SEARCH_PATH) return false
    if (req.method !== 'GET') {
      sendJson(res, 405, { status: 'error', message: `仅支持 GET ${PAPERS_SEARCH_PATH}` }, { allow: 'GET' })
      return true
    }

    let params: SearchParams | undefined
    try {
      params = parseSearchParams(url)
      const db = options.runtime.getDb()
      const auth = requireAuth(db, req, options.runtime.now())
      const project = loadProject(db, auth.user.user_id, params.projectId)

      const fingerprint = requestFingerprint({
        method: 'GET',
        operation: 'papers.search',
        resource: params.projectId,
        body: {
          contractVersion: '3.0',
          requestId: params.requestId,
          query: params.query,
          limit: params.limit,
        },
      })
      const nowText = options.runtime.now().toISOString()
      const replay = lookupIdempotent(
        db,
        auth.user.user_id,
        params.requestId,
        fingerprint,
        nowText,
      )
      if (replay !== null) {
        sendJson(res, replay.statusCode, replay.body)
        return true
      }

      if (config.mailto === null) {
        logger.warn('论文检索配置缺失', {
          requestId: params.requestId,
          projectId: params.projectId,
          missing: config.missing.join(' / '),
        })
        sendPapersFailure(res, 'PAPERS_UPSTREAM_ERROR', params.requestId)
        return true
      }

      const milestoneName = currentMilestoneName(
        options.runtime,
        params.projectId,
        project.current_milestone_id,
      )
      const searchTerm = buildSearchTerm(project.name, milestoneName, params.query)
      const startedAt = Date.now()
      const upstream = await fetchOpenAlexWorks(searchTerm, params.limit, config, fetchImpl)
      const durationMs = Date.now() - startedAt

      const responseBody: PapersSuccessResponse =
        upstream.ok === true
          ? {
              contractVersion: '3.0',
              requestId: params.requestId,
              projectId: params.projectId,
              source: 'openalex',
              notice: null,
              papers: normalizeOpenAlexWorks(upstream.works, params.limit),
            }
          : {
              contractVersion: '3.0',
              requestId: params.requestId,
              projectId: params.projectId,
              source: 'fallback',
              notice: noticeForReason(upstream.reason),
              papers: [],
            }

      logger.info?.('论文检索完成', {
        requestId: params.requestId,
        projectId: params.projectId,
        searchTerm,
        resultCount: responseBody.papers.length,
        durationMs,
        source: responseBody.source,
        ...(upstream.ok === true ? {} : { upstreamReason: upstream.reason }),
      })

      saveIdempotent(
        db,
        auth.user.user_id,
        params.requestId,
        fingerprint,
        200,
        responseBody,
        nowText,
      )
      sendJson(res, 200, responseBody)
      return true
    } catch (error) {
      if (error instanceof V3Error) {
        const code = error.code
        if (code === 'INVALID_INPUT') {
          sendPapersFailure(res, 'INVALID_INPUT', params?.requestId ?? null, error.detail ?? undefined)
          return true
        }
        if (code === 'UNAUTHORIZED' || code === 'PROJECT_NOT_FOUND' || code === 'IDEMPOTENCY_CONFLICT') {
          sendPapersFailure(res, code, params?.requestId ?? null)
          return true
        }
      }
      logger.warn('处理论文检索请求时发生未预期异常', {
        detail: error instanceof Error ? error.name : 'unknown',
      })
      if (!res.headersSent) sendPapersFailure(res, 'INTERNAL', params?.requestId ?? null)
      return true
    }
  }
}
