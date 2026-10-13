import { describe, expect, it } from 'vitest'
import type { MaterialSegment, Project, UnderstandingBlock } from '@/types/platform'
import { migrateProject } from '@/stores/persistence'
import {
  MAX_CONFIRMED_CONTEXT_ITEMS,
  MAX_PROFILE_MEMBERS,
  MAX_PROFILE_TEXT_LENGTH,
  MAX_UNDERSTANDING_SEGMENTS,
  MAX_UNDERSTANDING_TOTAL_LENGTH,
  buildConfirmedContext,
  buildConfirmedMaterials,
  buildProjectProfile,
  emptyProjectProfile,
  materialReadStateOf,
  materialTypeFromFileName,
  normalizeMemberNames,
  normalizeProjectProfile,
  selectUnderstandingSegments,
  statusAfterUnconfirm,
  understandingBlockKey,
  validateProjectProfileInput,
} from '@/domain/materials'
import { TEST_PROJECT_ID, v1ProjectRaw } from '../fixtures/project'

/* --------------------------------------------------------------- 辅助 */

const MATERIAL_ID = 'mat_fixture01'

const materialRaw = {
  materialId: MATERIAL_ID,
  projectId: TEST_PROJECT_ID,
  name: '实验手册.md',
  type: 'md',
  size: 2048,
  encoding: 'utf-8',
  state: 'parsed',
  version: 1,
  createdAt: '2026-10-12T10:12:00+08:00',
  updatedAt: '2026-10-12T10:12:00+08:00',
  failureReason: null,
}

/** v2 形态的片段映射：`{ [materialId]: Segment[] }`，迁移时要转成扁平数组 */
const segmentsRaw = [
  { segmentId: 'seg_0', index: 0, startLine: 1, endLine: 8, text: '# 实验手册' },
  { segmentId: 'seg_1', index: 1, startLine: 10, endLine: 24, text: '## 数据说明' },
]

function understandingRaw(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'cnd_goal_0',
    kind: 'goalCandidates',
    materialId: MATERIAL_ID,
    materialVersion: 1,
    content: '复现极端风浪事件的识别流程',
    sources: [
      {
        materialId: MATERIAL_ID,
        materialName: '实验手册.md',
        materialVersion: 1,
        segmentId: 'seg_0',
        startLine: 1,
        endLine: 8,
      },
    ],
    status,
    originalContent: '复现极端风浪事件的识别流程',
    createdAt: '2026-10-12T10:20:00+08:00',
    updatedAt: '2026-10-12T10:20:00+08:00',
    ...overrides,
  }
}

function projectWith(overrides: Record<string, unknown> = {}): Project {
  const migrated = migrateProject(
    v1ProjectRaw({
      schemaVersion: 3,
      materialRecords: [materialRaw],
      materialSegments: segmentsRaw.map((segment) => ({
        ...segment,
        materialId: MATERIAL_ID,
        materialVersion: 1,
      })),
      understandingBlocks: [understandingRaw('confirmed')],
      ...overrides,
    }),
  )
  if (migrated === null) throw new Error('fixture 迁移失败')
  return migrated
}

/* ---------------------------------------------------------- 文件白名单 */

describe('materialTypeFromFileName（契约 15.1 白名单）', () => {
  it('只接受 md / txt，且不区分大小写', () => {
    expect(materialTypeFromFileName('实验手册.md')).toBe('md')
    expect(materialTypeFromFileName('DATA.TXT')).toBe('txt')
    expect(materialTypeFromFileName(' 报告.Md ')).toBe('md')
  })

  it('其它扩展名与没有扩展名都返回 null', () => {
    expect(materialTypeFromFileName('数据.csv')).toBeNull()
    expect(materialTypeFromFileName('说明.pdf')).toBeNull()
    expect(materialTypeFromFileName('没有扩展名')).toBeNull()
  })
})

/* ------------------------------------------------------ 项目基本信息 */

describe('normalizeProjectProfile（契约 13.1）', () => {
  it('空字符串按 null 处理，文本去掉首尾空白', () => {
    const profile = normalizeProjectProfile({ goal: '  构建原型系统  ', scope: '   ', researchPeriod: '' })
    expect(profile.goal).toBe('构建原型系统')
    expect(profile.scope).toBeNull()
    expect(profile.researchPeriod).toBeNull()
  })

  it('成员姓名去空、去重、最多 10 人', () => {
    const names = normalizeMemberNames([
      '张同学',
      '  ',
      '张同学',
      '李同学',
      ...Array.from({ length: 12 }, (_, i) => `成员${i}`),
    ])
    expect(names.slice(0, 3)).toEqual(['张同学', '李同学', '成员0'])
    expect(names).toHaveLength(MAX_PROFILE_MEMBERS)
  })

  it('非对象输入返回全空默认值（不是 undefined 字段）', () => {
    expect(normalizeProjectProfile(undefined)).toEqual(emptyProjectProfile())
    expect(normalizeProjectProfile('不是对象')).toEqual(emptyProjectProfile())
  })

  it('超长文本被截断（用于容错旧数据），不抛错', () => {
    const profile = normalizeProjectProfile({ goal: 'x'.repeat(MAX_PROFILE_TEXT_LENGTH + 50) })
    expect(profile.goal).toHaveLength(MAX_PROFILE_TEXT_LENGTH)
  })
})

describe('validateProjectProfileInput（面向用户输入）', () => {
  it('超长文本报错，且不会被静默截断', () => {
    expect(validateProjectProfileInput({ goal: 'x'.repeat(MAX_PROFILE_TEXT_LENGTH + 1) })).toBe(
      `项目目标最多 ${MAX_PROFILE_TEXT_LENGTH} 字`,
    )
  })

  it('成员超过 10 人报错', () => {
    expect(
      validateProjectProfileInput({ memberNames: Array.from({ length: 11 }, (_, i) => `成员${i}`) }),
    ).toBe(`项目成员最多 ${MAX_PROFILE_MEMBERS} 人`)
  })

  it('合法输入返回 null', () => {
    expect(validateProjectProfileInput({ goal: '一句话目标', memberNames: ['张同学', '李同学'] })).toBeNull()
  })
})

describe('buildProjectProfile（契约 13.2）', () => {
  it('全部为空时返回 null —— 请求体里不出现 projectProfile', () => {
    expect(buildProjectProfile(emptyProjectProfile())).toBeNull()
    expect(buildProjectProfile(undefined)).toBeNull()
  })

  it('有内容时原样返回，成员数组复制一份', () => {
    const profile = normalizeProjectProfile({ goal: '目标', memberNames: ['张同学'] })
    const payload = buildProjectProfile(profile)
    expect(payload).not.toBeNull()
    expect(payload?.memberNames).toEqual(['张同学'])
    expect(payload?.memberNames).not.toBe(profile.memberNames)
  })
})

/* ------------------------------------------------------------ 片段选择 */

describe('selectUnderstandingSegments（契约 15.2）', () => {
  const makeSegment = (index: number, text: string): MaterialSegment => ({
    segmentId: `seg_${index}`,
    materialId: MATERIAL_ID,
    materialVersion: 1,
    index,
    startLine: index + 1,
    endLine: index + 1,
    text,
  })

  it('片段数达到 100 条就停止', () => {
    const segments = Array.from({ length: 150 }, (_, index) => makeSegment(index, '短文本'))
    expect(selectUnderstandingSegments(segments)).toHaveLength(MAX_UNDERSTANDING_SEGMENTS)
  })

  it('文本合计达到 24,000 字就停止（整段不切分）', () => {
    const segments = Array.from({ length: 20 }, (_, index) => makeSegment(index, 'x'.repeat(2000)))
    const selected = selectUnderstandingSegments(segments)
    expect(selected).toHaveLength(MAX_UNDERSTANDING_TOTAL_LENGTH / 2000)
  })

  it('只保留 segmentId / startLine / endLine / text 四个字段（不发材料正文与内部字段）', () => {
    const selected = selectUnderstandingSegments([makeSegment(0, '正文')])
    expect(Object.keys(selected[0]).sort()).toEqual(['endLine', 'segmentId', 'startLine', 'text'])
  })
})

/* --------------------------------------------------------- 已确认内容 */

describe('已确认内容 → 请求字段（契约 13.2 / 17.1 / 17.2）', () => {
  it('只有 confirmed 的条目进入 confirmedMaterials 与 confirmedContext', () => {
    const project = projectWith()
    const materials = buildConfirmedMaterials(project)
    expect(materials).toHaveLength(1)
    expect(materials[0].materialId).toBe(MATERIAL_ID)
    expect(materials[0].segments).toHaveLength(1)
    expect(materials[0].segments[0].segmentId).toBe('seg_0')
    expect(buildConfirmedContext(project)).toEqual(['项目目标：复现极端风浪事件的识别流程'])
  })

  it('pending / modified 的草稿一律不进请求体', () => {
    for (const status of ['pending', 'modified']) {
      const project = projectWith({ understandingBlocks: [understandingRaw(status)] })
      expect(buildConfirmedMaterials(project)).toEqual([])
      expect(buildConfirmedContext(project)).toEqual([])
    }
  })

  it('整份为空时 confirmedMaterials 是空数组（请求体不出现该字段）', () => {
    const project = projectWith({ understandingBlocks: [] })
    expect(buildConfirmedMaterials(project)).toEqual([])
  })

  it('来源指向别的材料时被剔除，剔除后无来源的条目整条丢弃', () => {
    const block = understandingRaw('confirmed', {
      sources: [
        {
          materialId: 'mat_other',
          materialName: '别的.md',
          materialVersion: 1,
          segmentId: 'seg_9',
          startLine: 1,
          endLine: 2,
        },
      ],
    })
    const project = projectWith({ understandingBlocks: [block] })
    expect(buildConfirmedMaterials(project)).toEqual([])
  })

  it('confirmedContext 最多 10 条，且每条截断到 200 字', () => {
    const blocks = Array.from({ length: 12 }, (_, index) =>
      understandingRaw('confirmed', {
        itemId: `cnd_goal_${index}`,
        content: `第 ${index} 条：${'x'.repeat(300)}`,
      }),
    )
    const lines = buildConfirmedContext(projectWith({ understandingBlocks: blocks }))
    expect(lines).toHaveLength(MAX_CONFIRMED_CONTEXT_ITEMS)
    expect(lines[0].length).toBeLessThanOrEqual(201)
  })
})

/* ------------------------------------------------------------ 读取口径 */

describe('materialReadStateOf（契约 14.1 备注）', () => {
  it('没有草稿 → registered；有待确认 → pending；全部确认 → confirmed', () => {
    expect(materialReadStateOf(projectWith({ understandingBlocks: [] }), MATERIAL_ID)).toBe('registered')
    expect(
      materialReadStateOf(projectWith({ understandingBlocks: [understandingRaw('pending')] }), MATERIAL_ID),
    ).toBe('pending')
    expect(
      materialReadStateOf(projectWith({ understandingBlocks: [understandingRaw('modified')] }), MATERIAL_ID),
    ).toBe('pending')
    expect(materialReadStateOf(projectWith(), MATERIAL_ID)).toBe('confirmed')
  })
})

describe('statusAfterUnconfirm（撤销确认的落点）', () => {
  const base = projectWith().understandingBlocks[0] as UnderstandingBlock

  it('内容没改过 → 回到 pending', () => {
    expect(statusAfterUnconfirm(base)).toBe('pending')
  })

  it('内容被改过 → 回到 modified（保住「这条被改过」的信息）', () => {
    expect(statusAfterUnconfirm({ ...base, content: '学生改过的目标' })).toBe('modified')
  })
})

describe('understandingBlockKey（本地唯一 id）', () => {
  it('两份材料的同名 itemId 不会撞车', () => {
    const a = understandingBlockKey('mat_a', 'goalCandidates', 'cnd_goal_0')
    const b = understandingBlockKey('mat_b', 'goalCandidates', 'cnd_goal_0')
    expect(a).not.toBe(b)
  })
})
