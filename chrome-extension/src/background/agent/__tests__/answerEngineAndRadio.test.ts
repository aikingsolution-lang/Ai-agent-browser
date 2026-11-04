import { describe, it, expect, beforeEach } from 'vitest';
import { SessionAnswerStore, computeQuestionFingerprint, normalizeQuestionText } from '../sessionAnswerStore';

describe('Answer Engine & Form Interaction Tests', () => {
  let store: SessionAnswerStore;

  beforeEach(() => {
    store = new SessionAnswerStore();
  });

  describe('SessionAnswerStore & Deterministic Memory', () => {
    it('normalizes question text predictably', () => {
      expect(normalizeQuestionText('What is your expected salary?')).toBe('what is your expected salary');
      expect(normalizeQuestionText('Notice period (days)*')).toBe('notice period days');
      expect(normalizeQuestionText('  Where did you learn about Miratech?*  ')).toBe(
        'where did you learn about miratech',
      );
    });

    it('generates consistent fingerprints regardless of option order', () => {
      const fp1 = computeQuestionFingerprint('Choose one', 'linkedin', ['Yes', 'No']);
      const fp2 = computeQuestionFingerprint('Choose one', 'linkedin', ['No', 'Yes']);
      expect(fp1).toBe(fp2);
      expect(fp1).toBe('linkedin::choose one::no|yes');
    });

    it('generates distinct fingerprints when options differ', () => {
      const fpA = computeQuestionFingerprint('Preferred location', 'linkedin', ['Bengaluru', 'Remote']);
      const fpB = computeQuestionFingerprint('Preferred location', 'linkedin', ['New York', 'Remote']);
      expect(fpA).not.toBe(fpB);
    });

    it('stores and retrieves answers consistently within the same session', () => {
      const sessionId = 'session_123';
      const fp = computeQuestionFingerprint('Are you legally authorized to work in India?', 'linkedin', ['Yes', 'No']);

      const ok = store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Are you legally authorized to work in India?',
        normalizedQuestion: 'are you legally authorized to work in india',
        platform: 'linkedin',
        fieldType: 'radio',
        options: ['Yes', 'No'],
        answer: 'Yes',
        source: 'PROFILE_EXPLICIT',
        confidence: 'HIGH',
        userApproved: true,
        reason: 'Profile workAuthorization confirms legal status',
        resolvedAt: Date.now(),
      });

      expect(ok).toBe(true);
      expect(store.has(sessionId, fp)).toBe(true);

      const record = store.get(sessionId, fp);
      expect(record).toBeDefined();
      expect(record?.answer).toBe('Yes');
      expect(record?.source).toBe('PROFILE_EXPLICIT');
      expect(record?.confidence).toBe('HIGH');
    });

    it('prevents unapproved answers from overwriting user-approved answers', () => {
      const sessionId = 'session_123';
      const fp = computeQuestionFingerprint('Do you have prior experience with Go?', 'linkedin', ['Yes', 'No']);

      // 1. User approves "Yes"
      store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Do you have prior experience with Go?',
        normalizedQuestion: 'do you have prior experience with go',
        platform: 'linkedin',
        fieldType: 'radio',
        options: ['Yes', 'No'],
        answer: 'Yes',
        source: 'USER_SAVED',
        confidence: 'HIGH',
        userApproved: true,
        reason: 'Candidate confirmed past Go experience',
        resolvedAt: Date.now(),
      });

      // 2. An automated retry attempts to set an unapproved answer ("No")
      const overwriteAttempt = store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Do you have prior experience with Go?',
        normalizedQuestion: 'do you have prior experience with go',
        platform: 'linkedin',
        fieldType: 'radio',
        options: ['Yes', 'No'],
        answer: 'No',
        source: 'AI_GENERATED',
        confidence: 'MEDIUM',
        userApproved: false,
        reason: 'Autonomous LLM guess',
        resolvedAt: Date.now(),
      });

      expect(overwriteAttempt).toBe(false);
      expect(store.get(sessionId, fp)?.answer).toBe('Yes');
    });

    it('prevents lower priority sources from overwriting higher priority sources', () => {
      const sessionId = 'session_123';
      const fp = computeQuestionFingerprint('Notice period', 'linkedin');

      // 1. Set explicit profile answer (Priority 4)
      store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Notice period',
        normalizedQuestion: 'notice period',
        platform: 'linkedin',
        fieldType: 'text',
        answer: '15 days',
        source: 'PROFILE_EXPLICIT',
        confidence: 'HIGH',
        userApproved: false,
        reason: 'From candidate profile',
        resolvedAt: Date.now(),
      });

      // 2. AI-generated guess (Priority 2) tries to overwrite
      const aiOverwrite = store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Notice period',
        normalizedQuestion: 'notice period',
        platform: 'linkedin',
        fieldType: 'text',
        answer: '30 days',
        source: 'AI_GENERATED',
        confidence: 'LOW',
        userApproved: false,
        reason: 'LLM guess',
        resolvedAt: Date.now(),
      });

      expect(aiOverwrite).toBe(false);
      expect(store.get(sessionId, fp)?.answer).toBe('15 days');
    });

    it('completely isolates candidate answers between different job application sessions', () => {
      const fp = computeQuestionFingerprint('Salary expectations', 'linkedin');
      const sessionA = 'job_miratech_1';
      const sessionB = 'job_igloo_2';

      store.set({
        fingerprint: fp,
        sessionId: sessionA,
        questionLabel: 'Salary expectations',
        normalizedQuestion: 'salary expectations',
        platform: 'linkedin',
        fieldType: 'text',
        answer: '1200000',
        source: 'PROFILE_EXPLICIT',
        confidence: 'HIGH',
        userApproved: false,
        reason: 'Candidate target CTC',
        resolvedAt: Date.now(),
      });

      expect(store.has(sessionA, fp)).toBe(true);
      expect(store.has(sessionB, fp)).toBe(false);
      expect(store.get(sessionB, fp)).toBeUndefined();
    });

    it('clears session memory cleanly when job application finishes or resets', () => {
      const sessionId = 'session_to_clear';
      const fp = computeQuestionFingerprint('Relocation', 'linkedin');

      store.set({
        fingerprint: fp,
        sessionId,
        questionLabel: 'Relocation',
        normalizedQuestion: 'relocation',
        platform: 'linkedin',
        fieldType: 'text',
        answer: 'Yes',
        source: 'PROFILE_EXPLICIT',
        confidence: 'HIGH',
        userApproved: false,
        reason: 'Willing to relocate',
        resolvedAt: Date.now(),
      });

      expect(store.has(sessionId, fp)).toBe(true);
      store.clearSession(sessionId);
      expect(store.has(sessionId, fp)).toBe(false);
    });
  });

  describe('Radio Button & Option Matching Safety', () => {
    // Safe word-boundary option matching function tested in page.ts
    const matchesOptionSafe = (optionText: string, targetValue: string): boolean => {
      if (!optionText || !targetValue) return false;
      if (optionText === targetValue) return true;
      const cleanOpt = optionText
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      const cleanTgt = targetValue
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (cleanOpt === cleanTgt) return true;
      if (cleanTgt.length >= 4) {
        const rxTgt = new RegExp(`(?:^|\\s)${cleanTgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i');
        if (rxTgt.test(cleanOpt)) return true;
      }
      if (cleanOpt.length >= 4) {
        const rxOpt = new RegExp(`(?:^|\\s)${cleanOpt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i');
        if (rxOpt.test(cleanTgt)) return true;
      }
      return false;
    };

    it('rejects false substring matches where "no" would match words starting with no (e.g. "Notice")', () => {
      const targetNo = 'no';
      const candidateNotice = 'Notice period: 1 month';
      const candidateNorth = 'North America';
      const candidateNone = 'None of the above';

      expect(matchesOptionSafe(candidateNotice, targetNo)).toBe(false);
      expect(matchesOptionSafe(candidateNorth, targetNo)).toBe(false);
      // "no" is not an exact word in "Notice period" or "North America"
      expect(matchesOptionSafe('No', targetNo)).toBe(true);
      expect(matchesOptionSafe('no', targetNo)).toBe(true);
    });

    it('matches exact full text options with special characters and parentheses', () => {
      const option = 'Direct search (e.g., Google, company website)';
      const target = 'Direct search (e.g., Google, company website)';
      expect(matchesOptionSafe(option, target)).toBe(true);
    });

    it('matches options with word boundaries when candidate phrase appears cleanly', () => {
      const option = 'Immediate Joiner';
      const target = 'Immediate';
      expect(matchesOptionSafe(option, target)).toBe(true);
    });
  });
});
