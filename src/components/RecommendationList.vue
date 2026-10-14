<script setup lang="ts">
import SuggestionCard from '@/components/SuggestionCard.vue'
import type { Recommendation } from '@/domain/recommendation'

interface RecommendationView {
  suggestion: Recommendation
  index: number
  claimState: 'claimable' | 'claimed' | 'draft'
  evidence: Array<{ id: string; time: string; text: string }>
  doubts: Array<{ id: string; text: string }>
}

const props = defineProps<{ items: RecommendationView[] }>()

const emit = defineEmits<{ claim: [suggestion: Recommendation] }>()
</script>

<template>
  <div v-if="props.items.length" class="recommendation-list">
    <SuggestionCard
      v-for="item in props.items.slice(0, 3)"
      :key="item.suggestion.id"
      :suggestion="item.suggestion"
      :index="item.index"
      :claim-state="item.claimState"
      :evidence="item.evidence"
      :doubts="item.doubts"
      @claim="emit('claim', item.suggestion)"
    />
  </div>
</template>

<style scoped>
.recommendation-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
