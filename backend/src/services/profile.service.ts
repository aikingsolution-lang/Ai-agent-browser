import { Types } from 'mongoose';
import { CareerBrain, type ICareerBrainDocument } from '../models/careerBrain.model.js';
import { Subscription } from '../models/subscription.model.js';
import { AppError } from '../middleware/errorHandler.js';
import type { ParsedResumeData } from '../schemas/resume.schema.js';

export interface QuotaStatus {
  allowed: boolean;
  appliedToday: number;
  dailyLimit: number;
  remaining: number;
  tier: 'free' | 'premium';
  lastResetDate: string;
}

export class ProfileService {
  private static getTodayString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Retrieves user's Career Brain profile by userId.
   */
  public static async getProfile(userId: string): Promise<ICareerBrainDocument | null> {
    const userObjectId = new Types.ObjectId(userId);
    return CareerBrain.findOne({ userId: userObjectId });
  }

  /**
   * Upserts the user's Career Brain profile from extension sync.
   */
  public static async syncProfile(
    userId: string,
    profileData: Partial<ICareerBrainDocument>,
  ): Promise<ICareerBrainDocument> {
    const userObjectId = new Types.ObjectId(userId);
    const today = this.getTodayString();

    const existing = await CareerBrain.findOne({ userId: userObjectId });

    if (!existing) {
      const newProfile = new CareerBrain({
        ...profileData,
        userId: userObjectId,
        tier: 'free',
        dailyQuota: {
          appliedToday: 0,
          dailyLimit: 15,
          lastResetDate: today,
        },
      });
      await newProfile.save();
      return newProfile;
    }

    // Preserve tier and daily quota while updating candidate profile data
    const updated = await CareerBrain.findOneAndUpdate(
      { userId: userObjectId },
      {
        $set: {
          fullName: profileData.fullName ?? existing.fullName,
          email: profileData.email ?? existing.email,
          phoneNumber: profileData.phoneNumber ?? existing.phoneNumber,
          currentTitle: profileData.currentTitle ?? existing.currentTitle,
          resumeText: profileData.resumeText ?? existing.resumeText,
          backgroundNarrative: profileData.backgroundNarrative ?? existing.backgroundNarrative,
          skills: profileData.skills ?? existing.skills,
          yearsOfExperience: profileData.yearsOfExperience ?? existing.yearsOfExperience,
          education: profileData.education ?? existing.education,
          noticePeriod: profileData.noticePeriod ?? existing.noticePeriod,
          workAuthorization: profileData.workAuthorization ?? existing.workAuthorization,
          salaryExpectation: profileData.salaryExpectation ?? existing.salaryExpectation,
          currentLocation: profileData.currentLocation ?? existing.currentLocation,
          preferredLocation: profileData.preferredLocation ?? existing.preferredLocation,
          preferredLocations: profileData.preferredLocations ?? existing.preferredLocations,
          portfolioUrl: profileData.portfolioUrl ?? existing.portfolioUrl,
          githubUrl: profileData.githubUrl ?? existing.githubUrl,
          linkedinUrl: profileData.linkedinUrl ?? existing.linkedinUrl,
          goldenAnswers: profileData.goldenAnswers ?? existing.goldenAnswers,
          customAnswers: profileData.customAnswers ?? existing.customAnswers,
          skillExperience: profileData.skillExperience ?? existing.skillExperience,
        },
      },
      { new: true, runValidators: true },
    );

    if (!updated) {
      throw new AppError('Failed to update Career Brain profile', 500, 'UPDATE_FAILED');
    }

    return updated;
  }

  /**
   * Atomically upserts Career Brain profile from parsed resume data.
   */
  public static async createOrUpdateFromResume(
    userId: string,
    parsed: ParsedResumeData,
    rawResumeText: string,
    fileName: string,
  ): Promise<ICareerBrainDocument> {
    const userObjectId = new Types.ObjectId(userId);
    const today = this.getTodayString();

    const existing = await CareerBrain.findOne({ userId: userObjectId });

    // When user uploads a new resume, completely overwrite old resume data with clean new parsed data
    const cleanSkillExp: Record<string, number> = {};
    if (parsed.skillExperience) {
      for (const [skill, yrs] of Object.entries(parsed.skillExperience)) {
        if (!skill || yrs === undefined || isNaN(Number(yrs))) continue;
        cleanSkillExp[skill] = Number(yrs);
      }
    }

    const updatePayload = {
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

    if (!existing) {
      const newProfile = new CareerBrain({
        ...updatePayload,
        userId: userObjectId,
        tier: 'free',
        dailyQuota: {
          appliedToday: 0,
          dailyLimit: 15,
          lastResetDate: today,
        },
      });
      await newProfile.save();
      return newProfile;
    }

    const updated = await CareerBrain.findOneAndUpdate(
      { userId: userObjectId },
      { $set: updatePayload },
      { new: true, runValidators: true },
    );

    if (!updated) {
      throw new AppError('Failed to update Career Brain profile from resume', 500, 'UPDATE_FAILED');
    }

    return updated;
  }

  /**
   * Resolves the maximum daily application limit based on the user's active subscription plan.
   * Free Trial / Default: 15/day
   * Starter Plan: 50/day
   * Pro Automation Plan: 100/day
   * Power Enterprise Plan: 500/day
   */
  public static async getDailyLimitForUser(userObjectId: Types.ObjectId): Promise<number> {
    const sub = await Subscription.findOne({
      userId: userObjectId,
      status: { $in: ['TRIALING', 'ACTIVE'] },
    }).sort({ createdAt: -1 });

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
   * Retrieves active daily quota with lazy reset.
   */
  public static async getQuota(userId: string): Promise<QuotaStatus> {
    const userObjectId = new Types.ObjectId(userId);
    const today = this.getTodayString();
    const expectedLimit = await this.getDailyLimitForUser(userObjectId);

    let profile = await CareerBrain.findOne({ userId: userObjectId });

    if (!profile) {
      // Return default free/tier quota status
      return {
        allowed: true,
        appliedToday: 0,
        dailyLimit: expectedLimit,
        remaining: expectedLimit,
        tier: expectedLimit > 15 ? 'premium' : 'free',
        lastResetDate: today,
      };
    }

    // Lazy reset if calendar date changed OR if subscription tier limit changed
    const needsDateReset = profile.dailyQuota.lastResetDate !== today;
    const needsLimitUpdate = profile.dailyQuota.dailyLimit !== expectedLimit;

    if (needsDateReset || needsLimitUpdate) {
      profile = await CareerBrain.findOneAndUpdate(
        { userId: userObjectId },
        {
          $set: {
            ...(needsDateReset ? { 'dailyQuota.appliedToday': 0, 'dailyQuota.lastResetDate': today } : {}),
            'dailyQuota.dailyLimit': expectedLimit,
            tier: expectedLimit > 15 ? 'premium' : 'free',
          },
        },
        { new: true },
      );
    }

    const appliedToday = profile?.dailyQuota.appliedToday ?? 0;
    const dailyLimit = profile?.dailyQuota.dailyLimit ?? expectedLimit;
    const remaining = Math.max(0, dailyLimit - appliedToday);

    return {
      allowed: remaining > 0,
      appliedToday,
      dailyLimit,
      remaining,
      tier: profile?.tier ?? (expectedLimit > 15 ? 'premium' : 'free'),
      lastResetDate: profile?.dailyQuota.lastResetDate ?? today,
    };
  }

  /**
   * Atomically verifies and increments daily application count using $inc.
   * Prevents race conditions and double-counting across concurrent requests.
   */
  public static async checkAndIncrementQuota(userId: string): Promise<QuotaStatus> {
    const userObjectId = new Types.ObjectId(userId);
    const today = this.getTodayString();
    const expectedLimit = await this.getDailyLimitForUser(userObjectId);

    let profile = await CareerBrain.findOne({ userId: userObjectId });

    if (!profile) {
      // Auto-create initial profile entry to track quota
      profile = new CareerBrain({
        userId: userObjectId,
        fullName: 'Candidate',
        email: 'user@example.com',
        phoneNumber: '+91 0000000000',
        currentTitle: 'Developer',
        resumeText: 'Auto-initialized Career Brain record.',
        tier: expectedLimit > 15 ? 'premium' : 'free',
        dailyQuota: {
          appliedToday: 0,
          dailyLimit: expectedLimit,
          lastResetDate: today,
        },
      });
      await profile.save();
    }

    // 1. Lazy reset if date rolled over OR if subscription tier limit updated
    const needsDateReset = profile.dailyQuota.lastResetDate !== today;
    const needsLimitUpdate = profile.dailyQuota.dailyLimit !== expectedLimit;

    if (needsDateReset || needsLimitUpdate) {
      await CareerBrain.updateOne(
        { userId: userObjectId },
        {
          $set: {
            ...(needsDateReset ? { 'dailyQuota.appliedToday': 0, 'dailyQuota.lastResetDate': today } : {}),
            'dailyQuota.dailyLimit': expectedLimit,
            tier: expectedLimit > 15 ? 'premium' : 'free',
          },
        },
      );
      profile.dailyQuota.dailyLimit = expectedLimit;
      if (needsDateReset) profile.dailyQuota.appliedToday = 0;
    }

    // 2. Atomic find and increment with quota boundary check
    const currentLimit = expectedLimit;

    const updated = await CareerBrain.findOneAndUpdate(
      {
        userId: userObjectId,
        'dailyQuota.appliedToday': { $lt: currentLimit },
      },
      {
        $inc: { 'dailyQuota.appliedToday': 1 },
      },
      { new: true },
    );

    if (!updated) {
      // Quota limit hit!
      const fresh = await CareerBrain.findOne({ userId: userObjectId });
      const appliedToday = fresh?.dailyQuota.appliedToday ?? currentLimit;

      return {
        allowed: false,
        appliedToday,
        dailyLimit: currentLimit,
        remaining: 0,
        tier: fresh?.tier ?? (expectedLimit > 15 ? 'premium' : 'free'),
        lastResetDate: fresh?.dailyQuota.lastResetDate ?? today,
      };
    }

    const appliedToday = updated.dailyQuota.appliedToday;
    const remaining = Math.max(0, currentLimit - appliedToday);

    return {
      allowed: true,
      appliedToday,
      dailyLimit: currentLimit,
      remaining,
      tier: updated.tier,
      lastResetDate: updated.dailyQuota.lastResetDate,
    };
  }

  /**
   * Upgrades user tier to Premium and sets plan-based quota (called by payment flows / webhooks).
   */
  public static async upgradeToPremium(userId: string, targetLimit?: number): Promise<ICareerBrainDocument | null> {
    const userObjectId = new Types.ObjectId(userId);
    const limit = targetLimit || (await this.getDailyLimitForUser(userObjectId));
    return CareerBrain.findOneAndUpdate(
      { userId: userObjectId },
      {
        $set: {
          tier: 'premium',
          'dailyQuota.dailyLimit': limit,
        },
      },
      { new: true },
    );
  }
}
