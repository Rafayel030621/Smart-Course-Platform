import type { Project } from '@/types/platform'
import { tasksOf } from '@/domain/progress'

/**
 * 项目状态摘要（纯函数）
 * ----------------------------------------------------------------------------
 * 「这是一个空白项目」这句话**不能写死在项目创建时**：
 * 一旦用户上传材料、提交证据、提出疑问或认领任务，项目就不再空白，
 * 提示必须随之消失或更新为当前状态。
 *
 * 因此这里只根据**真实数据**（tasks / evidenceRecords / doubtRecords / materials）
 * 计算摘要与文案，作为「AI 项目顾问」区说明文字的唯一来源：
 *   - store 每次本地写入后调用它刷新 `Project.banner`（页面与刷新恢复共用同一份文案）；
 *   - 页面用它判断是否显示空白项目提示（约定：空白 = 没有任务、证据、疑问、材料）。
 *
 * 不按项目名称判断，也不读任何展示字段（steps / evidence / doubts 都是派生物）。
 */

/** 空白项目的标准提示。新项目只显示这一句，直到用户输入第一条内容 */
export const BLANK_PROJECT_NOTE =
  '这是一个空白项目。请先上传材料、填写项目目标或提交第一条进展，AI 才能生成有依据的下一步建议。'

export interface ProjectStatusSummary {
  /** 没有任何任务 / 证据 / 疑问 / 材料 */
  isBlank: boolean
  taskCount: number
  todoCount: number
  doingCount: number
  doneCount: number
  evidenceCount: number
  /** 全部疑问记录数（含已解决）：用户提出过疑问就不再是空白项目 */
  doubtCount: number
  openDoubtCount: number
  materialCount: number
  /** 「AI 项目顾问」区的项目状态说明 */
  note: string
}

/** 按真实数据拼一句人话；空白项目返回 BLANK_PROJECT_NOTE */
function buildNote(summary: Omit<ProjectStatusSummary, 'note'>): string {
  const { isBlank, taskCount, todoCount, doingCount, doneCount, evidenceCount, openDoubtCount, materialCount } = summary

  if (isBlank) return BLANK_PROJECT_NOTE

  const doubtTail = openDoubtCount > 0 ? `，还有 ${openDoubtCount} 条疑问待解决` : ''

  if (taskCount > 0) {
    return (
      `AI 项目顾问正在追踪 ${taskCount} 个任务（进行中 ${doingCount} · 已完成 ${doneCount} · 未开始 ${todoCount}），` +
      `已记录 ${evidenceCount} 条证据、${materialCount} 份材料${doubtTail}。`
    )
  }

  const assets: string[] = []
  if (evidenceCount > 0) assets.push(`${evidenceCount} 条证据`)
  if (materialCount > 0) assets.push(`${materialCount} 份材料`)
  if (openDoubtCount > 0) assets.push(`${openDoubtCount} 条待解决疑问`)

  const head = assets.length > 0 ? `项目已有 ${assets.join('、')}` : '项目已经有过输入'
  return `${head}，还没有任务；点「获取建议」让 AI 给出下一步。`
}

export function summarizeProjectStatus(project: Project): ProjectStatusSummary {
  const tasks = tasksOf(project)
  const evidenceCount = (project.evidenceRecords ?? []).length
  const doubtRecords = project.doubtRecords ?? []
  const materialCount = (project.materials ?? []).length

  const todoCount = tasks.filter((task) => task.status === 'todo').length
  const doingCount = tasks.filter((task) => task.status === 'doing').length
  const doneCount = tasks.filter((task) => task.status === 'done').length
  const openDoubtCount = doubtRecords.filter((doubt) => doubt.status === 'open').length

  const base = {
    isBlank:
      tasks.length === 0 &&
      evidenceCount === 0 &&
      doubtRecords.length === 0 &&
      materialCount === 0,
    taskCount: tasks.length,
    todoCount,
    doingCount,
    doneCount,
    evidenceCount,
    doubtCount: doubtRecords.length,
    openDoubtCount,
    materialCount,
  }

  return { ...base, note: buildNote(base) }
}
