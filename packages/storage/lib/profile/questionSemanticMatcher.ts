// packages/storage/lib/profile/questionSemanticMatcher.ts

/**
 * Question Semantic Matcher (Approach A: Normalization + Curated Synonym Clusters + Token Jaccard)
 *
 * Enables smart semantic matching for Golden Answers:
 * - Normalizes away punctuation, polite words, and question preambles.
 * - Uses a curated synonym mapping table for common ATS/recruiter questions (Notice Period, CTC, Relocation, etc.).
 * - Skill-aware normalization for technology experience questions.
 * - High-speed, 0-cost, 100% local deterministic matching with cosine similarity math ready for Approach B embeddings.
 */

// Polite and filler words to strip during question normalization
const FILLER_WORDS_REGEX =
  /\b(please|kindly|could\s+you|can\s+you|would\s+you|are\s+you\s+able\s+to|do\s+you|will\s+you|tell\s+us|specify|enter|state|what\s+is|what\s+are|what's|whats|what|provide|indicate|select|choose|your|our|any|briefly|approximately|currently|presently|share)\b/gi;

/**
 * Normalizes question text:
 * - Trims and lowercases
 * - Removes punctuation and special characters
 * - Strips common recruiter question filler words
 * - Collapses repeated whitespace
 */
export function normalizeQuestionText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[?*!.:,;'"()[\]{}_/\\-]/g, ' ')
    .replace(FILLER_WORDS_REGEX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Curated synonym mapping table:
 * Maps canonical keys to known question phrasing variants across LinkedIn, Indeed, and Naukri.
 */
export const QUESTION_SYNONYM_CLUSTERS: Record<string, string[]> = {
  notice_period: [
    'notice period',
    'how soon can you join',
    'how soon can you start',
    'joining availability',
    'availability to join',
    'joining time',
    'days to join',
    'notice duration',
    'when can you join',
    'when can you start',
    'earliest start date',
    'earliest joining date',
    'how many days notice',
    'what is your notice period',
    'how many months notice',
    'official notice period',
    'joining notice',
  ],
  immediate_joining: [
    'immediate joiner',
    'can you join immediately',
    'are you an immediate joiner',
    'start immediately',
    'available immediately',
    'join immediately',
    'immediate start',
  ],
  current_ctc: [
    'current ctc',
    'current salary',
    'present ctc',
    'present salary',
    'existing ctc',
    'current compensation',
    'fixed ctc',
    'annual ctc',
    'gross ctc',
    'current annual package',
    'current annual compensation',
    'ctc in inr',
    'fixed component',
  ],
  expected_ctc: [
    'expected ctc',
    'expected salary',
    'target ctc',
    'desired salary',
    'salary expectation',
    'seeking salary',
    'expected compensation',
    'expected annual package',
    'compensation expectation',
    'salary required',
    'target compensation',
  ],
  total_experience: [
    'total experience',
    'total years of experience',
    'overall experience',
    'total work experience',
    'professional experience',
    'years of experience do you have',
    'how many years of total experience',
    'relevant experience',
    'years of relevant experience',
    'overall years of experience',
    'industry experience',
  ],
  work_authorization: [
    'authorized to work',
    'legally authorized',
    'work authorization',
    'eligible to work',
    'legal right to work',
    'right to work',
    'are you legally authorized to work',
    'work permit',
    'valid work authorization',
    'authorization to work',
  ],
  visa_sponsorship: [
    'require sponsorship',
    'need visa sponsorship',
    'visa sponsorship',
    'require visa',
    'will you require sponsorship',
    'do you require visa sponsorship',
    'now or in the future require sponsorship',
    'sponsorship for an employment visa',
    'require employment visa',
    'need sponsorship',
  ],
  relocation: [
    'willing to relocate',
    'open to relocate',
    'ready to relocate',
    'relocation availability',
    'comfortable relocating',
    'are you willing to relocate',
    'can you relocate',
    'willingness to relocate',
    'open to relocation',
  ],
  commute: [
    'comfortable commuting',
    'able to commute',
    'willing to commute',
    'daily commute',
    'can you commute to office',
    'travel to office',
    'commute to location',
    'reliable transportation to commute',
  ],
  work_mode_hybrid: [
    'remote or hybrid',
    'open to hybrid',
    'work from office',
    'onsite work',
    'in person work',
    'comfortable working from office',
    'hybrid schedule',
    'comfortable working in a hybrid model',
    'work from office flexibility',
  ],
  highest_education: [
    'highest degree',
    'highest qualification',
    'highest level of education',
    'highest level of completed education',
    'education level',
    'highest educational qualification',
    'highest completed level of education',
  ],
  background_check: [
    'background check',
    'consent to background check',
    'pass background check',
    'undergo background verification',
    'willing to undergo background check',
    'background investigation',
    'bgv',
  ],
  drug_test: [
    'drug test',
    'drug screening',
    'pass a drug test',
    'undergo drug screening',
    'willing to take a drug test',
    'substance test',
  ],
  cgpa_percentage: [
    'cgpa',
    'gpa',
    'college gpa',
    'percentage in graduation',
    'academic percentage',
    'cumulative gpa',
    'marks percentage',
  ],
  linkedin_url: ['linkedin profile', 'linkedin url', 'link to your linkedin', 'linkedin page', 'linkedin account'],
  github_url: [
    'github profile',
    'github url',
    'link to your github',
    'github repo',
    'github link',
    'github profile link',
  ],
  portfolio_url: ['portfolio url', 'portfolio link', 'personal website', 'portfolio website', 'personal portfolio'],
  currently_employed: [
    'are you currently employed',
    'currently working',
    'presently employed',
    'are you currently working',
    'employed at present',
  ],
  gender: ['gender', 'sex', 'gender identity'],
  veteran_status: ['veteran status', 'are you a veteran', 'protected veteran', 'military veteran'],
  disability_status: ['disability status', 'do you have a disability', 'individual with a disability'],
};

/**
 * Resolves a question string to its canonical synonym cluster key, if matched.
 */
export function getCanonicalQuestionKey(question: string): string | null {
  if (!question) return null;
  const norm = normalizeQuestionText(question);
  if (!norm || norm.length < 3) return null;

  for (const [canonicalKey, variants] of Object.entries(QUESTION_SYNONYM_CLUSTERS)) {
    for (const variant of variants) {
      const normVariant = normalizeQuestionText(variant);
      if (!normVariant) continue;

      if (norm === normVariant) {
        return canonicalKey;
      }

      // Exact phrase match with word boundary
      if (
        normVariant.length >= 8 &&
        new RegExp(`\\b${normVariant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(norm)
      ) {
        return canonicalKey;
      }
    }
  }

  return null;
}

/**
 * Extracts a specific skill from a skill-experience question if present.
 */
export function extractSkillFromQuestion(question: string): string | null {
  const norm = normalizeQuestionText(question);
  const patterns = [
    /(?:years|experience).*?(?:with|in|using)\s+([a-z0-9#+.\s-]{2,30}?)(?:\s+experience|\s+do\s+you|\s*\?|$)/i,
    /(?:^|\s)([a-z0-9#+.-]{2,25})\s+experience/i,
    /(?:worked|working)\s+with\s+([a-z0-9#+.\s-]{2,30}?)(?:\s*\?|$)/i,
    /(?:knowledge|proficient|hands\s*on)\s+(?:in|with)\s+([a-z0-9#+.\s-]{2,30}?)(?:\s*\?|$)/i,
  ];

  for (const pat of patterns) {
    const match = norm.match(pat);
    if (match && match[1]) {
      const skill = match[1].trim().toLowerCase().replace(/\.js$/, '').replace(/js$/, '');
      if (!/^(a|an|the|any|your|our|total|overall|relevant|professional|years|hands)$/i.test(skill)) {
        return skill;
      }
    }
  }

  return null;
}

/**
 * Calculates Jaccard token similarity between two strings:
 * |Intersection| / |Union| of significant words (length > 2)
 */
export function calculateJaccardSimilarity(text1: string, text2: string): number {
  const words1 = new Set(
    normalizeQuestionText(text1)
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
  const words2 = new Set(
    normalizeQuestionText(text2)
      .split(/\s+/)
      .filter(w => w.length > 2),
  );

  if (words1.size === 0 || words2.size === 0) return 0;

  let intersectionSize = 0;
  for (const w of words1) {
    if (words2.has(w)) intersectionSize++;
  }

  const unionSize = new Set([...words1, ...words2]).size;
  return unionSize > 0 ? intersectionSize / unionSize : 0;
}

export interface ISemanticMatchEvaluation {
  matched: boolean;
  similarity: number;
  reason: string;
  canonicalKey?: string;
}

/**
 * Determines whether two questions are semantically equivalent without requiring LLM calls.
 */
export function areQuestionsSemanticallyEquivalent(q1: string, q2: string): ISemanticMatchEvaluation {
  if (!q1 || !q2) {
    return { matched: false, similarity: 0, reason: 'Empty question string' };
  }

  const t1 = q1.trim().toLowerCase();
  const t2 = q2.trim().toLowerCase();

  // 1. Literal exact match
  if (t1 === t2) {
    return { matched: true, similarity: 1.0, reason: 'Exact literal match' };
  }

  // 2. Normalized text exact match (after stripping punctuation and filler words)
  const norm1 = normalizeQuestionText(q1);
  const norm2 = normalizeQuestionText(q2);

  if (norm1 && norm2 && norm1 === norm2) {
    return { matched: true, similarity: 0.98, reason: 'Normalized text exact match' };
  }

  // 3. Curated Synonym Clusters (e.g. "Notice Period" ↔ "How soon can you join?")
  const canonical1 = getCanonicalQuestionKey(q1);
  const canonical2 = getCanonicalQuestionKey(q2);

  if (canonical1 && canonical2 && canonical1 === canonical2) {
    return {
      matched: true,
      similarity: 0.95,
      reason: `Curated synonym cluster match: [${canonical1}]`,
      canonicalKey: canonical1,
    };
  }

  // 4. Skill-specific experience question match (e.g. "Years of React" ↔ "Experience with React")
  const skill1 = extractSkillFromQuestion(q1);
  const skill2 = extractSkillFromQuestion(q2);
  if (skill1 && skill2 && skill1 === skill2) {
    return {
      matched: true,
      similarity: 0.95,
      reason: `Skill-specific match on "${skill1}"`,
      canonicalKey: `skill_${skill1}`,
    };
  }

  // 5. Normalized substring containment (only when both phrases are substantial and have high length ratio)
  if (norm1.length >= 8 && norm2.length >= 8) {
    const ratio = Math.min(norm1.length, norm2.length) / Math.max(norm1.length, norm2.length);
    if (ratio >= 0.7 && (norm1.includes(norm2) || norm2.includes(norm1))) {
      return {
        matched: true,
        similarity: 0.9,
        reason: 'Normalized substring containment with high length ratio',
      };
    }
  }

  // 6. Token Jaccard similarity for non-curated questions (threshold: >= 0.70)
  const jaccard = calculateJaccardSimilarity(q1, q2);
  if (jaccard >= 0.7) {
    return {
      matched: true,
      similarity: Math.round(jaccard * 100) / 100,
      reason: `High token overlap (Jaccard ${(jaccard * 100).toFixed(0)}%)`,
    };
  }

  return {
    matched: false,
    similarity: Math.round(jaccard * 100) / 100,
    reason: 'Questions are semantically distinct',
  };
}

/**
 * Searches a candidate list of saved Golden Answers and finds the best semantic match.
 */
export function findBestMatchingGoldenAnswer<T extends { question: string; answer?: string; id?: string }>(
  incomingQuestion: string,
  goldenAnswers: T[],
): {
  matched: boolean;
  goldenAnswer?: T;
  similarity: number;
  reason?: string;
  canonicalKey?: string;
} {
  if (!incomingQuestion || !Array.isArray(goldenAnswers) || goldenAnswers.length === 0) {
    return { matched: false, similarity: 0 };
  }

  let bestMatch: T | undefined = undefined;
  let highestSimilarity = 0;
  let bestReason = '';
  let bestCanonicalKey: string | undefined = undefined;

  for (const candidate of goldenAnswers) {
    if (!candidate || !candidate.question) continue;

    const evalResult = areQuestionsSemanticallyEquivalent(incomingQuestion, candidate.question);
    if (evalResult.matched && evalResult.similarity > highestSimilarity) {
      highestSimilarity = evalResult.similarity;
      bestMatch = candidate;
      bestReason = evalResult.reason;
      bestCanonicalKey = evalResult.canonicalKey;

      // Perfect match, can break early
      if (highestSimilarity === 1.0) break;
    }
  }

  if (bestMatch && highestSimilarity >= 0.7) {
    return {
      matched: true,
      goldenAnswer: bestMatch,
      similarity: highestSimilarity,
      reason: bestReason,
      canonicalKey: bestCanonicalKey,
    };
  }

  return { matched: false, similarity: highestSimilarity };
}

/**
 * Cosine Similarity Math Helper (for Approach B - Bedrock Titan Embeddings)
 * Calculates cosine similarity between two numeric embedding vectors:
 * dot(A, B) / (||A|| * ||B||)
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
