import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  submitProgress,
  updateProject,
} from '@/services/projectsApi'
import {
  echoEnvelope,
  installFetch,
  jsonResponse,
  makeProgress,
  makeCloudProject,
  requestBody,
} from '../support/v3Fixtures'

beforeEach(() => {
  vi.unstubAllGlobals()
})

const progressPayload = { progress: makeProgress(), milestoneStats: null }

describe('幂等键与 requestId（本地真实后端联调回归）', () => {
  it('同一逻辑操作重试复用 requestId；项目版本变化后生成新幂等键', async () => {
    const bodies: Array<Record<string, unknown>> = []
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/prj_1/progress') || init.method !== 'POST') return undefined
      bodies.push(requestBody(init))
      return jsonResponse(echoEnvelope(init, progressPayload, { projectRevision: 5 }))
    })

    const input = {
      projectId: 'prj_1',
      projectRevision: 4,
      milestoneId: null,
      taskId: null,
      summary: '同一次逻辑提交',
    }
    const first = await submitProgress(input, { idempotencyKey: 'it-retry-key-0001' })
    const retry = await submitProgress(input, { idempotencyKey: 'it-retry-key-0001' })

    expect(first.ok).toBe(true)
    expect(retry.ok).toBe(true)
    expect(bodies[1]?.['requestId']).toBe(bodies[0]?.['requestId'])
    expect(bodies[1]?.['idempotencyKey']).toBe('it-retry-key-0001')

    // 新版本下同内容属于新的操作，默认幂等键必须变化，避免 IDEMPOTENCY_CONFLICT
    const nextRevision = await submitProgress({ ...input, projectRevision: 5 })
    expect(nextRevision.ok).toBe(true)
    expect(bodies[2]?.['idempotencyKey']).not.toBe(bodies[0]?.['idempotencyKey'])
    expect(bodies[2]?.['projectRevision']).toBe(5)
  })

  it('项目资料更新的幂等键随 projectRevision 变化', async () => {
    const keys: string[] = []
    installFetch((url, init) => {
      if (!url.endsWith('/api/projects/prj_1') || init.method !== 'PATCH') return undefined
      keys.push(String(requestBody(init)['idempotencyKey']))
      return jsonResponse(
        echoEnvelope(init, { project: makeCloudProject({ projectRevision: 3 }) }, { projectRevision: 3 }),
      )
    })

    await updateProject({ projectId: 'prj_1', projectRevision: 2, name: '同名更新' })
    await updateProject({ projectId: 'prj_1', projectRevision: 2, name: '同名更新' })
    await updateProject({ projectId: 'prj_1', projectRevision: 3, name: '同名更新' })

    // 同一版本的重试保持稳定键；版本推进后必须换键
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })
})
