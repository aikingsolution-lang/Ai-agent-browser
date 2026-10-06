// packages/shared/lib/utils/questionSemanticMatcher.ts
export {
  normalizeQuestionText,
  QUESTION_SYNONYM_CLUSTERS,
  getCanonicalQuestionKey,
  extractSkillFromQuestion,
  calculateJaccardSimilarity,
  areQuestionsSemanticallyEquivalent,
  findBestMatchingGoldenAnswer,
  cosineSimilarity,
  type ISemanticMatchEvaluation,
} from '@extension/storage';
