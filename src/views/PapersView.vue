<script setup lang="ts">
import { computed, ref } from 'vue'
import PaperDirectionCard from '@/components/PaperDirectionCard.vue'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 论文推荐
 * ----------------------------------------------------------------------------
 * 两种推荐方式并列，都由学生自己选：
 *   ① 直接打开 —— 已定位到具体论文的，点开即读原文；没有具体链接的，退化为按标题检索
 *   ② 复制提示词 —— 粘到 GPT 里自己检索，拿到最新结果
 *
 * 为什么保留方式②：老师明确要求练检索能力，而且给不了实时准确的链接列表。
 */
const store = useWorkbenchStore()
const ask = ref('')

const project = computed(() => store.current)

/**
 * banner 用 v-html 渲染，项目短名是用户输入，拼接前必须转义。
 * 只转义这一次调用：其余项目名都走 Vue 的 {{ }} 插值（自动转义）。
 */
function esc(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const banner = computed(() => {
  if (!project.value) {
    return '<b>还没有项目。</b>请先到「工作台」创建项目，AI 会为你的项目生成独立的论文推荐。'
  }
  return (
    `这里是 AI 为「${esc(project.value.short)}」项目在当前阶段推荐的方向，每个项目独立推荐。` +
    '<b>每条推荐都同时给两条路：</b>能定位到具体论文的直接打开；其余的可以复制提示词到 GPT 自己检索。'
  )
})
</script>

<template>
  <div class="mode-banner" v-html="banner"></div>

  <div v-if="project">
    <!-- 两种推荐方式说明 -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-h">两种推荐方式</div>
      <div class="card-b" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div>
          <div style="font-weight:600;font-size:13px;color:#185FA5;margin-bottom:4px;">
            ① 直接打开
          </div>
          <div style="font-size:12.5px;color:#5f5e5a;line-height:1.7;">
            已经定位到具体论文的，点开就是原文（DOI 链接）；<br />
            没能定位到具体论文的，点开是按标题的学术检索，同样能看到相关论文。
          </div>
        </div>
        <div>
          <div style="font-weight:600;font-size:13px;color:#3C3489;margin-bottom:4px;">
            ② 复制检索提示词
          </div>
          <div style="font-size:12.5px;color:#5f5e5a;line-height:1.7;">
            把提示词复制到 GPT 里自己检索。<br />
            拿到的是最新的结果，检索能力也是这门课要练的。
          </div>
        </div>
      </div>
    </div>

    <!-- 让 AI 现场生成 -->
    <div class="card" style="margin-bottom:16px;">
      <div class="card-h">
        让 AI 为你推荐
        <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
          接入 AI · 结合当前项目状态
        </span>
      </div>
      <div class="card-b">
        <div style="font-size:12.5px;color:#888780;margin-bottom:10px;line-height:1.6;">
          描述你想了解的方向或遇到的问题，AI 会结合「{{ project.short }}」项目的当前进度，生成专属的检索提示词。
        </div>
        <div class="chat-input" style="margin-top:0;">
          <input
            v-model="ask"
            :placeholder="`如：想了解「${project.short}」中某个方法或数据处理问题…`"
            @keydown.enter="store.askPaperAi(ask); ask = ''"
          />
          <button class="btn primary" @click="store.askPaperAi(ask); ask = ''">生成推荐</button>
        </div>
      </div>
    </div>

    <!-- AI 现场生成的 -->
    <PaperDirectionCard
      v-for="(item, index) in project.aiPapers"
      :key="`ai-${index}`"
      :title="item.title"
      :meta="item.meta"
      :prompt="item.prompt"
      accent
    />

    <!-- 项目模板里预置的方向 -->
    <PaperDirectionCard
      v-for="(item, index) in project.papers"
      :key="`p-${index}`"
      :title="item.title"
      :meta="item.meta"
      :why="item.why"
      :prompt="item.prompt"
      :link="item.link"
    />
  </div>
</template>
