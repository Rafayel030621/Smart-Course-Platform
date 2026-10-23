<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import ProjectMindMap from '@/components/ProjectMindMap.vue'
import { useCloudStore } from '@/stores/cloud'
import { usePlatformStore } from '@/stores/platform'
import type { TaskStatus } from '@/types/platform'

const platform = usePlatformStore()
const cloud = useCloudStore()
const router = useRouter()
const project = computed(() => platform.cloudProjectView)
const milestones = computed(() => project.value?.ms ?? [])
const tasks = computed(() => project.value?.tasks ?? [])
const stats = computed(() => cloud.projectStats)

const statusStyle: Record<TaskStatus, string> = {
  todo: 'background:#f1efe8;color:#5f5e5a;border:1px solid #d3d1c7;',
  doing: 'background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;',
  done: 'background:#E1F5EE;color:#0F6E56;border:1px solid #9FE1CB;',
}

function statusText(status: TaskStatus): string {
  return status === 'doing' ? '进行中' : status === 'done' ? '已完成' : '未开始'
}
</script>

<template>
  <div v-if="!project" class="card cloud-map-state">
    <div class="card-h">正在加载云端项目</div>
    <div class="card-b">
      <p v-if="cloud.lastError" class="cloud-map-error" role="alert">云端项目加载失败，请返回工作台重试。</p>
      <p v-else class="empty">正在读取项目、阶段和任务…</p>
      <button class="btn primary" type="button" @click="router.push('/')">返回工作台</button>
    </div>
  </div>
  <template v-else>
    <div class="mode-banner"><b>云端项目地图</b> 展示服务端已确认的阶段、任务和统计；任务读取失败时不会伪装为空项目。</div>
    <div class="card map-head">
      <div class="card-h">{{ project.name }} <span class="tag" style="background:#E6F1FB;color:#185FA5;border:1px solid #B5D4F4;">{{ stats.progress }}% 完成</span></div>
      <div class="card-b"><p>{{ project.profile.goal || '还没有填写项目目标' }}</p><p class="map-note">{{ stats.done }}/{{ stats.total }} 个任务已完成 · {{ milestones.length }} 个阶段</p></div>
    </div>
    <div class="card map-body">
      <div class="card-h">项目地图</div>
      <div class="card-b">
        <div v-if="!cloud.tasksHydrated" class="empty">任务列表尚未成功读取，暂不展示地图任务。</div>
        <ProjectMindMap v-else :project="project" />
      </div>
    </div>
    <div class="map-grid">
      <div class="card">
        <div class="card-h">阶段 <span class="tag">{{ milestones.length }}</span></div>
        <div class="card-b">
          <div v-for="milestone in cloud.milestones" :key="milestone.milestoneId" class="map-stage">
            <strong>{{ milestone.name }}</strong><span class="tag">{{ milestone.taskStats.done }}/{{ milestone.taskStats.total }} · {{ milestone.taskStats.progress }}%</span>
            <p>{{ milestone.goal || '暂未填写阶段目标' }}</p>
          </div>
          <p v-if="!milestones.length" class="empty">还没有阶段，请回到工作台创建。</p>
        </div>
      </div>
      <div class="card">
        <div class="card-h">任务状态 <span class="tag">{{ tasks.length }}</span></div>
        <div class="card-b">
          <div v-for="task in tasks" :key="task.id" class="map-task">
            <div class="map-task-top"><strong>{{ task.title }}</strong><span class="tag" :style="statusStyle[task.status]">{{ statusText(task.status) }}</span></div>
            <p v-if="task.doneCriteria">完成标准：{{ task.doneCriteria }}</p>
          </div>
          <p v-if="cloud.tasksHydrated && !tasks.length" class="empty">还没有任务。</p>
        </div>
      </div>
    </div>
  </template>
</template>

<style scoped>
.cloud-map-state { max-width:760px; margin:30px auto; }
.cloud-map-error { color:#854F0B; line-height:1.6; margin-bottom:12px; }
.map-head, .map-body { margin-bottom:14px; }
.map-head p { line-height:1.6; color:#5f5e5a; }
.map-note { margin-top:6px; font-size:12px; }
.map-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.map-stage, .map-task { border-top:1px dashed #efeee9; padding:10px 0; }
.map-stage:first-child, .map-task:first-child { border-top:0; padding-top:0; }
.map-stage strong { margin-right:8px; }
.map-stage p, .map-task p { margin-top:5px; font-size:12px; color:#5f5e5a; line-height:1.5; }
.map-task-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
@media (max-width:800px) { .map-grid { grid-template-columns:1fr; } }
</style>
