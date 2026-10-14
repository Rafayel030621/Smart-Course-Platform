import { describe, expect, it } from 'vitest'
import { TEMPLATES, TOPICS } from '@/data/topics'

/**
 * 题目模板内容完整性测试（owner：吴佳璐）
 * ----------------------------------------------------------------------------
 * 测的是 `src/data/topics.ts` 这份**内容资产**，不是代码逻辑：
 * 9 套题目在创建项目时会被实例化成里程碑、任务（steps）、疑问、论文方向，
 * 任何一处结构缺失或超长，都会在真实使用中变成「创建出来的项目不完整」。
 *
 * 上限取自 `docs/contracts.md` §2.2 / §4.1 与 `docs/ai/prompt-spec.md` §3.1：
 *   projectName ≤ 120、task.title ≤ 60、doneCriteria ≤ 200、
 *   milestone ≤ 60、doubt.text ≤ 500、suggestion.whyNow ≤ 300
 *
 * 为什么要测模板里的 owner：`src/types/platform.ts` 规定模板里的「成员A」会被迁到
 * `suggestedOwner` 做展示，而契约 §2.2 的 `Task.owner` 在 MVP 阶段**恒为 `null`**。
 * 一旦有人在模板里写了真实姓名，创建流程的 steps → tasks 映射就会把真名带进结构化数据。
 */

/** 模板里「建议负责人」只允许是占位名 */
const PLACEHOLDER_OWNER = /^成员[ABC]$/

/**
 * 空话黑名单（`docs/ai/prompt-spec.md` §6.2）。
 * 模板里的「为什么现在做」与「完成标志」是要展示给学生看的第一手范例，
 * 出现这些句子等于把范例本身写成了反面教材。
 */
const EMPTY_TALK_BLACKLIST = [
  '检索该方向近年综述',
  '多查阅相关文献',
  '注意数据质量',
  '保证精度',
  '提高效率',
  '完善项目文档',
  '做好分工',
  '进行深入研究',
  '加强分析',
]

/** 论文检索提示词里至少要有一段连续的英文关键词，否则检索召回会明显变差 */
const HAS_LATIN_KEYWORDS = /[A-Za-z]{3,}/

describe('题目清单', () => {
  it('恰好 9 套题目', () => {
    expect(TOPICS).toHaveLength(9)
  })

  it('题目名称互不重复', () => {
    expect(new Set(TOPICS).size).toBe(TOPICS.length)
  })

  it.each(TOPICS)('题目「%s」非空、无首尾空白、不超过项目名上限 120 字', (topic) => {
    expect(topic.trim()).toBe(topic)
    expect(topic.length).toBeGreaterThan(0)
    expect(topic.length).toBeLessThanOrEqual(120)
  })
})

describe('模板与题目一一对应', () => {
  it('模板 key 与 TOPICS 完全一致且顺序相同', () => {
    expect(Object.keys(TEMPLATES)).toEqual([...TOPICS])
  })
})

// 逐套题目展开，失败时能一眼看出是哪一套
for (const topic of TOPICS) {
  describe(`题目：${topic}`, () => {
    const template = TEMPLATES[topic]

    it('短名非空', () => {
      expect(template.short.trim().length).toBeGreaterThan(0)
    })

    describe('里程碑', () => {
      it('恰好 5 个，名称非空且不重复、不超过 60 字', () => {
        expect(template.ms).toHaveLength(5)

        const names = template.ms.map((milestone) => milestone.t)
        expect(new Set(names).size).toBe(names.length)
        for (const name of names) {
          expect(name.trim().length).toBeGreaterThan(0)
          expect(name.length).toBeLessThanOrEqual(60)
        }
      })

      it('初始状态一定是「第 1 个进行中、其余未开始」，进度在 0–100 之间', () => {
        // 模板代表「刚创建的项目」，所以第 1 个里程碑必须是 cur，其余必须是 todo。
        // 这条同时防止有人把模板改成「已经有里程碑做完了」导致创建出来的项目状态自相矛盾。
        const running = template.ms.filter((milestone) => milestone.s === 'cur')
        expect(running).toHaveLength(1)
        expect(template.ms[0]?.s).toBe('cur')
        expect(template.ms.slice(1).every((milestone) => milestone.s === 'todo')).toBe(true)

        for (const milestone of template.ms) {
          expect(Number.isInteger(milestone.p)).toBe(true)
          expect(milestone.p).toBeGreaterThanOrEqual(0)
          expect(milestone.p).toBeLessThanOrEqual(100)
          expect(milestone.sub.trim().length).toBeGreaterThan(0)
        }
      })
    })

    describe('启动疑问', () => {
      it('至少一条，非空且不超过疑问内容上限 500 字', () => {
        expect(template.doubts.length).toBeGreaterThanOrEqual(1)
        for (const doubt of template.doubts) {
          expect(doubt.trim()).toBe(doubt)
          expect(doubt.length).toBeGreaterThan(0)
          expect(doubt.length).toBeLessThanOrEqual(500)
        }
      })
    })

    describe('开场说明', () => {
      it('非空', () => {
        expect(template.banner.trim().length).toBeGreaterThan(0)
      })
    })

    describe('三步建议', () => {
      it('恰好 3 条', () => {
        expect(template.steps).toHaveLength(3)
      })

      it('标题非空、互不重复、不超过任务标题上限 60 字', () => {
        const titles = template.steps.map((step) => step.t)
        expect(new Set(titles).size).toBe(titles.length)
        for (const title of titles) {
          expect(title.trim()).toBe(title)
          expect(title.length).toBeGreaterThan(0)
          expect(title.length).toBeLessThanOrEqual(60)
        }
      })

      it('owner 必须是「成员A/B/C」占位，不能是真实姓名', () => {
        for (const step of template.steps) {
          expect(step.owner, `「${step.t}」的 owner 应为占位名`).toMatch(PLACEHOLDER_OWNER)
        }
      })

      it('why 非空且不超过 whyNow 上限 300 字', () => {
        for (const step of template.steps) {
          expect(step.why.trim()).toBe(step.why)
          expect(step.why.length).toBeGreaterThan(0)
          expect(step.why.length).toBeLessThanOrEqual(300)
        }
      })

      it('done 非空且不超过 doneCriteria 上限 200 字', () => {
        for (const step of template.steps) {
          expect(step.done.trim()).toBe(step.done)
          expect(step.done.length).toBeGreaterThan(0)
          expect(step.done.length).toBeLessThanOrEqual(200)
        }
      })

      it('why / done 不得出现空话黑名单里的句子', () => {
        for (const step of template.steps) {
          const text = `${step.why}\n${step.done}`
          for (const phrase of EMPTY_TALK_BLACKLIST) {
            expect(text.includes(phrase), `「${step.t}」出现了空话：${phrase}`).toBe(false)
          }
        }
      })
    })

    describe('论文检索方向', () => {
      it('恰好 3 条', () => {
        expect(template.papers).toHaveLength(3)
      })

      it('标题互不重复，字段齐全', () => {
        const titles = template.papers.map((paper) => paper.title)
        expect(new Set(titles).size).toBe(titles.length)

        for (const paper of template.papers) {
          expect(paper.title.trim().length).toBeGreaterThan(0)
          expect(paper.meta.trim().length).toBeGreaterThan(0)
          expect(paper.why.trim().length).toBeGreaterThan(0)
          expect(paper.prompt.trim().length).toBeGreaterThan(0)
        }
      })

      it('prompt 里必须含英文检索关键词（直接粘到检索工具时要能召回文献）', () => {
        for (const paper of template.papers) {
          expect(HAS_LATIN_KEYWORDS.test(paper.prompt), `「${paper.title}」的 prompt 缺少英文关键词`).toBe(true)
        }
      })

      it('只有能核实的链接才填，且必须是 https 的 DOI 地址', () => {
        for (const paper of template.papers) {
          if (paper.link === undefined) continue

          expect(paper.link.startsWith('https://doi.org/')).toBe(true)
          // 能通过 URL 解析，避免把「大概是这个 DOI 吧」写进去
          expect(() => new URL(paper.link as string)).not.toThrow()
        }
      })

      it('填了 link 的条目，meta 必须标明已定位到具体论文', () => {
        for (const paper of template.papers) {
          if (paper.link === undefined) continue
          expect(paper.meta).toContain('已定位到具体论文')
        }
      })
    })
  })
}
