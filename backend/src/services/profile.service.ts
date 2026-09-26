import { Types } from 'mongoose';
import { CareerBrain, type ICareerBrainDocument } from '../models/careerBrain.model.js';
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
          preferredLocation: profileData.preferredLocation ?? existing.preferredLocation,
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

    // 1. Skill Experience merge: CRITICAL - never overwrite existing manual entries
    const existingSkillExp: Record<string, number> = existing?.skillExperience
      ? existing.skillExperience instanceof Map
        ? Object.fromEntries(existing.skillExperience)
        : (existing.skillExperience as Record<string, number>)
      : {};
    const mergedSkillExp: Record<string, number> = { ...existingSkillExp };
    if (parsed.skillExperience) {
      for (const [skill, yrs] of Object.entries(parsed.skillExperience)) {
        if (!skill || yrs === undefined || isNaN(Number(yrs))) continue;
        const exists = Object.keys(existingSkillExp).some(k => k.toLowerCase() === skill.toLowerCase());
        if (!exists) {
          mergedSkillExp[skill] = Number(yrs);
        }
      }
    }

    // 2. Screening fields: Only populate if existing doesn't already have values
    const updatePayload = {
      fullName: parsed.fullName || existing?.fullName || 'Candidate',
      email: parsed.email || existing?.email || '',
      phoneNumber: parsed.phoneNumber || existing?.phoneNumber || '',
      currentTitle: parsed.currentTitle || existing?.currentTitle || 'Software Professional',
      resumeText: rawResumeText || parsed.backgroundNarrative || existing?.resumeText || '',
      resumeFileName: fileName,
      backgroundNarrative: parsed.backgroundNarrative || existing?.backgroundNarrative || '',
      skills: parsed.skills && parsed.skills.length > 0 ? parsed.skills : existing?.skills || [],
      yearsOfExperience:
        parsed.yearsOfExperience !== undefined && parsed.yearsOfExperience > 0
          ? parsed.yearsOfExperience
          : (existing?.yearsOfExperience ?? 0),
      education: parsed.education || existing?.education || '',
      college: parsed.college || existing?.college || '',
      cgpa: parsed.cgpa || existing?.cgpa || '',
      noticePeriod: parsed.noticePeriod || existing?.noticePeriod || 'Immediate',
      workHistory:
        parsed.workHistory && parsed.workHistory.length > 0 ? parsed.workHistory : existing?.workHistory || [],
      preferredLocation: parsed.preferredLocation || existing?.preferredLocation || '',
      workAuthorization:
        parsed.workAuthorization || existing?.workAuthorization || 'Authorized to work without sponsorship',
      skillExperience: mergedSkillExp,
      salaryExpectation: parsed.salaryExpectation || existing?.salaryExpectation || '',
      portfolioUrl: parsed.portfolioUrl || existing?.portfolioUrl || '',
      githubUrl: parsed.githubUrl || existing?.githubUrl || '',
      linkedinUrl: parsed.linkedinUrl || existing?.linkedinUrl || '',
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
   * Retrieves active daily quota with lazy reset.
   */
  public static async getQuota(userId: string): Promise<QuotaStatus> {
    const userObjectId = new Types.ObjectId(userId);
    const today = this.getTodayString();

    let profile = await CareerBrain.findOne({ userId: userObjectId });

    if (!profile) {
      // Return default free quota status
      return {
        allowed: true,
        appliedToday: 0,
        dailyLimit: 15,
        remaining: 15,
        tier: 'free',
        lastResetDate: today,
      };
    }

    // Lazy reset if calendar date changed
    if (profile.dailyQuota.lastResetDate !== today) {
      profile = await CareerBrain.findOneAndUpdate(
        { userId: userObjectId },
        {
          $set: {
            'dailyQuota.appliedToday': 0,
            'dailyQuota.lastResetDate': today,
          },
        },
        { new: true },
      );
    }

    const appliedToday = profile?.dailyQuota.appliedToday ?? 0;
    const dailyLimit = profile?.dailyQuota.dailyLimit ?? 15;
    const remaining = Math.max(0, dailyLimit - appliedToday);

    return {
      allowed: remaining > 0,
      appliedToday,
      dailyLimit,
      remaining,
      tier: profile?.tier ?? 'free',
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
        tier: 'free',
        dailyQuota: {
          appliedToday: 0,
          dailyLimit: 15,
          lastResetDate: today,
        },
      });
      await profile.save();
    }

    // 1. Lazy reset if date rolled over
    if (profile.dailyQuota.lastResetDate !== today) {
      await CareerBrain.updateOne(
        { userId: userObjectId },
        {
          $set: {
            'dailyQuota.appliedToday': 0,
            'dailyQuota.lastResetDate': today,
          },
        },
      );
    }

    // 2. Atomic find and increment with quota boundary check
    const currentLimit = profile.dailyQuota.dailyLimit;

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
        tier: fresh?.tier ?? 'free',
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
   * Upgrades user tier to Premium and sets 100/day quota (called by Razorpay webhook).
   */
  public static async upgradeToPremium(userId: string): Promise<ICareerBrainDocument | null> {
    const userObjectId = new Types.ObjectId(userId);
    return CareerBrain.findOneAndUpdate(
      { userId: userObjectId },
      {
        $set: {
          tier: 'premium',
          'dailyQuota.dailyLimit': 100,
        },
      },
      { new: true },
    );
  }
}
