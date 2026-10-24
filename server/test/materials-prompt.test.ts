import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  UNDERSTANDING_SYSTEM_PROMPT,
  buildUnderstandingUserPrompt,
} from '../src/materials/prompt.js'

test('材料理解系统提示词显式列出五块，且不再出现四块', () => {
  for (const field of [
    'goalCandidates',
    'outcomeCandidates',
    'dataNotes',
    'methodNotes',
    'openQuestions',
  ]) {
    assert.match(UNDERSTANDING_SYSTEM_PROMPT, new RegExp(field))
  }
  assert.match(UNDERSTANDING_SYSTEM_PROMPT, /五块/)
  assert.doesNotMatch(UNDERSTANDING_SYSTEM_PROMPT, /四块/)

  const userPrompt = buildUnderstandingUserPrompt({
    materialName: '样例.md',
    materialType: 'md',
    materialVersion: 1,
    projectName: null,
    segments: [{ segmentId: 'seg_0', startLine: 1, endLine: 1, text: '样例正文' }],
  })
  assert.match(userPrompt, /五块候选/)
  assert.doesNotMatch(userPrompt, /四块/)
})
