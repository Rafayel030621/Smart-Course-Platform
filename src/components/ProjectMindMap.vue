<script setup lang="ts">
import { computed } from 'vue'
import type { Project } from '@/types/platform'
import { CHINESE_NUM } from '@/stores/workbench'
import { milestoneStatusText, taskStatusText } from '@/domain/progress'

/**
 * 项目地图
 * ----------------------------------------------------------------------------
 * 左侧五个里程碑，中间项目本体，右侧 AI 正在追踪的实际步骤。
 * 连线与配色照 mockup 的写法逐条还原。
 */
const props = defineProps<{ project: Project }>()

const COLORS: Record<string, { fill: string; stroke: string; t: string; s: string; line: string }> = {
  done: { fill: '#E1F5EE', stroke: '#5DCAA5', t: '#085041', s: '#0F6E56', line: '#5DCAA5' },
  cur: { fill: '#E6F1FB', stroke: '#85B7EB', t: '#0C447C', s: '#185FA5', line: '#85B7EB' },
  todo: { fill: '#f8f7f4', stroke: '#d3d1c7', t: '#888780', s: '#b4b2a9', line: '#d3d1c7' },
}

const svg = computed(() => {
  const p = props.project
  const msX = 20
  const msW = 180
  const msH = 52
  const msYs = [26, 104, 182, 260, 338]
  const cx = 330
  const cy = 190
  const cw = 130
  const ch = 64
  const ccY = cy + ch / 2

  let out = '<svg viewBox="0 0 760 420" width="100%" role="img" aria-label="项目地图">'

  // 里程碑 → 项目本体
  p.ms.forEach((m, i) => {
    const y = msYs[i] + msH / 2
    out += `<path d="M${msX + msW} ${y} C 260 ${y} 270 ${ccY} ${cx} ${ccY}" fill="none" stroke="${COLORS[m.s].line}" stroke-width="1.5"/>`
  })

  // 项目本体 → 当前步骤
  const n = p.steps.length
  const stH = 56
  const gap = 14
  const total = n * stH + (n - 1) * gap
  const startY = ccY - total / 2
  for (let j = 0; j < n; j += 1) {
    const y = startY + j * (stH + gap) + stH / 2
    out += `<path d="M${cx + cw} ${ccY} C 500 ${ccY} 510 ${y} 560 ${y}" fill="none" stroke="#AFA9EC" stroke-width="1.5"/>`
  }

  // 中心：项目本体
  out +=
    `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="12" fill="#185FA5"/>` +
    `<text x="${cx + cw / 2}" y="${cy + 27}" text-anchor="middle" font-size="13" font-weight="600" fill="#fff">${esc(p.short)}</text>` +
    `<text x="${cx + cw / 2}" y="${cy + 46}" text-anchor="middle" font-size="11" fill="#B5D4F4">${esc(p.group)}</text>`

  // 左侧里程碑：状态文案复用 domain 的说法（已完成 / 进行中 / 未开始）
  p.ms.forEach((m, i) => {
    const c = COLORS[m.s]
    out +=
      `<rect x="${msX}" y="${msYs[i]}" width="${msW}" height="${msH}" rx="10" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1"/>` +
      `<text x="${msX + msW / 2}" y="${msYs[i] + 23}" text-anchor="middle" font-size="12" font-weight="600" fill="${c.t}">${CHINESE_NUM[i]} ${esc(m.t)}</text>` +
      `<text x="${msX + msW / 2}" y="${msYs[i] + 40}" text-anchor="middle" font-size="10.5" fill="${c.s}">${milestoneStatusText(m.s)}${m.s === 'cur' ? ` ${m.p}%` : ''}</text>`
  })

  // 右侧当前步骤：显示真实任务状态（进行中 / 已完成 / 未开始），不再只说「建议：待定」
  for (let j = 0; j < n; j += 1) {
    const yy = startY + j * (stH + gap)
    const raw = p.steps[j].t
    const title = raw.length > 13 ? `${raw.slice(0, 13)}…` : raw
    const status = p.steps[j].status
    const sub = status === undefined
      ? `建议：${esc(p.steps[j].owner)} · AI 追踪中`
      : `${taskStatusText(status)} · AI 追踪中`
    out +=
      `<rect x="560" y="${yy}" width="180" height="${stH}" rx="10" fill="#EEEDFE" stroke="#AFA9EC" stroke-width="1"/>` +
      `<text x="650" y="${yy + 24}" text-anchor="middle" font-size="12" font-weight="600" fill="#3C3489">步骤${j + 1} ${esc(title)}</text>` +
      `<text x="650" y="${yy + 41}" text-anchor="middle" font-size="10.5" fill="#534AB7">${sub}</text>`
  }

  out += `<text x="${msX + msW / 2}" y="14" text-anchor="middle" font-size="11.5" font-weight="600" fill="#888780">里程碑</text>`
  out += '<text x="650" y="14" text-anchor="middle" font-size="11.5" font-weight="600" fill="#888780">当前实际步骤</text>'
  out += '</svg>'
  return out
})

/** SVG 文本里只需要挡住尖括号与 & */
function esc(text: string) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
</script>

<template>
  <div v-html="svg"></div>
</template>
