import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supersedeProgress } from '@/services/projectsApi'
import { echoEnvelope, installFetch, jsonResponse, makeProgress } from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const PROGRESS_ID = 'prg_1'

interface Captured {
  url: string
  method: string
  body: Record<string, unknown>
}

function capturedBody(captured: Captured[], url: string, init: RequestInit): void {
  captured.push({
    url,
    method: init.method ?? 'GET',
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('进展更正（POST .../progress/{progressId}/supersede）', () => {
  it('按已合并后端字段发送 expectedRevision 与可选覆盖字段', async () => {
    const captured: Captured[] = []
    installFetch((url, init) => {
      capturedBody(captured, url, init)
      return jsonResponse(
        echoEnvelope(
          init,
          {
            progress: makeProgress({
              progressId: 'prg_2',
              summary: '更正后的说明',
              supersedesProgressId: PROGRESS_ID,
              revision: 1,
            }),
            supersededProgressId: PROGRESS_ID,
            milestoneStats: { total: 2, done: 1, doing: 1, todo: 0, archived: 0, progress: 50 },
          },
          { projectId: PROJECT_ID, projectRevision: 9 },
        ),
      )
    })

    const result = await supersedeProgress({
      projectId: PROJECT_ID,
      projectRevision: 9,
      progressId: PROGRESS_ID,
      expectedRevision: 2,
      summary: '更正后的说明',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.progress.progressId).toBe('prg_2')
    expect(result.data.supersededProgressId).toBe(PROGRESS_ID)
    expect(result.data.milestoneStats?.done).toBe(1)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.method).toBe('POST')
    expect(captured[0]!.url).toContain(`/api/projects/${PROJECT_ID}/progress/${PROGRESS_ID}/supersede`)
    const body = captured[0]!.body
    expect(body['contractVersion']).toBe('3.0')
    expect(body['projectId']).toBe(PROJECT_ID)
    expect(body['projectRevision']).toBe(9)
    expect(body['expectedRevision']).toBe(2)
    expect(body['summary']).toBe('更正后的说明')
    expect(typeof body['requestId']).toBe('string')
    expect(typeof body['idempotencyKey']).toBe('string')
    // 没传的字段不出现，交给服务端沿用原进展
    expect('taskId' in body).toBe(false)
    expect('milestoneId' in body).toBe(false)
    expect('evidenceIds' in body).toBe(false)
  })

  it('响应指向别的进展时整份丢弃', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            progress: makeProgress({ progressId: 'prg_new' }),
            supersededProgressId: 'prg_other',
            milestoneStats: null,
          },
          { projectId: PROJECT_ID, projectRevision: 9 },
        ),
      ),
    )

    const result = await supersedeProgress({
      projectId: PROJECT_ID,
      projectRevision: 9,
      progressId: PROGRESS_ID,
      expectedRevision: 1,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('服务端 STALE_REVISION 原样透出（当前 revision 供 UI 刷新）', async () => {
    installFetch(() =>
      jsonResponse(
        {
          contractVersion: '1.0',
          code: 'STALE_REVISION',
          message: '进展已被修改',
          currentEntityRevision: 5,
        },
        409,
      ),
    )

    const result = await supersedeProgress({
      projectId: PROJECT_ID,
      projectRevision: 9,
      progressId: PROGRESS_ID,
      expectedRevision: 2,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_REVISION')
      expect(result.error.currentEntityRevision).toBe(5)
    }
  })
})
