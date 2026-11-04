import { describe, it, expect, beforeEach } from 'vitest';
import { SessionAnswerStore, computeQuestionFingerprint, normalizeQuestionText } from '../sessionAnswerStore';
import { resolveCurrentLocationFromProfileOrResume, matchRuleBased } from '../linkedin/formQuestionResolver';
import type { ICareerBrain } from '@extension/storage';

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

  describe('Current Location Resolution from Profile & Resume', () => {
    it('resolves location from careerBrain.currentLocation as highest priority', () => {
      const brain: Partial<ICareerBrain> = {
        currentLocation: 'Kolkata, West Bengal, India',
        resumeText: 'Location: Bengaluru, Karnataka, India\nFull Stack Developer',
      };
      const res = resolveCurrentLocationFromProfileOrResume(brain);
      expect(res).not.toBeNull();
      expect(res?.city).toBe('Kolkata');
      expect(res?.location).toBe('Kolkata, West Bengal, India');
      expect(res?.state).toBe('West Bengal');
      expect(res?.country).toBe('India');
      expect(res?.sourceDetail).toContain('profile: currentLocation');
    });

    it('extracts location from resume text when profile currentLocation is missing', () => {
      const brain: Partial<ICareerBrain> = {
        currentLocation: '',
        resumeText: 'John Doe\nSoftware Engineer\nLocation: Kolkata, West Bengal, India\nEmail: john@example.com',
      };
      const res = resolveCurrentLocationFromProfileOrResume(brain);
      expect(res).not.toBeNull();
      expect(res?.city).toBe('Kolkata');
      expect(res?.location).toBe('Kolkata, West Bengal, India');
      expect(res?.sourceDetail).toContain('resume: explicit location');
    });

    it('extracts location from resume header lines when no explicit prefix tag is used', () => {
      const brain: Partial<ICareerBrain> = {
        currentLocation: '',
        resumeText: 'Rahul Sharma\nKolkata, India | +91 9876543210 | rahul@example.com\nSummary: Software Engineer',
      };
      const res = resolveCurrentLocationFromProfileOrResume(brain);
      expect(res).not.toBeNull();
      expect(res?.city).toBe('Kolkata');
      expect(res?.country).toBe('India');
      expect(res?.sourceDetail).toContain('resume header: location');
    });

    it('returns null when neither profile nor resume contains location information', () => {
      const brain: Partial<ICareerBrain> = {
        currentLocation: '',
        preferredLocation: 'Bengaluru, India',
        resumeText: 'Senior Backend Developer with 5 years experience in Go, Node, React.',
      };
      const res = resolveCurrentLocationFromProfileOrResume(brain);
      expect(res).toBeNull();
    });

    it('matchRuleBased fills City field using candidate current location', () => {
      const brain = {
        currentLocation: 'Kolkata, West Bengal, India',
      } as ICareerBrain;

      const field = {
        id: 'city-input',
        name: 'city',
        label: 'City*',
        fieldType: 'text' as const,
      };

      const result = matchRuleBased(field, brain);
      expect(result.matched).toBe(true);
      expect(result.answer).toBe('Kolkata');
    });

    it('matchRuleBased fills Location field with full location string', () => {
      const brain = {
        currentLocation: 'Kolkata, West Bengal, India',
      } as ICareerBrain;

      const field = {
        id: 'location-input',
        name: 'location',
        label: 'Current Location',
        fieldType: 'text' as const,
      };

      const result = matchRuleBased(field, brain);
      expect(result.matched).toBe(true);
      expect(result.answer).toBe('Kolkata, West Bengal, India');
    });

    it('matchRuleBased accurately answers binary location screening questions', () => {
      const brain = {
        currentLocation: 'Kolkata, West Bengal, India',
      } as ICareerBrain;

      const kolkataField = {
        id: 'q1',
        name: 'q1',
        label: 'Are you currently located in Kolkata?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const kolkataRes = matchRuleBased(kolkataField, brain);
      expect(kolkataRes.matched).toBe(true);
      expect(kolkataRes.answer).toBe('Yes');

      const mumbaiField = {
        id: 'q2',
        name: 'q2',
        label: 'Are you currently located in Mumbai?',
        fieldType: 'radio' as const,
        options: ['Yes', 'No'],
      };
      const mumbaiRes = matchRuleBased(mumbaiField, brain);
      expect(mumbaiRes.matched).toBe(true);
      expect(mumbaiRes.answer).toBe('No');
    });

    it('matchRuleBased matches dropdown options accurately for current city', () => {
      const brain = {
        resumeText: 'Location: Kolkata, West Bengal, India\nFull Stack Engineer',
      } as ICareerBrain;

      const dropdownField = {
        id: 'city-select',
        name: 'city-select',
        label: 'Where are you currently located?',
        fieldType: 'dropdown' as const,
        options: ['Bengaluru, Karnataka', 'Mumbai, Maharashtra', 'Kolkata, West Bengal', 'New Delhi, Delhi'],
      };

      const result = matchRuleBased(dropdownField, brain);
      expect(result.matched).toBe(true);
      expect(result.answer).toBe('Kolkata, West Bengal');
    });

    it('matchRuleBased refuses to hallucinate when location is completely absent', () => {
      const brain = {
        currentLocation: '',
        preferredLocation: 'Bengaluru, Karnataka, India',
        resumeText: 'Full Stack Engineer with 4 years experience in Go and React.',
      } as ICareerBrain;

      const field = {
        id: 'city-input',
        name: 'city',
        label: 'City',
        fieldType: 'text' as const,
      };

      const result = matchRuleBased(field, brain);
      expect(result.matched).toBe(false);
    });
  });
});
