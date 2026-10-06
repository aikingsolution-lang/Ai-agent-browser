import { describe, it, expect } from 'vitest';
import {
  normalizeQuestionText,
  getCanonicalQuestionKey,
  areQuestionsSemanticallyEquivalent,
  findBestMatchingGoldenAnswer,
  cosineSimilarity,
  calculateJaccardSimilarity,
} from '@extension/storage';

describe('Smart Semantic Matching for Golden Answers (Approach A)', () => {
  describe('1. Normalization & Filler Word Stripping', () => {
    it('lowercases, strips punctuation, and removes common polite/filler words', () => {
      const raw1 = 'Please specify: what is your Notice Period?';
      const raw2 = 'Kindly state your Notice Period (in days)!';
      expect(normalizeQuestionText(raw1)).toBe('notice period');
      expect(normalizeQuestionText(raw2)).toBe('notice period in days');
    });

    it('strips "can you", "could you", "tell us", "enter", "provide" while keeping intent keywords', () => {
      const raw = 'Could you please tell us what is your current CTC?';
      expect(normalizeQuestionText(raw)).toBe('current ctc');
    });
  });

  describe('2. Curated Synonym Clusters (Notice Period, CTC, Relocation, etc.)', () => {
    it('matches all real-world variants of Notice Period to the canonical cluster', () => {
      const canonical = 'notice_period';
      const variants = [
        'Notice Period',
        'How soon can you join?',
        'How soon can you start?',
        'Joining availability',
        'Availability to join',
        'Joining time',
        'Notice duration',
        'When can you join?',
        'When can you start?',
        'What is your notice period?',
        'Earliest start date',
      ];

      for (const variant of variants) {
        expect(getCanonicalQuestionKey(variant)).toBe(canonical);
      }
    });

    it('identifies "Notice Period" and "How soon can you join?" as semantically equivalent', () => {
      const res = areQuestionsSemanticallyEquivalent('Notice Period', 'How soon can you join?');
      expect(res.matched).toBe(true);
      expect(res.canonicalKey).toBe('notice_period');
      expect(res.similarity).toBeGreaterThanOrEqual(0.95);
    });

    it('identifies "Current CTC" variants as semantically equivalent', () => {
      const res = areQuestionsSemanticallyEquivalent('What is your current salary?', 'Current CTC (Annual)');
      expect(res.matched).toBe(true);
      expect(res.canonicalKey).toBe('current_ctc');
    });

    it('identifies "Expected CTC" variants as semantically equivalent', () => {
      const res = areQuestionsSemanticallyEquivalent('Salary expectation (INR)?', 'Expected CTC / Desired Salary');
      expect(res.matched).toBe(true);
      expect(res.canonicalKey).toBe('expected_ctc');
    });

    it('identifies "Work Authorization" and "Visa Sponsorship" variants correctly', () => {
      const authRes = areQuestionsSemanticallyEquivalent(
        'Are you legally authorized to work in the country?',
        'Valid work authorization',
      );
      expect(authRes.matched).toBe(true);
      expect(authRes.canonicalKey).toBe('work_authorization');

      const visaRes = areQuestionsSemanticallyEquivalent(
        'Will you now or in the future require visa sponsorship?',
        'Need visa sponsorship',
      );
      expect(visaRes.matched).toBe(true);
      expect(visaRes.canonicalKey).toBe('visa_sponsorship');
    });

    it('identifies "Relocation", "Commute", and "Work Mode / Hybrid" correctly', () => {
      const reloc = areQuestionsSemanticallyEquivalent(
        'Are you willing to relocate for this role?',
        'Relocation availability',
      );
      expect(reloc.matched).toBe(true);
      expect(reloc.canonicalKey).toBe('relocation');

      const hybrid = areQuestionsSemanticallyEquivalent(
        'Are you comfortable working in a hybrid model?',
        'Remote or hybrid work mode',
      );
      expect(hybrid.matched).toBe(true);
      expect(hybrid.canonicalKey).toBe('work_mode_hybrid');
    });
  });

  describe('3. Skill-Specific Question Matching', () => {
    it('matches different phrasing of experience questions targeting the same technology', () => {
      const res = areQuestionsSemanticallyEquivalent(
        'How many years of experience do you have with React?',
        'React experience (years)',
      );
      expect(res.matched).toBe(true);
      expect(res.similarity).toBeGreaterThanOrEqual(0.9);
    });

    it('matches Python experience questions across variants', () => {
      const res = areQuestionsSemanticallyEquivalent('Years of hands-on experience using Python', 'Python experience');
      expect(res.matched).toBe(true);
    });
  });

  describe('4. Token Jaccard Similarity (Non-Curated Questions)', () => {
    it('matches arbitrary questions with high token overlap', () => {
      const q1 = 'Experience deploying Docker containers to production Kubernetes clusters';
      const q2 = 'Experience deploying Kubernetes clusters with Docker containers in production';
      const jaccard = calculateJaccardSimilarity(q1, q2);
      expect(jaccard).toBeGreaterThanOrEqual(0.7);

      const res = areQuestionsSemanticallyEquivalent(q1, q2);
      expect(res.matched).toBe(true);
    });
  });

  describe('5. Distinctness & False Positive Prevention', () => {
    it('does NOT match unrelated questions to each other', () => {
      expect(areQuestionsSemanticallyEquivalent('Notice Period', 'Current CTC').matched).toBe(false);
      expect(areQuestionsSemanticallyEquivalent('Expected CTC', 'Willing to relocate').matched).toBe(false);
      expect(areQuestionsSemanticallyEquivalent('React experience', 'Python experience').matched).toBe(false);
      expect(areQuestionsSemanticallyEquivalent('Work Authorization', 'Notice Period').matched).toBe(false);
    });
  });

  describe('6. findBestMatchingGoldenAnswer', () => {
    const savedGoldenAnswers = [
      { id: 'ga_1', question: 'Notice Period', answer: '15 days' },
      { id: 'ga_2', question: 'Current CTC', answer: '8 LPA' },
      { id: 'ga_3', question: 'Expected CTC', answer: '14 LPA' },
      { id: 'ga_4', question: 'Are you willing to relocate?', answer: 'Yes' },
      { id: 'ga_5', question: 'Do you require visa sponsorship?', answer: 'No' },
    ];

    it('finds "Notice Period" answer when incoming question asks "How soon can you join?"', () => {
      const match = findBestMatchingGoldenAnswer('How soon can you join?', savedGoldenAnswers);
      expect(match.matched).toBe(true);
      expect(match.goldenAnswer?.id).toBe('ga_1');
      expect(match.goldenAnswer?.answer).toBe('15 days');
    });

    it('finds "Current CTC" answer when incoming question asks "What is your present salary?"', () => {
      const match = findBestMatchingGoldenAnswer('What is your present salary (INR)?', savedGoldenAnswers);
      expect(match.matched).toBe(true);
      expect(match.goldenAnswer?.id).toBe('ga_2');
      expect(match.goldenAnswer?.answer).toBe('8 LPA');
    });

    it('returns matched=false when no golden answer matches incoming question', () => {
      const match = findBestMatchingGoldenAnswer(
        'Do you possess a valid commercial pilot license?',
        savedGoldenAnswers,
      );
      expect(match.matched).toBe(false);
    });
  });

  describe('7. Cosine Similarity Math Helper (Approach B readiness)', () => {
    it('computes 1.0 for identical vectors', () => {
      const vec = [0.1, 0.5, 0.8, -0.2];
      expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
    });

    it('computes 0.0 for orthogonal vectors', () => {
      const vecA = [1, 0, 0];
      const vecB = [0, 1, 0];
      expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(0.0, 5);
    });

    it('returns 0 for empty or mismatched vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });
  });
});
