/**
 * profile.service.ts
 *
 * Career Brain profile and daily application quota, backed by Firebase RTDB at
 * nanobrowser/career_brains/{uid} (previously the Mongo CareerBrain collection, unique per user).
 * Public methods, semantics and response shapes match the Mongo version.
 *
 * RTDB-specific handling:
 *   - Profile syncs use field-level update(), never a whole-node set, so they can't overwrite a
 *     concurrent quota increment (Mongo's $set only touched the listed fields too).
 *   - The quota check-and-increment is a transaction on the small dailyQuota node (Mongo's
 *     conditional $inc).
 *   - skillExperience / customAnswers are keyed by user text ("Node.js", questions with "/" …),
 *     which RTDB keys can't hold, so they're stored as entry lists and rebuilt as maps on read.
 */

import { AppError } from '../middleware/errorHandler.js';
import { CareerBrainRepository, SubscriptionRepository } from './rtdb/repositories.js';
import { stripUndefined, todayString } from './rtdb/rtdbUtils.js';
import { customAnswersToList, skillExperienceToList } from './rtdb/mappers.js';
import { toCareerBrainDto, type CareerBrainDto } from './rtdb/serializers.js';
import type { CareerBrainRecord, DailyQuotaRecord } from './rtdb/records.js';
import type { ParsedResumeData } from '../schemas/resume.schema.js';

export interface QuotaStatus {
  allowed: boolean;
  appliedToday: number;
  dailyLimit: number;
  remaining: number;
  tier: 'free' | 'premium';
  lastResetDate: string;
}

/** Fields the Mongo version updated on an existing profile during an extension sync. */
const SYNC_UPDATE_FIELDS = [
  'fullName',
  'email',
  'phoneNumber',
  'currentTitle',
  'resumeText',
  'backgroundNarrative',
  'skills',
  'yearsOfExperience',
  'education',
  'noticePeriod',
  'workAuthorization',
  'salaryExpectation',
  'currentLocation',
  'preferredLocation',
  'preferredLocations',
  'portfolioUrl',
  'githubUrl',
  'linkedinUrl',
  'goldenAnswers',
  'customAnswers',
  'skillExperience',
] as const;

/** All profile fields a client may set when the profile is first created. */
const CREATE_FIELDS = [
  ...SYNC_UPDATE_FIELDS,
  'resumeFileName',
  'hasWorkExperience',
  'workExperience',
  'college',
  'cgpa',
  'workHistory',
] as const;

const REQUIRED_ON_CREATE = ['fullName', 'email', 'currentTitle', 'resumeText'] as const;

type ApiProfileField = (typeof CREATE_FIELDS)[number];

function trimString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item !== null && item !== undefined).map(item => String(item));
}

function objectList<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return stripUndefined(value.filter(item => item !== null && typeof item === 'object')) as T[];
}

/**
 * Converts one API field value to its stored form (trimming strings and lowercasing the email
 * the way the Mongoose schema did). Returns [storedField, storedValue].
 */
function toStoredField(field: ApiProfileField, value: unknown): [string, unknown] {
  switch (field) {
    case 'email':
      return ['email', trimString(value).toLowerCase()];
    case 'skills':
    case 'preferredLocations':
      return [field, stringList(value)];
    case 'yearsOfExperience':
      return [field, Math.max(0, Number(value) || 0)];
    case 'hasWorkExperience':
      return [field, Boolean(value)];
    case 'workExperience':
    case 'workHistory':
    case 'goldenAnswers':
      return [field, objectList(value)];
    case 'skillExperience':
      return ['skillExperienceList', skillExperienceToList(value)];
    case 'customAnswers':
      return ['customAnswersList', customAnswersToList(value)];
    default:
      return [field, trimString(value)];
  }
}

function defaultQuota(dailyLimit: number, today: string): DailyQuotaRecord {
  return { appliedToday: 0, dailyLimit, lastResetDate: today };
}

/** A new profile with the Mongoose schema defaults. */
function newProfileRecord(uid: string, today: string, now: number): CareerBrainRecord {
  return {
    uid,
    fullName: '',
    email: '',
    phoneNumber: '',
    currentTitle: '',
    resumeText: '',
    resumeFileName: '',
    backgroundNarrative: '',
    skills: [],
    yearsOfExperience: 0,
    hasWorkExperience: true,
    workExperience: [],
    education: '',
    college: '',
    cgpa: '',
    workHistory: [],
    noticePeriod: 'Immediate',
    workAuthorization: 'Authorized to work',
    skillExperienceList: [],
    salaryExpectation: '',
    currentLocation: '',
    preferredLocation: '',
    preferredLocations: [],
    portfolioUrl: '',
    githubUrl: '',
    linkedinUrl: '',
    goldenAnswers: [],
    customAnswersList: [],
    tier: 'free',
    dailyQuota: defaultQuota(15, today),
    createdAt: now,
    updatedAt: now,
  };
}

function tierForLimit(limit: number): 'free' | 'premium' {
  return limit > 15 ? 'premium' : 'free';
}

export class ProfileService {
  private static getTodayString(): string {
    return todayString();
  }

  /**
   * Retrieves user's Career Brain profile by userId.
   */
  public static async getProfile(userId: string): Promise<CareerBrainDto | null> {
    const record = await CareerBrainRepository.get(userId);
    return record ? toCareerBrainDto(record) : null;
  }

  /**
   * Upserts the user's Career Brain profile from extension sync.
   * Tier and daily quota are never taken from the client.
   */
  public static async syncProfile(userId: string, profileData: Record<string, any>): Promise<CareerBrainDto> {
    const data = profileData && typeof profileData === 'object' ? profileData : {};
    const today = this.getTodayString();
    const now = Date.now();

    if (!(await CareerBrainRepository.exists(userId))) {
      const record = newProfileRecord(userId, today, now) as unknown as Record<string, unknown>;
      for (const field of CREATE_FIELDS) {
        if (data[field] === undefined || data[field] === null) continue;
        const [storedField, storedValue] = toStoredField(field, data[field]);
        record[storedField] = storedValue;
      }

      const missing = REQUIRED_ON_CREATE.filter(field => !record[field]);
      if (missing.length > 0) {
        throw new AppError(`Career Brain validation failed: ${missing.join(', ')} required`, 400, 'VALIDATION_ERROR');
      }

      if (await CareerBrainRepository.createIfMissing(userId, record as unknown as CareerBrainRecord)) {
        return toCareerBrainDto(record as unknown as CareerBrainRecord);
      }
      // Another request created it first: fall through and update it.
    }

    // Preserve tier and daily quota while updating candidate profile data
    const patch: Record<string, unknown> = {};
    for (const field of SYNC_UPDATE_FIELDS) {
      if (data[field] === undefined || data[field] === null) continue;
      const [storedField, storedValue] = toStoredField(field, data[field]);
      patch[storedField] = storedValue;
    }
    patch.updatedAt = now;
    await CareerBrainRepository.update(userId, patch);

    const updated = await CareerBrainRepository.get(userId);
    if (!updated) {
      throw new AppError('Failed to update Career Brain profile', 500, 'UPDATE_FAILED');
    }
    return toCareerBrainDto(updated);
  }

  /**
   * Upserts the Career Brain profile from parsed resume data (overwrites the resume-derived
   * fields with the newly parsed values, as before).
   */
  public static async createOrUpdateFromResume(
    userId: string,
    parsed: ParsedResumeData,
    rawResumeText: string,
    fileName: string,
  ): Promise<CareerBrainDto> {
    const today = this.getTodayString();
    const now = Date.now();
    const existing = await CareerBrainRepository.get(userId);

    const cleanSkillExp: Record<string, number> = {};
    if (parsed.skillExperience) {
      for (const [skill, yrs] of Object.entries(parsed.skillExperience)) {
        if (!skill || yrs === undefined || isNaN(Number(yrs))) continue;
        cleanSkillExp[skill] = Number(yrs);
      }
    }

    const updatePayload: Partial<Record<ApiProfileField, unknown>> = {
      fullName: parsed.fullName?.trim() || existing?.fullName || 'Candidate',
      email: parsed.email?.trim() || existing?.email || '',
      phoneNumber: parsed.phoneNumber?.trim() || '',
      currentTitle: parsed.currentTitle?.trim() || 'Software Professional',
      resumeText: rawResumeText || parsed.backgroundNarrative || '',
      resumeFileName: fileName,
      backgroundNarrative: parsed.backgroundNarrative || '',
      skills: parsed.skills && parsed.skills.length > 0 ? parsed.skills : Object.keys(cleanSkillExp),
      yearsOfExperience: parsed.yearsOfExperience !== undefined ? parsed.yearsOfExperience : 0,
      education: parsed.education || '',
      college: parsed.college || '',
      cgpa: parsed.cgpa || '',
      noticePeriod: parsed.noticePeriod || 'Immediate',
      workHistory: parsed.workHistory || [],
      currentLocation: parsed.currentLocation || '',
      preferredLocation: parsed.preferredLocation || '',
      preferredLocations: parsed.preferredLocations || [],
      workAuthorization: parsed.workAuthorization || 'Authorized to work without sponsorship',
      skillExperience: cleanSkillExp,
      salaryExpectation: parsed.salaryExpectation || '',
      goldenAnswers: parsed.goldenAnswers && parsed.goldenAnswers.length > 0 ? parsed.goldenAnswers : [],
      portfolioUrl: parsed.portfolioUrl || '',
      githubUrl: parsed.githubUrl || '',
      linkedinUrl: parsed.linkedinUrl || '',
    };

    const stored: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(updatePayload)) {
      const [storedField, storedValue] = toStoredField(field as ApiProfileField, value);
      stored[storedField] = storedValue;
    }

    if (!existing) {
      const record = { ...newProfileRecord(userId, today, now), ...stored } as CareerBrainRecord;
      if (await CareerBrainRepository.createIfMissing(userId, record)) {
        return toCareerBrainDto(record);
      }
    }

    await CareerBrainRepository.update(userId, { ...stored, updatedAt: now });
    const updated = await CareerBrainRepository.get(userId);
    if (!updated) {
      throw new AppError('Failed to update Career Brain profile from resume', 500, 'UPDATE_FAILED');
    }
    return toCareerBrainDto(updated);
  }

  /**
   * Resolves the maximum daily application limit based on the user's active subscription plan.
   * Free Trial / Default: 15/day
   * Starter Plan: 50/day
   * Pro Automation Plan: 100/day
   * Power Enterprise Plan: 500/day
   */
  public static async getDailyLimitForUser(userId: string): Promise<number> {
    const sub = await SubscriptionRepository.getCurrent(userId);

    if (!sub || sub.status !== 'ACTIVE') {
      return 15;
    }

    switch (sub.planCodeSnapshot) {
      case 'power':
        return 500;
      case 'pro':
        return 100;
      case 'starter':
        return 50;
      default:
        return 50;
    }
  }

  /**
   * Retrieves active daily quota with lazy reset (calendar day rollover or plan limit change).
   */
  public static async getQuota(userId: string): Promise<QuotaStatus> {
    const today = this.getTodayString();
    const expectedLimit = await this.getDailyLimitForUser(userId);

    if (!(await CareerBrainRepository.exists(userId))) {
      // Return default free/tier quota status
      return {
        allowed: true,
        appliedToday: 0,
        dailyLimit: expectedLimit,
        remaining: expectedLimit,
        tier: tierForLimit(expectedLimit),
        lastResetDate: today,
      };
    }

    let changed = false;
    const quota = await CareerBrainRepository.transactQuota(userId, defaultQuota(expectedLimit, today), current => {
      changed = false;
      const needsDateReset = current.lastResetDate !== today;
      const needsLimitUpdate = current.dailyLimit !== expectedLimit;
      if (!needsDateReset && !needsLimitUpdate) return current;
      changed = true;
      return {
        appliedToday: needsDateReset ? 0 : current.appliedToday,
        lastResetDate: needsDateReset ? today : current.lastResetDate,
        dailyLimit: expectedLimit,
      };
    });

    let tier: 'free' | 'premium';
    if (changed) {
      tier = tierForLimit(expectedLimit);
      await CareerBrainRepository.update(userId, { tier, updatedAt: Date.now() });
    } else {
      tier = (await CareerBrainRepository.getTier(userId)) ?? tierForLimit(expectedLimit);
    }

    const appliedToday = quota.appliedToday ?? 0;
    const dailyLimit = quota.dailyLimit ?? expectedLimit;
    const remaining = Math.max(0, dailyLimit - appliedToday);

    return {
      allowed: remaining > 0,
      appliedToday,
      dailyLimit,
      remaining,
      tier,
      lastResetDate: quota.lastResetDate ?? today,
    };
  }

  /**
   * Atomically verifies and increments the daily application count.
   * Prevents race conditions and double-counting across concurrent requests.
   */
  public static async checkAndIncrementQuota(userId: string): Promise<QuotaStatus> {
    const today = this.getTodayString();
    const expectedLimit = await this.getDailyLimitForUser(userId);

    if (!(await CareerBrainRepository.exists(userId))) {
      // Auto-create initial profile entry to track quota
      const placeholder: CareerBrainRecord = {
        ...newProfileRecord(userId, today, Date.now()),
        fullName: 'Candidate',
        email: 'user@example.com',
        phoneNumber: '+91 0000000000',
        currentTitle: 'Developer',
        resumeText: 'Auto-initialized Career Brain record.',
        tier: tierForLimit(expectedLimit),
        dailyQuota: defaultQuota(expectedLimit, today),
      };
      await CareerBrainRepository.createIfMissing(userId, placeholder);
    }

    let allowed = false;
    let settingsChanged = false;
    const quota = await CareerBrainRepository.transactQuota(userId, defaultQuota(expectedLimit, today), current => {
      allowed = false;
      settingsChanged = false;
      // 1. Lazy reset if the date rolled over or the subscription limit changed
      const needsDateReset = current.lastResetDate !== today;
      const next: DailyQuotaRecord = {
        appliedToday: needsDateReset ? 0 : current.appliedToday || 0,
        lastResetDate: needsDateReset ? today : current.lastResetDate,
        dailyLimit: expectedLimit,
      };
      settingsChanged = needsDateReset || current.dailyLimit !== expectedLimit;

      // 2. Increment only while under the limit
      if (next.appliedToday < expectedLimit) {
        allowed = true;
        next.appliedToday += 1;
      }
      return next;
    });

    if (settingsChanged) {
      await CareerBrainRepository.update(userId, { tier: tierForLimit(expectedLimit), updatedAt: Date.now() });
    }
    const tier = settingsChanged
      ? tierForLimit(expectedLimit)
      : ((await CareerBrainRepository.getTier(userId)) ?? tierForLimit(expectedLimit));

    const appliedToday = quota.appliedToday;
    return {
      allowed,
      appliedToday,
      dailyLimit: expectedLimit,
      remaining: allowed ? Math.max(0, expectedLimit - appliedToday) : 0,
      tier,
      lastResetDate: quota.lastResetDate,
    };
  }

  /**
   * Upgrades user tier to Premium and sets the plan-based quota (called by payment flows / webhooks).
   * Like the Mongo version, does nothing when the user has no Career Brain profile yet.
   */
  public static async upgradeToPremium(userId: string, targetLimit?: number): Promise<CareerBrainDto | null> {
    const limit = targetLimit || (await this.getDailyLimitForUser(userId));
    if (!(await CareerBrainRepository.exists(userId))) {
      return null;
    }
    await CareerBrainRepository.update(userId, {
      tier: 'premium',
      'dailyQuota/dailyLimit': limit,
      updatedAt: Date.now(),
    });
    return this.getProfile(userId);
  }
}
