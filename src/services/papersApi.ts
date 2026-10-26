/**
 * 论文检索适配层（docs/contracts.md 第 29 节，V5）
 * ----------------------------------------------------------------------------
 * GET /api/papers/search
 *
 * 契约要点（29.1–29.5）：
 *   1. 检索词由**服务端**组装（项目名 + 当前阶段名 + query）；客户端只传学生方向，
 *      禁止附加 projectName / currentMilestone 等字段，否则等于把检索词交给前端拼；
 *   2. 响应**不是** 20.1 的 `data` 包络：`source` / `notice` / `papers` 直接在顶层；
 *   3. 上游超时 / 5xx / 限流一律 200 + `source: "fallback"` + 中文 `notice` + 空数组，
 *      此时必须保留 notice 给界面，不能当成普通零结果；
 *   4. `openAccessUrl` 可能为 null（前端只显示 DOI 链接），`year` / `venue` / `doi`
 *      在服务端取不到时同样为 null；
 *   5. `requestId` 由调用方生成并在重试时复用：服务端按它做重放去重，
 *      客户端不做结果缓存。
 *
 * 错误码只认 404 `PROJECT_NOT_FOUND` / 400 `INVALID_INPUT` / 503 `PAPERS_UPSTREAM_ERROR`；
 * 复用 `v3Http.ts` 的统一鉴权（Cookie `credentials: 'include'`）、超时与错误归一化。
 */
import { V3_CONTRACT_VERSION } from '@/types/platform'
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  makeV3Error,
  newRequestId,
  requestV3Raw,
  validationError,
  type V3ApiError,
} from './v3Http'

/** 契约 29.2：检索路径 */
export const PAPERS_SEARCH_PATH = '/api/papers/search'
/** 契约 29.2：limit 默认 5、最大 10 */
export const PAPERS_SEARCH_DEFAULT_LIMIT = 5
export const PAPERS_SEARCH_MAX_LIMIT = 10
export const PAPERS_SEARCH_MIN_LIMIT = 1
/** 契约 29.2：query 1–200 字 */
export const PAPERS_QUERY_MIN_LENGTH = 1
export const PAPERS_QUERY_MAX_LENGTH = 200
/**
 * 契约 29.1 规则 4 要求 fallback 必须带中文 notice。
 * 服务端漏带时用这条兜底，避免界面把「检索不可用」显示成「没有相关论文」。
 */
export const PAPERS_FALLBACK_NOTICE = '论文检索服务暂时不可用，请稍后重试'

export type PapersSource = 'openalex' | 'fallback'

/** 契约 29.3：papers[] 单条。字段名与契约一致，不另造 DTO */
export interface PaperSearchItem {
  title: string
  authors: string[]
  year: number | null
  venue: string | null
  doi: string | null
  /** 可能为 null：界面此时只显示 DOI 链接 */
  openAccessUrl: string | null
  citedByCount: number
}

export interface PapersSearchResponse {
  source: PapersSource
  notice: string | null
  papers: PaperSearchItem[]
  requestId: string
  projectId: string
}

export type PapersSearchResult =
  | { ok: true; data: PapersSearchResponse }
  | { ok: false; error: V3ApiError }

export interface PapersSearchInput {
  projectId: string
  /** 学生输入的方向，1–200 字；不拼接项目名/阶段名 */
  query: string
  limit?: number
  /**
   * 调用方生成的 UUID。重试同一检索时传回同一个值，服务端据此重放而不重复打上游；
   * 不传则本地生成（仅便于单测与一次性调用）。
   */
  requestId?: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 契约 v4.1 §29.2：`query` 长度按 **UTF-16 码元**计（即 JS `string.length`），先 trim 再判。
 * 与后端实现一致：用 `[...query].length`（码点）会在 emoji 场景放过超长输入，
 * 最终由服务端 400 拒绝，前端提示反而更晚。
 */
function queryLengthOf(value: string): number {
  return value.length
}

export function isPapersRequestId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * 契约 29.2 的全部 Query 参数，且**只有这些**。
 * 单独导出便于测试断言「没有额外字段混进来」。
 */
export function buildPapersSearchQuery(input: {
  projectId: string
  query: string
  limit: number
  requestId: string
}): Record<string, string | number> {
  return {
    projectId: input.projectId,
    query: input.query,
    limit: input.limit,
    contractVersion: V3_CONTRACT_VERSION,
    requestId: input.requestId,
  }
}

/** 解析单条论文；结构不合法的条目丢弃，不让一条脏数据毁掉整份结果 */
function parsePaper(value: unknown): PaperSearchItem | null {
  const record = asRecord(value)
  if (record === null) return null

  const title = asString(record['title'])
  if (title === null || title.trim() === '') return null

  const rawAuthors = asArray(record['authors'])
  if (rawAuthors === null) return null
  const authors: string[] = []
  for (const item of rawAuthors) {
    const name = asString(item)
    if (name === null) return null
    authors.push(name)
  }

  const year = record['year'] === null ? null : asNumber(record['year'])
  if (record['year'] !== null && year === null) return null

  const venue = record['venue'] === null ? null : asString(record['venue'])
  if (record['venue'] !== null && venue === null) return null

  const doi = record['doi'] === null ? null : asString(record['doi'])
  if (record['doi'] !== null && doi === null) return null

  const openAccessUrl =
    record['openAccessUrl'] === null ? null : asString(record['openAccessUrl'])
  if (record['openAccessUrl'] !== null && openAccessUrl === null) return null

  const citedByCount = asNumber(record['citedByCount'])
  if (citedByCount === null) return null

  return { title, authors, year, venue, doi, openAccessUrl, citedByCount }
}

/** 契约 29.3：解析顶层响应（没有 data 包装） */
export function parsePapersResponse(
  body: unknown,
  expected: { requestId: string; projectId: string },
): PapersSearchResult {
  const record = asRecord(body)
  if (record === null) return { ok: false, error: makeV3Error('INVALID_RESPONSE') }

  if (record['contractVersion'] !== V3_CONTRACT_VERSION) {
    return { ok: false, error: makeV3Error('CONTRACT_VERSION_MISMATCH', { retryable: false }) }
  }

  // 契约 20.1：读接口不强制回显 requestId，回显了就必须一致
  const responseRequestId = record['requestId']
  if (responseRequestId !== undefined && responseRequestId !== expected.requestId) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }

  const responseProjectId = asString(record['projectId'])
  if (responseProjectId === null) {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }
  // 项目已切换：这份结果属于别的项目，交给 store 丢弃
  if (responseProjectId !== expected.projectId) {
    return { ok: false, error: makeV3Error('STALE_RESPONSE', { retryable: false }) }
  }

  const source = record['source']
  if (source !== 'openalex' && source !== 'fallback') {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }

  const rawNotice = record['notice']
  if (rawNotice !== null && typeof rawNotice !== 'string') {
    return { ok: false, error: makeV3Error('INVALID_RESPONSE') }
  }

  const rawPapers = asArray(record['papers'])
  if (rawPapers === null) return { ok: false, error: makeV3Error('INVALID_RESPONSE') }

  const papers: PaperSearchItem[] = []
  for (const item of rawPapers) {
    const parsed = parsePaper(item)
    if (parsed !== null) papers.push(parsed)
  }

  const trimmedNotice = typeof rawNotice === 'string' ? rawNotice.trim() : ''
  // 降级必须带中文说明：服务端漏带时补兜底文案，绝不返回「静默空列表」
  const notice = source === 'fallback' ? (trimmedNotice === '' ? PAPERS_FALLBACK_NOTICE : trimmedNotice) : null

  return {
    ok: true,
    data: {
      source,
      notice,
      papers,
      requestId: expected.requestId,
      projectId: expected.projectId,
    },
  }
}

/** 契约 29.2 / 29.4：检索论文。参数越界在本地就拦下，不发请求 */
export async function searchPapers(input: PapersSearchInput): Promise<PapersSearchResult> {
  const projectId = input.projectId.trim()
  if (projectId === '') {
    return { ok: false, error: validationError('INVALID_INPUT', '缺少项目信息，无法检索论文') }
  }

  const query = input.query.trim()
  const queryLength = queryLengthOf(query)
  if (queryLength < PAPERS_QUERY_MIN_LENGTH || queryLength > PAPERS_QUERY_MAX_LENGTH) {
    return { ok: false, error: validationError('INVALID_INPUT', '检索方向需为 1–200 字') }
  }

  const limit = input.limit ?? PAPERS_SEARCH_DEFAULT_LIMIT
  if (
    !Number.isInteger(limit) ||
    limit < PAPERS_SEARCH_MIN_LIMIT ||
    limit > PAPERS_SEARCH_MAX_LIMIT
  ) {
    return { ok: false, error: validationError('INVALID_INPUT', '返回条数需为 1–10 之间的整数') }
  }

  const requestId = input.requestId ?? newRequestId()
  if (!isPapersRequestId(requestId)) {
    return { ok: false, error: validationError('INVALID_INPUT', 'requestId 必须是 UUID') }
  }

  const raw = await requestV3Raw(PAPERS_SEARCH_PATH, {
    method: 'GET',
    query: buildPapersSearchQuery({ projectId, query, limit, requestId }),
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  })

  if (!raw.ok) return { ok: false, error: raw.error }
  return parsePapersResponse(raw.body, { requestId, projectId })
}
