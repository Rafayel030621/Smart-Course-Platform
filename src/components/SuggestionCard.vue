<script setup lang="ts">
import { computed } from 'vue'
import type { Recommendation, RecommendationSource } from '@/domain/recommendation'

/**
 * 建议卡片
 * ----------------------------------------------------------------------------
 * 纯展示组件：只负责把一条 Recommendation 渲染出来，不做任何网络与 store 调用。
 * 依据（证据 / 疑问）默认折叠（契约 5.3：「可展开看到依据的证据/疑问原文」），
 * 展开后显示的是可读内容，不是 ID。
 *
 * 任务按钮的三种状态（契约 5.4）：
 *   claimable          认领已有任务 → 「认领这一步」
 *   claimed            这条建议已经认领过 → 「已认领 · 进行中」并禁用
 *   draft              existingTaskId 为空，认领后创建新任务 → 同样显示「认领这一步」
 *
 * 用户可见文案一律说人话：不出现 doneCriteria / existingTaskId 这类字段名。
 */

const props = defineProps<{
  suggestion: Recommendation
  /** 列表里的序号，从 0 开始 */
  index: number
  claimState: 'claimable' | 'claimed' | 'draft'
  /** 依据证据的可读内容（已由页面把 ID 解析成文字） */
  evidence: Array<{ id: string; time: string; text: string }>
  /** 依据疑问的可读内容 */
  doubts: Array<{ id: string; text: string }>
}>()

const emit = defineEmits<{ claim: [] }>()

/** 契约 5.2：来源要说人话，不显示 model / local-rule 这类内部值 */
const SOURCE_TEXT: Record<RecommendationSource, string> = {
  model: 'AI 模型生成',
  fallback: '服务端规则生成',
  'local-rule': '本地规则生成',
}

const SOURCE_STYLE: Record<RecommendationSource, string> = {
  model: 'background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;',
  fallback: 'background:#FAEEDA;color:#854F0B;border:1px solid #FAC775;',
  'local-rule': 'background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;',
}

const sourceLabel = computed(() => SOURCE_TEXT[props.suggestion.source])
const sourceStyle = computed(() => SOURCE_STYLE[props.suggestion.source])

/**
 * 未认领的建议统一显示「认领这一步」（候选建议 → 进入项目是一件事），
 * 认领之后按钮显示真实状态并禁用（是否已认领由页面按真实任务判断）。
 */
const CLAIM_LABEL = {
  claimable: '认领这一步',
  claimed: '已认领 · 进行中',
  draft: '认领这一步',
} as const

const claimLabel = computed(() => CLAIM_LABEL[props.claimState])

const basisCount = computed(() => props.evidence.length + props.doubts.length)
</script>

<template>
  <div class="step-card">
    <div class="sc-top">
      <div class="sc-no">{{ index + 1 }}</div>
      <div class="sc-title">{{ suggestion.title }}</div>
      <span class="tag sc-owner" :style="sourceStyle">{{ sourceLabel }}</span>
    </div>

    <div class="sc-why"><b>为什么现在做：</b>{{ suggestion.whyNow }}</div>
    <div class="sc-done">{{ suggestion.doneCriteria }}</div>

    <!-- 依据默认折叠；展开后是证据与疑问的原文，不是 ID -->
    <details class="basis">
      <summary>
        依据
        <span v-if="basisCount > 0">（证据 {{ evidence.length }} · 疑问 {{ doubts.length }}）</span>
        <span v-else>（这条建议没有引用具体依据）</span>
      </summary>
      <div class="basis-body">
        <div v-if="evidence.length" class="basis-group">
          <div class="basis-label">依据的证据</div>
          <div v-for="item in evidence" :key="item.id" class="basis-item">
            <span v-if="item.time" class="basis-time">{{ item.time }}</span>{{ item.text }}
          </div>
        </div>

        <div v-if="doubts.length" class="basis-group">
          <div class="basis-label">依据的疑问</div>
          <div v-for="item in doubts" :key="item.id" class="basis-item">{{ item.text }}</div>
        </div>

        <div v-if="basisCount === 0" class="basis-item">
          这条建议来自项目当前状态的整体判断，没有指向某条证据或疑问。
        </div>
      </div>
    </details>

    <div class="sc-actions">
      <button class="btn primary" :disabled="claimState === 'claimed'" @click="emit('claim')">
        {{ claimLabel }}
      </button>

      <span v-if="claimState === 'claimed'" class="hint">
        已认领：任务已进入「AI 项目顾问」，状态为进行中。做完记得提交证据。
      </span>
      <span v-else-if="claimState === 'draft'" class="hint">
        点击后会把这条建议创建为当前项目的进行中任务。
      </span>
      <span v-else class="hint">
        点击后把这条已有任务认领为进行中。
      </span>
    </div>
  </div>
</template>

<style scoped>
.basis {
  margin-top: 10px;
  border-top: 1px dashed #e3e2dd;
  padding-top: 8px;
}

.basis > summary {
  cursor: pointer;
  font-size: 12px;
  color: #5f5e5a;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.basis > summary::-webkit-details-marker {
  display: none;
}

.basis > summary::before {
  content: '▸';
  color: #534ab7;
  font-size: 11px;
}

.basis[open] > summary::before {
  content: '▾';
}

.basis-body {
  margin-top: 8px;
  padding: 8px 12px;
  background: #f8f7f4;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.basis-label {
  font-size: 11.5px;
  font-weight: 600;
  color: #534ab7;
  margin-bottom: 2px;
}

.basis-item {
  font-size: 12px;
  color: #444441;
  line-height: 1.6;
}

.basis-time {
  color: #888780;
  margin-right: 6px;
}

.hint {
  font-size: 11.5px;
  color: #888780;
  line-height: 1.6;
  align-self: center;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
