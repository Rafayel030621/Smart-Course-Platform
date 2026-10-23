import { describe, expect, it, vi } from 'vitest'
import { uploadMaterial } from '@/services/projectsApi'
import {
  echoEnvelope,
  installFetch,
  jsonResponse,
  makeCloudMaterial,
  makeMaterialSegment,
  requestBody,
} from '../support/v3Fixtures'

const PROJECT_ID = 'prj_1'
const REVISION = 3

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

describe('材料上传（POST /api/projects/{id}/materials，契约 22.9）', () => {
  it('请求体只有 name + contentBase64：materialId / materialVersion 由服务端生成', async () => {
    const bodies: Record<string, unknown>[] = []
    installFetch((_url, init) => {
      bodies.push(requestBody(init))
      return jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_new', name: '文献笔记.md' }),
            segments: [makeMaterialSegment({ materialId: 'mat_new', segmentId: 'seg_0' })],
            segmentCount: 1,
            deduplicated: false,
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      )
    })

    const result = await uploadMaterial(PROJECT_ID, {
      name: '文献笔记.md',
      contentBase64: base64('# 笔记\n\n正文'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.material.materialId).toBe('mat_new')
    expect(result.data.deduplicated).toBe(false)
    expect(result.data.segmentCount).toBe(1)
    expect(result.projectRevision).toBe(REVISION + 1)

    const body = bodies[0]!
    expect(body['contractVersion']).toBe('3.0')
    expect(body['projectId']).toBe(PROJECT_ID)
    expect(body['projectRevision']).toBe(REVISION)
    expect(body['name']).toBe('文献笔记.md')
    expect(typeof body['contentBase64']).toBe('string')
    // 契约 22.9：不接受客户端指定 materialId / materialVersion
    expect('materialId' in body).toBe(false)
    expect('materialVersion' in body).toBe(false)
    expect('type' in body).toBe(false)
    expect(typeof body['requestId']).toBe('string')
    expect(typeof body['idempotencyKey']).toBe('string')
  })

  it('请求地址与写包络沿用项目约定（POST + body 内幂等键，与其它写接口一致）', async () => {
    const calls: Array<{ url: string; method: string; idempotencyKey: string | null }> = []
    installFetch((url, init) => {
      const body = requestBody(init)
      calls.push({
        url,
        method: init.method ?? 'GET',
        idempotencyKey: typeof body['idempotencyKey'] === 'string' ? body['idempotencyKey'] : null,
      })
      return jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_new' }),
            segments: [],
            segmentCount: 0,
            deduplicated: false,
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      )
    })

    await uploadMaterial(PROJECT_ID, {
      name: 'a.md',
      contentBase64: base64('x'),
      projectRevision: REVISION,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toContain(`/api/projects/${PROJECT_ID}/materials`)
    expect(calls[0]!.idempotencyKey).not.toBeNull()
  })

  it('去重命中：deduplicated=true 且 projectRevision 不变', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_existing', revision: 2 }),
            segments: [makeMaterialSegment({ materialId: 'mat_existing' })],
            segmentCount: 1,
            deduplicated: true,
          },
          // 契约：去重不递增 projectRevision
          { projectId: PROJECT_ID, projectRevision: REVISION },
        ),
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: '实验手册.md',
      contentBase64: base64('# 同一份内容'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.deduplicated).toBe(true)
    expect(result.data.material.materialId).toBe('mat_existing')
    expect(result.projectRevision).toBe(REVISION)
  })

  it('解析失败仍算提交成功：status=parse_failed + failureReason', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({
              materialId: 'mat_bad',
              status: 'parse_failed',
              failureReason: '材料解析失败，请检查文件内容后重试',
            }),
            segments: [],
            segmentCount: 0,
            deduplicated: false,
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: 'bad.md',
      contentBase64: base64('   '),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.material.status).toBe('parse_failed')
    expect(result.data.material.failureReason).not.toBeNull()
    expect(result.data.segmentCount).toBe(0)
  })

  it('片段属于别的材料或版本 → INVALID_RESPONSE（不静默丢弃）', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_new' }),
            segments: [makeMaterialSegment({ materialId: 'mat_other' })],
            segmentCount: 1,
            deduplicated: false,
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: 'a.md',
      contentBase64: base64('x'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('缺 deduplicated / segmentCount 类型不对 → INVALID_RESPONSE', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_new' }),
            segments: [],
            segmentCount: '1',
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: 'a.md',
      contentBase64: base64('x'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INVALID_RESPONSE')
  })

  it('本地先拦：空文件名 / 空内容 / 超过 1 MB，不发请求', async () => {
    const fetchMock = installFetch(() => undefined)

    const blankName = await uploadMaterial(PROJECT_ID, {
      name: '   ',
      contentBase64: base64('x'),
      projectRevision: REVISION,
    })
    expect(blankName.ok).toBe(false)
    if (!blankName.ok) expect(blankName.error.code).toBe('INVALID_INPUT')

    const empty = await uploadMaterial(PROJECT_ID, {
      name: 'a.md',
      contentBase64: '   ',
      projectRevision: REVISION,
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error.code).toBe('EMPTY_MATERIAL')

    // 1 MB + 1 字节
    const tooLarge = await uploadMaterial(PROJECT_ID, {
      name: 'big.md',
      contentBase64: Buffer.alloc(1_048_577, 0x61).toString('base64'),
      projectRevision: REVISION,
    })
    expect(tooLarge.ok).toBe(false)
    if (!tooLarge.ok) expect(tooLarge.error.code).toBe('MATERIAL_TOO_LARGE')

    expect(vi.mocked(fetchMock).mock.calls).toHaveLength(0)
  })

  it('刚好 1 MB 允许上传', async () => {
    installFetch((_url, init) =>
      jsonResponse(
        echoEnvelope(
          init,
          {
            material: makeCloudMaterial({ materialId: 'mat_max', size: 1_048_576 }),
            segments: [],
            segmentCount: 0,
            deduplicated: false,
          },
          { projectId: PROJECT_ID, projectRevision: REVISION + 1 },
        ),
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: 'max.md',
      contentBase64: Buffer.alloc(1_048_576, 0x61).toString('base64'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(true)
  })

  it('服务端错误码原样透出（扩展名不在白名单）', async () => {
    installFetch(() =>
      jsonResponse(
        { contractVersion: '3.0', code: 'UNSUPPORTED_MATERIAL_TYPE', message: '当前不支持该材料格式' },
        400,
      ),
    )

    const result = await uploadMaterial(PROJECT_ID, {
      name: '报告.pdf',
      contentBase64: base64('x'),
      projectRevision: REVISION,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_MATERIAL_TYPE')
      expect(result.error.message).toContain('不支持')
    }
  })
})
