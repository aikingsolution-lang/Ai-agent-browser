import { describe, it, expect, beforeEach, vi } from 'vitest';

const { storageData } = vi.hoisted(() => {
  const data: Record<string, any> = {};
  const clone = (v: any) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const local = {
    get: async (keys?: string | string[] | null) => {
      if (!keys) return clone(data);
      const res: Record<string, any> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) res[k] = clone(data[k]);
      return res;
    },
    set: async (items: Record<string, any>) => {
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as any).chrome = {
    storage: { local, sync: local, session: local, onChanged: { addListener: () => undefined } },
  };
  return { storageData: data };
});

import {
  careerBrainStore,
  processedJobsStore,
  isGenericPlaceholderFieldLabel,
  DEFAULT_CAREER_BRAIN,
  NEGATIVE_CACHE_SCHEMA_VERSION,
  FAILED_JOB_TTL_MS,
} from '@extension/storage';

const BRAIN_KEY = 'linkedin_career_brain';
const JOBS_KEY = 'linkedin_processed_jobs';

function seedBrain(partial: Record<string, any>) {
  storageData[BRAIN_KEY] = { ...JSON.parse(JSON.stringify(DEFAULT_CAREER_BRAIN)), ...partial };
}

function seedJobs(data: Record<string, any>) {
  storageData[JOBS_KEY] = {
    appliedJobIds: [],
    skippedJobIds: [],
    records: [],
    failedJobs: {},
    ...data,
  };
}

describe('Placeholder field-label guard', () => {
  it('rejects labels emitted for unnamed form controls', () => {
    for (const label of ['', '  ', 'Form Field', 'Form Field *', 'field', 'Text', 'dropdown', 'Photo', '7', 'N/A']) {
      expect(isGenericPlaceholderFieldLabel(label), `expected "${label}" to be generic`).toBe(true);
    }
  });

  it('keeps real screening questions', () => {
    for (const label of [
      'Are you willing to relocate?',
      'What is your current CTC?',
      'How many years of React experience do you have?',
      'Notice period',
    ]) {
      expect(isGenericPlaceholderFieldLabel(label), `expected "${label}" to be real`).toBe(false);
    }
  });
});

describe('Career brain auto-migration purges polluted answers', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  });

  it('drops placeholder golden answers and custom answers on read while keeping real ones', async () => {
    seedBrain({
      goldenAnswers: [
        { id: 'ga_1', question: 'Form Field', answer: 'on' },
        { id: 'ga_2', question: 'Photo', answer: '0' },
        { id: 'ga_3', question: 'Are you willing to relocate?', answer: 'Yes' },
      ],
      customAnswers: { 'Form Field': 'on', 'Notice period': '30 days' },
    });

    const brain = await careerBrainStore.getCareerBrain();

    expect(brain.goldenAnswers.some(ga => ga.question === 'Form Field')).toBe(false);
    expect(brain.goldenAnswers.some(ga => ga.question === 'Photo')).toBe(false);
    expect(brain.goldenAnswers.some(ga => ga.question === 'Are you willing to relocate?')).toBe(true);
    expect(brain.customAnswers['Form Field']).toBeUndefined();
    expect(brain.customAnswers['Notice period']).toBe('30 days');
  });

  it('refuses to save a golden answer under a placeholder label', async () => {
    seedBrain({ goldenAnswers: [] });

    await careerBrainStore.saveGoldenAnswer('Form Field', 'on');
    await careerBrainStore.saveGoldenAnswer('Photo', '0');

    const brain = await careerBrainStore.getCareerBrain();
    expect(brain.goldenAnswers.some(ga => ga.question === 'Form Field')).toBe(false);
    expect(brain.goldenAnswers.some(ga => ga.question === 'Photo')).toBe(false);
  });

  it('refuses to save a custom answer under a placeholder label', async () => {
    seedBrain({ goldenAnswers: [] });

    await careerBrainStore.setCustomAnswer('Photo', '0');

    const brain = await careerBrainStore.getCareerBrain();
    expect(brain.customAnswers['Photo']).toBeUndefined();
  });
});

describe('Negative cache schema invalidation', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  });

  it('drops failures recorded by an older build so pre-fix jobs are retryable', async () => {
    seedJobs({
      failedJobs: { '111': { reason: 'Easy Apply modal failed to open within timeout', timestamp: Date.now() } },
      failedJobsCacheVersion: 1,
    });

    const res = await processedJobsStore.isJobRecentlyFailed('111');
    expect(res.recentlyFailed).toBe(false);
  });

  it('still blocks failures recorded by the current build inside the TTL', async () => {
    seedJobs({
      failedJobs: { '222': { reason: 'validation blocked', timestamp: Date.now() } },
      failedJobsCacheVersion: NEGATIVE_CACHE_SCHEMA_VERSION,
    });

    const res = await processedJobsStore.isJobRecentlyFailed('222');
    expect(res.recentlyFailed).toBe(true);
    expect(res.reason).toBe('validation blocked');
  });

  it('releases failures older than the 24h TTL', async () => {
    seedJobs({
      failedJobs: { '333': { reason: 'old', timestamp: Date.now() - FAILED_JOB_TTL_MS - 1000 } },
      failedJobsCacheVersion: NEGATIVE_CACHE_SCHEMA_VERSION,
    });

    const res = await processedJobsStore.isJobRecentlyFailed('333');
    expect(res.recentlyFailed).toBe(false);
  });
});
