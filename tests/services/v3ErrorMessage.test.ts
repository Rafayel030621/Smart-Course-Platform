import { describe, expect, it } from 'vitest'
import { makeV3Error, requestV3Raw, v3Message } from '@/services/v3Http'

/** 构造真实 Response，避免手写假对象 */
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function failingFetch(body: unknown, status: number): typeof fetch {
  return async () => jsonResponse(body, status)
}

describe('V3 错误提示兜底', () => {
  it('后端新增、前端未收录的错误码沿用服务端中文提示', async () => {
    const result = await requestV3Raw('/api/projects/p1/materials/m1/reparse', {
      method: 'POST',
      fetchImpl: failingFetch(
        { code: 'BRAND_NEW_CODE', message: '这份材料没有保存原文，请重新上传' },
        409,
      ),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('BRAND_NEW_CODE')
    expect(result.error.message).toBe('这份材料没有保存原文，请重新上传')
  })

  it('已知错误码使用本地中文提示，不被服务端文案覆盖', async () => {
    const result = await requestV3Raw('/api/projects/p1', {
      method: 'GET',
      fetchImpl: failingFetch({ code: 'PROJECT_ARCHIVED', message: 'raw server text' }, 409),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe('项目已归档，请先恢复')
  })

  it('服务端没有 message 时仍回落到本地通用提示', async () => {
    const result = await requestV3Raw('/api/projects/p1', {
      method: 'GET',
      fetchImpl: failingFetch({ code: 'ANOTHER_NEW_CODE' }, 400),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toBe(v3Message('INTERNAL'))
  })

  it('材料原文缺失有专门中文提示', () => {
    expect(v3Message('MATERIAL_CONTENT_UNAVAILABLE')).toBe('这份材料没有保存原文，请重新上传')
  })

  it('makeV3Error 支持显式 message 覆盖', () => {
    expect(makeV3Error('ANY_CODE', { message: '自定义提示' }).message).toBe('自定义提示')
  })
})
