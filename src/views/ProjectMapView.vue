<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import ProjectMindMap from '@/components/ProjectMindMap.vue'
import { milestoneStatusText, taskStatusText } from '@/domain/progress'
import { useWorkbenchStore } from '@/stores/workbench'
import type { Milestone, TaskStatus } from '@/types/platform'

/**
 * 项目地图（独立页面）
 * ----------------------------------------------------------------------------
 * 把「这个项目现在走到哪儿了」单独摊开：
 *   当前项目 → 项目地图（复用 ProjectMindMap）→ 里程碑 → 任务状态。
 *
 * 页面只做排版与空状态，地图本身不在这里重画；所有数据都读 store 的当前项目，
 * 所以切换项目后地图、里程碑、任务会一起更新。
 */
const store = useWorkbenchStore()
const router = useRouter()

const project = computed(() => store.current)
const tasks = computed(() => project.value?.tasks ?? [])
const milestones = computed(() => project.value?.ms ?? [])

/** 任务状态徽标（未开始 / 进行中 / 已完成） */
const STATUS_TAG_STYLE: Record<TaskStatus, string> = {
  todo: 'background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;',
  doing: 'background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;',
  done: 'background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;',
}

function statusStyle(status: TaskStatus): string {
  return STATUS_TAG_STYLE[status]
}

const statusCounts = computed(() => ({
  todo: tasks.value.filter((task) => task.status === 'todo').length,
  doing: tasks.value.filter((task) => task.status === 'doing').length,
  done: tasks.value.filter((task) => task.status === 'done').length,
}))

function milestoneBadge(milestone: Milestone, index: number) {
  if (milestone.s === 'done') return { cls: 'ms-dot ms-done', text: '✓' }
  if (milestone.s === 'cur') return { cls: 'ms-dot ms-cur', text: String(index + 1) }
  return { cls: 'ms-dot ms-todo', text: String(index + 1) }
}

/** 状态 + 说明；两个一样时只显示一次，避免出现「未开始 · 未开始」 */
function milestoneSubText(milestone: Milestone): string {
  const status = milestoneStatusText(milestone.s)
  const sub = (milestone.sub ?? '').trim()
  return sub === '' || sub === status ? status : `${status} · ${sub}`
}

function switchProject(event: Event) {
  store.selectProject((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="mode-banner">
    <b>项目地图</b>把当前项目的里程碑和任务状态摊在一张图上：左侧是阶段，右侧是正在推进的任务。
  </div>

  <!-- 还没有项目：给出创建提示 -->
  <div v-if="!project" class="card">
    <div class="card-h">还没有项目</div>
    <div class="card-b">
      <div class="empty" style="padding-top:0;">
        还没有可以展示的项目。先到「工作台」创建项目，地图会显示这个项目的里程碑与任务状态。
      </div>
      <button class="btn primary" @click="router.push('/')">去工作台创建项目</button>
    </div>
  </div>

  <template v-else>
    <div class="card" style="margin-bottom:16px;">
      <div class="card-h">
        当前项目
        <span class="tag" style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;">
          {{ project.short }}
        </span>
      </div>
      <div class="card-b">
        <select class="proj-select" :value="project.projectId" @change="switchProject">
          <option v-for="item in store.projects" :key="item.projectId" :value="item.projectId">
            {{ item.name }}
          </option>
        </select>
        <div class="map-meta">
          {{ project.group }} · {{ project.members }}<br />{{ project.updated }}
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="card-h">
        项目地图
        <span
          class="tag"
          style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;"
        >{{ milestones.length ? `${milestones.length} 个里程碑` : '暂无里程碑' }}</span>
      </div>
      <div class="card-b">
        <div v-if="!tasks.length" class="empty" style="padding:4px 0;">
          这个项目还没有任务。先到「工作台」获取下一步建议并认领一步，
          地图会随着任务状态一起更新。
        </div>
        <template v-else>
          <ProjectMindMap :project="project" />
          <div class="map-legend">
            左侧为里程碑，右侧为任务 · 绿=已完成，蓝=进行中，灰=未开始
          </div>
        </template>
      </div>
    </div>

    <div class="map-grid">
      <div class="card">
        <div class="card-h">
          里程碑
          <span class="tag" style="background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;">
            {{ milestones.length }}
          </span>
        </div>
        <div class="card-b">
          <div v-if="!milestones.length" class="empty" style="padding:4px 0;">
            这个项目还没有里程碑。上传材料、写下项目目标或提交第一条进展后，
            AI 会给出阶段划分。
          </div>
          <div v-for="(milestone, index) in milestones" :key="`${index}-${milestone.t}`" class="milestone">
            <div :class="milestoneBadge(milestone, index).cls">{{ milestoneBadge(milestone, index).text }}</div>
            <div style="flex:1">
              <div class="ms-name">{{ milestone.t }}</div>
              <div class="ms-sub">{{ milestoneSubText(milestone) }}</div>
              <div v-if="milestone.s === 'cur'" class="ms-bar"><i :style="`width:${milestone.p}%`"></i></div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          任务状态
          <span class="tag" style="background:#EEEDFE;color:#3C3489;border:1px solid #CECBF6;">
            未开始 {{ statusCounts.todo }} · 进行中 {{ statusCounts.doing }} · 已完成 {{ statusCounts.done }}
          </span>
        </div>
        <div class="card-b">
          <div v-if="!tasks.length" class="empty" style="padding:4px 0;">
            还没有任务。任务会在你认领「AI 下一步建议」后出现在这里。
          </div>
          <div v-for="task in tasks" :key="task.id" class="map-task">
            <div class="map-task-top">
              <span class="map-task-title">{{ task.title }}</span>
              <span class="tag" :style="statusStyle(task.status)">{{ taskStatusText(task.status) }}</span>
            </div>
            <div v-if="task.doneCriteria" class="map-task-done">完成标准：{{ task.doneCriteria }}</div>
          </div>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.map-meta {
  font-size: 12px;
  color: #888780;
  line-height: 1.7;
}

.map-legend {
  font-size: 12px;
  color: #888780;
  text-align: center;
  margin-top: 4px;
}

.map-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}

.map-task {
  border: 1px solid #efeee9;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}

.map-task:last-child {
  margin-bottom: 0;
}

.map-task-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.map-task-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}

.map-task-done {
  font-size: 12px;
  color: #0F6E56;
  margin-top: 6px;
  line-height: 1.5;
}

@media (max-width: 1100px) {
  .map-grid {
    grid-template-columns: 1fr;
  }
}
</style>
