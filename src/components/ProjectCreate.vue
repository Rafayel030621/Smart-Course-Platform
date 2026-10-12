<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorkbenchStore } from '@/stores/workbench'

/**
 * 创建项目
 * ----------------------------------------------------------------------------
 * 只做一件事：选题目（或自定义名称）+ 小组人数，创建一个**空白项目**。
 *
 * 这里不再提供材料上传入口：M2-A 只支持 MD / TXT，而且"上传 → 解析 → 理解草稿"
 * 整条链路都在工作台完成。创建页原来写着 docx / pdf / csv / zip 并声称"AI 会解析这些内容"，
 * 与实际能力不符，已经删除并改成指向工作台的说明。
 */
const store = useWorkbenchStore()

const topic = ref('')
const customName = ref('')
const membersLabel = ref('3 人')

const isCustom = computed(() => topic.value === '__custom__')

/** 契约 3.2 的 `members` 是数字；这里把「3 人」这类选项解析成人数 */
const memberCount = computed(() => {
  const parsed = Number.parseInt(membersLabel.value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3
})

function submit() {
  store.createProject({
    topicId: topic.value,
    customName: customName.value,
    members: memberCount.value,
  })
}
</script>

<template>
  <div class="create-wrap">
    <div class="create-hero">
      <h2>创建你的项目</h2>
      <p>选择题目和小组人数，先创建一个空白项目；材料与项目基本信息稍后在「工作台」里补充</p>
    </div>

    <div class="card">
      <div class="card-b cform">
        <label>项目题目</label>
        <select v-model="topic">
          <option value="" disabled>从课程题目中选择，或选「自定义」</option>
          <option v-for="item in store.topics" :key="item" :value="item">{{ item }}</option>
          <option value="__custom__">自定义项目…</option>
        </select>

        <div v-if="isCustom">
          <label>自定义项目名称</label>
          <input v-model="customName" type="text" placeholder="输入你的项目名称" />
        </div>

        <div
          style="
            font-size: 12px;
            color: #5f5e5a;
            background: #f8f7f4;
            border-radius: 8px;
            padding: 8px 12px;
            line-height: 1.6;
          "
        >
          选择项目名称只会设置项目名称，不会自动带入任务或项目数据。创建出来的是一个空白项目：
          <b>项目创建后，请到工作台填写项目基本信息，并上传 MD 或 TXT 材料。</b>
        </div>

        <label>小组人数</label>
        <select v-model="membersLabel">
          <option>3 人</option>
          <option>2 人</option>
          <option>4 人</option>
          <option>5 人</option>
        </select>

        <div class="ai-note">
          材料怎么用：工作台支持上传 MD 或 TXT（单个文件不超过 1
          MB），上传后会显示解析状态与理解草稿，逐条确认后才作为项目依据。 CSV / XLSX 将在下一批支持，PDF /
          DOCX / ZIP 将在后续版本支持。
        </div>

        <button class="create-btn" @click="submit">创建空白项目</button>
      </div>
    </div>
  </div>
</template>
