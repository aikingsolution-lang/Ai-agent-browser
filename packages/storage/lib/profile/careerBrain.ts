import { z } from 'zod';
import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { areQuestionsSemanticallyEquivalent } from './questionSemanticMatcher';
import { extractResumeFocusTags } from './resumeTagMatcher';

// ─── 1. The Strict Schema Layer ─────────────────────────────────────────────

/**
 * Schema for Golden Q&A screening items.
 * Ensures user does not leave question or answer blank.
 */
export const goldenAnswerSchema = z.object({
  id: z.string(),
  question: z.string().trim().min(1, 'Question text cannot be empty'),
  answer: z.string().trim().min(1, 'Answer text cannot be empty'),
  category: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export type IGoldenAnswer = z.infer<typeof goldenAnswerSchema>;

/**
 * Detects generic relative date screening questions for work history, such as:
 * "Month of From", "Year of From", "Month of To", "Year of To", "From: Month", etc.
 * These are job/position specific and must NEVER be stored as generic golden answers.
 */
export function isGenericWorkExperienceDateField(question: string): boolean {
  if (!question || typeof question !== 'string') return false;
  const q = question.trim().toLowerCase();
  if (
    /how\s*many|years\s*of\s*(?:total\s*|overall\s*)?experience|notice\s*period|ctc|salary|when\s*can\s*you/i.test(q)
  ) {
    return false;
  }
  return (
    /\b(?:from|start)\s*(?:month|year|date)\b|\b(?:to|end|completion|finish)\s*(?:month|year|date)\b|\b(?:month|year)\s+(?:of\s+)?(?:from|start|to|end)\b|\b(?:from|to)\s*:\s*(?:month|year)\b/i.test(
      q,
    ) || /^(?:start|from|end|to)\s*(?:month|year)$/i.test(q)
  );
}

/**
 * Detects social media, platform profile, or URL screening questions that should NOT be stored as golden answers.
 * e.g., "Facebook", "X (formerly Twitter)", "Twitter", "Instagram", "TikTok", etc.
 */
export function isSocialMediaOrUrlQuestion(question: string): boolean {
  if (!question || typeof question !== 'string') return false;
  const q = question.trim().toLowerCase();
  return (
    /^(?:facebook|x\s*\(formerly\s*twitter\)|twitter|instagram|tiktok|social\s*media|social\s*profile|linkedin\s*profile|github\s*profile|portfolio\s*url)$/i.test(
      q,
    ) ||
    /^(?:enter|your|provide|link\s*to)?\s*(?:facebook|twitter|instagram|tiktok)\s*(?:profile|url|link|handle)?$/i.test(
      q,
    ) ||
    q === 'x' ||
    q === 'facebook' ||
    q === 'twitter'
  );
}

/**
 * Detects questions that can and should be answered dynamically from Candidate Background Narrative,
 * resume work history, or dedicated profile fields (e.g. years of experience, highest degree,
 * current/expected CTC, notice period, technical skills, employment status).
 * These must be excluded from Golden Q&A to avoid conflicting/overlapping answers.
 */
export const NARRATIVE_OVERLAPPING_QUESTION_IDS = new Set([
  'experience_years',
  'highest_education',
  'current_ctc',
  'expected_ctc',
  'salary_range_acceptable',
  'notice_period',
  'currently_employed',
  'skill_react_exp',
  'skill_node_exp',
  'skill_sql_exp',
  'production_llm_shipped',
  'date_of_birth',
]);

export function isNarrativeAnswerableQuestion(question?: string, id?: string): boolean {
  if (id && NARRATIVE_OVERLAPPING_QUESTION_IDS.has(id)) return true;
  if (!question || typeof question !== 'string') return false;
  const q = question.toLowerCase().trim();
  return (
    /how\s*many|total\s*(?:years|yrs)|years\s*of\s*(?:total\s*|overall\s*)?experience|relevant\s*experience/i.test(q) ||
    /highest\s*(?:completed\s*)?(?:level\s*of\s*)?education|highest\s*degree|highest\s*qualification/i.test(q) ||
    /current\s*ctc|expected\s*ctc|current\s*salary|expected\s*salary|salary\s*expectation|ctc\s*\(annual\)/i.test(q) ||
    /notice\s*period|when\s*can\s*you\s*join|availability\s*period/i.test(q) ||
    /^are\s*you\s*currently\s*employed\??$/i.test(q) ||
    /\b(?:react|node|python|java|javascript|typescript|sql|aws|docker)\b.*(?:experience|years|yrs)/i.test(q)
  );
}

/**
 * Priority order rank for sorting golden answers in real-world application sequence:
 * 1. Work Authorization & Legal Eligibility (Gating)
 * 2. Location & Relocation
 * 3. Notice Period & Immediate Availability
 * 4. Compensation & CTC
 * 5. Experience & Core Skills
 * 6. Recruiter Yes/No Screening & Compliance
 * 7. Schedule, Shifts & Timezone
 * 8. Diversity & Self-Identification
 * 9. Custom Rules
 */
export function getGoldenAnswerPriorityWeight(item: IGoldenAnswer): number {
  const q = (item.question || '').toLowerCase();
  const id = (item.id || '').toLowerCase();
  const cat = (item.category || '').toLowerCase();

  // 1. Work Authorization & Sponsorship & Legal Eligibility (Top Gatekeepers)
  if (
    id.includes('work_auth') ||
    q.includes('authorized to work') ||
    q.includes('legally authorized') ||
    q.includes('work authorization')
  )
    return 10;
  if (id.includes('visa') || q.includes('sponsorship') || q.includes('require visa')) return 11;
  if (id.includes('age') || q.includes('18 years') || q.includes('18 or older')) return 12;
  if (id.includes('security_clearance') || q.includes('security clearance')) return 13;
  if (id.includes('non_compete') || q.includes('non-compete')) return 14;
  if (id.includes('felony') || q.includes('felony') || q.includes('criminal')) return 15;

  // 2. Location & Relocation
  if (id.includes('location') || q.includes('city of residence') || q.includes('current location')) return 20;
  if (id.includes('relocation') || q.includes('relocate')) return 21;
  if (id.includes('work_mode') || q.includes('remote') || q.includes('hybrid') || q.includes('office')) return 22;
  if (id.includes('commute') || q.includes('commute')) return 23;

  // 3. Notice Period & Availability to Start
  if (id.includes('notice_period') || q.includes('notice period') || q.includes('when can you join')) return 30;
  if (id.includes('start_immediately') || q.includes('start immediately')) return 31;

  // 4. Compensation / CTC
  if (id.includes('current_ctc') || q.includes('current ctc') || q.includes('current salary')) return 40;
  if (id.includes('expected_ctc') || q.includes('expected ctc') || q.includes('expected salary')) return 41;
  if (id.includes('salary_range') || q.includes('salary range')) return 42;

  // 5. Total Experience & Core Skills
  if (id.includes('experience_years') || q.includes('total years of') || q.includes('overall experience')) return 50;
  if (
    id.includes('highest_education') ||
    q.includes('highest level of completed education') ||
    q.includes('education level')
  )
    return 51;
  if (id.includes('react') || q.includes('react')) return 52;
  if (id.includes('node') || q.includes('node')) return 53;
  if (id.includes('sql') || q.includes('sql')) return 54;
  if (id.includes('production_llm') || q.includes('llm') || q.includes('ai')) return 55;

  // 6. Recruiter Yes/No Screening
  if (id.includes('driver_license') || q.includes('driver')) return 60;
  if (id.includes('background_check') || q.includes('background')) return 61;
  if (id.includes('drug_test') || q.includes('drug')) return 62;
  if (id.includes('currently_employed') || q.includes('currently employed')) return 63;
  if (id.includes('former_employee') || q.includes('previously worked')) return 64;

  // 7. Shifts & Schedules
  if (id.includes('preferred_shift') || q.includes('preferred shift')) return 70;
  if (id.includes('shift_flexibility') || q.includes('weekends') || q.includes('on-call')) return 71;
  if (id.includes('timezone_overlap') || q.includes('timezone') || q.includes('us hours')) return 72;

  // 8. Diversity & Self-Identification
  if (id.includes('gender') || q.includes('gender')) return 80;
  if (id.includes('date_of_birth') || q.includes('date of birth') || q.includes('dob')) return 81;
  if (id.includes('veteran') || q.includes('veteran')) return 82;
  if (id.includes('disability') || q.includes('disability')) return 83;

  // Fallbacks by category
  if (cat.includes('eligibility') || cat.includes('legal')) return 16;
  if (cat.includes('location')) return 24;
  if (cat.includes('availability')) return 32;
  if (cat.includes('compensation')) return 43;
  if (cat.includes('experience') || cat.includes('education')) return 56;
  if (cat.includes('screening')) return 65;
  if (cat.includes('diversity')) return 84;

  return 99;
}

export function sortGoldenAnswersByPriority(items: IGoldenAnswer[]): IGoldenAnswer[] {
  return [...items].sort((a, b) => getGoldenAnswerPriorityWeight(a) - getGoldenAnswerPriorityWeight(b));
}

/**
 * Cleans a location string to extract a clean city / geographic location.
 * Strips out "or Remote", "(Remote)", "Remote /", "Hybrid", etc.
 * E.g., "Bengaluru, India or Remote" -> "Bengaluru, India".
 */
export function cleanLocationForCityField(rawLocation: string | undefined | null): string {
  if (!rawLocation || typeof rawLocation !== 'string') return '';
  let loc = rawLocation.trim();
  loc = loc
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*remote\b/gi, '')
    .replace(/\bremote\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(remote\)/gi, '')
    .replace(/\[remote\]/gi, '')
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*hybrid\b/gi, '')
    .replace(/\bhybrid\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(hybrid\)/gi, '')
    .replace(/\[hybrid\]/gi, '')
    .replace(/\s*,\s*remote\b/gi, '')
    .replace(/\bremote\s*,\s*/gi, '')
    .replace(/\bremote\b/gi, '')
    .replace(/^[,\-\s/\\|]+|[,\-\s/\\|]+$/g, '')
    .trim();
  return loc;
}

/**
 * Common technical job title keywords. Used to identify whether a string
 * resembles an actual job role rather than an arbitrary personal name.
 */
export const RECOGNIZED_ROLE_KEYWORDS_REGEX =
  /\b(developer|engineer|architect|programmer|lead|manager|analyst|designer|consultant|specialist|tester|devops|administrator|intern|sde|scientist|associate|officer|executive|technician|full\s*stack|frontend|backend|mern|mean|software|web|mobile|cloud|data|ai|ml|ui|ux|tech|qa|support|coder|sre|sysadmin)\b/i;

/**
 * Detects whether a string is a candidate's personal name, empty, or an invalid job title placeholder
 * (e.g. "MUBASSHIR ALI", "Mubasshir", "Candidate", "Software Professional", "N/A").
 * Used to prevent personal candidate names from being populated into search queries or job target roles.
 */
export function isCandidateNameOrInvalidTitle(
  title: string | undefined | null,
  fullNameOrNames?: string | (string | undefined | null)[] | null,
): boolean {
  if (!title || typeof title !== 'string' || !title.trim()) return true;
  const cleanTitle = title.trim().toLowerCase();

  // 1. Generic placeholder strings that are not real target roles
  const invalidPlaceholders = new Set([
    'candidate',
    'professional',
    'software professional',
    'user',
    'applicant',
    'n/a',
    'na',
    'none',
    'null',
    'undefined',
    'title',
    'job title',
    'developer',
    'engineer',
    'job seeker',
    'fresher',
    'student',
    'employee',
  ]);
  if (invalidPlaceholders.has(cleanTitle)) return true;

  // 2. Personal candidate name matching
  const rawNames = Array.isArray(fullNameOrNames) ? fullNameOrNames : [fullNameOrNames];
  const candidateNames = rawNames
    .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
    .map(n => n.trim().toLowerCase())
    .filter(n => !invalidPlaceholders.has(n));

  const roleKeywordsRegex = RECOGNIZED_ROLE_KEYWORDS_REGEX;

  for (const cleanFull of candidateNames) {
    // Exact match: title is identical to full name (e.g. "Mubasshir Ali" === "Mubasshir Ali")
    if (cleanTitle === cleanFull) return true;

    // Tokenize full name into individual names (e.g. ["mubasshir", "ali"])
    const nameTokens = cleanFull
      .split(/[\s,.-]+/)
      .map(t => t.trim())
      .filter(t => t.length > 1 && !roleKeywordsRegex.test(t));

    // Title equals an individual name token (e.g. "Mubasshir" or "Ali")
    if (nameTokens.includes(cleanTitle)) return true;

    // All words in the title are tokens of candidate name
    const titleTokens = cleanTitle.split(/[\s,.-]+/).filter(t => t.length > 0);
    if (titleTokens.length > 0 && titleTokens.every(t => nameTokens.includes(t))) return true;

    // Title contains any multi-char name token (>= 3 chars) as a distinct word boundary
    for (const token of nameTokens) {
      if (token.length >= 3) {
        const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
        if (tokenRegex.test(cleanTitle)) {
          return true;
        }
      }
    }

    // Title is contained in candidate name or vice versa, and contains no common tech/role words
    const hasRoleKeyword = roleKeywordsRegex.test(cleanTitle);
    if (!hasRoleKeyword && (cleanFull.includes(cleanTitle) || cleanTitle.includes(cleanFull))) {
      return true;
    }
  }

  // 3. Fallback: if string lacks ANY recognized job role keywords and consists purely of 1-3 alphabetical words
  // (e.g. "Mubasshir Ali", "John Smith"), treat as personal name / invalid title
  const hasRecognizedRoleWord = roleKeywordsRegex.test(cleanTitle);
  if (!hasRecognizedRoleWord) {
    if (/^[a-zA-Z\s.-]+$/.test(cleanTitle) && cleanTitle.split(/\s+/).length <= 3) {
      return true;
    }
  }

  return false;
}

/**
 * Robust, defensive sanitizer for job search queries.
 * Ensures the search query NEVER contains or equals the candidate's personal name.
 * If candidate name tokens are found within a compound title (e.g. "Mubasshir Ali - Full Stack Developer"),
 * strips the name and retains the valid role.
 * If the role is purely the candidate's name or is invalid, rejects it and safely falls back
 * to the user's explicitly configured role or a sensible default ("Full Stack Developer").
 */
export function sanitizeRoleSearchQuery(
  role: string | undefined | null,
  candidateNames?: string | (string | undefined | null)[] | null,
  fallbackRole: string = 'Full Stack Developer',
): string {
  const safeFallback = (fallbackRole || 'Full Stack Developer').trim();
  const rawRole = (role || '').trim();

  if (!rawRole) {
    return safeFallback;
  }

  const rawNames = Array.isArray(candidateNames) ? candidateNames : [candidateNames];
  const validCandidateNames = rawNames
    .filter((n): n is string => typeof n === 'string' && Boolean(n.trim()))
    .map(n => n.trim());

  // Extract all individual name tokens (length >= 3) to strip or detect
  const nameTokens: string[] = [];
  for (const n of validCandidateNames) {
    const tokens = n
      .toLowerCase()
      .split(/[\s,.-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !RECOGNIZED_ROLE_KEYWORDS_REGEX.test(t));
    for (const t of tokens) {
      if (!nameTokens.includes(t)) {
        nameTokens.push(t);
      }
    }
  }

  // Attempt to strip candidate name tokens from compound strings (e.g. "Mubasshir Ali - Full Stack Developer")
  let strippedRole = rawRole;
  for (const name of validCandidateNames) {
    if (name.length >= 3) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      strippedRole = strippedRole.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
    }
  }
  for (const token of nameTokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    strippedRole = strippedRole.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), '');
  }

  // Clean remaining punctuation and whitespace
  strippedRole = strippedRole
    .replace(/^[\s\-_:|,/]+|[\s\-_:|,/]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // If stripping left a valid role that does NOT match candidate name and has recognized keywords
  if (strippedRole && !isCandidateNameOrInvalidTitle(strippedRole, validCandidateNames)) {
    return strippedRole;
  }

  // If strippedRole is still invalid or empty, check original rawRole
  if (!isCandidateNameOrInvalidTitle(rawRole, validCandidateNames)) {
    return rawRole;
  }

  // Fallback triggered: log warning as this indicates something upstream tried to use candidate name
  console.warn(
    `[CareerBrain] ⚠️ Sanitizer rejected candidate name or invalid role query "${rawRole}". Falling back to configured/default role "${safeFallback}".`,
  );
  return safeFallback;
}

export function cleanSkillKey(skill: string | undefined | null): string {
  if (!skill || typeof skill !== 'string') return '';
  return skill
    .trim()
    .replace(/^[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+|[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+$/g, '')
    .trim();
}

/**
 * Sanitizes and purges fabricated/hallucinated skillExperience entries from storage.
 * Detects uniform defaults (e.g. 4+ skills with "5 years" for an intern) or skills
 * exceeding verifiable tenure without explicit textual grounding.
 */
export function sanitizeStoredSkillExperience(
  rawSkillExp: Record<string, number> | undefined | null,
  workExp?: Array<{
    company?: string;
    title?: string;
    startYear?: string | number;
    endYear?: string | null | number;
    isCurrent?: boolean;
    description?: string;
  }> | null,
  rawResumeText?: string | null,
  overallYoe?: number | string | null,
): Record<string, number> {
  if (!rawSkillExp || typeof rawSkillExp !== 'object') return {};

  const cleanExp: Record<string, number> = {};
  const currentYear = new Date().getFullYear();

  let maxVerifiableTenure = 0;
  const validWorkExp = Array.isArray(workExp) ? workExp : [];

  for (const role of validWorkExp) {
    if (!role) continue;
    const startYr = parseInt(String(role.startYear || ''), 10);
    if (!isNaN(startYr) && startYr >= 1970 && startYr <= currentYear + 1) {
      const endYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
      const tenure = Math.max(0, (!isNaN(endYr) ? endYr : currentYear) - startYr);
      if (tenure > maxVerifiableTenure) {
        maxVerifiableTenure = tenure;
      }
    }
  }

  if (overallYoe !== undefined && overallYoe !== null) {
    const numYoe = parseInt(String(overallYoe), 10);
    if (!isNaN(numYoe) && numYoe >= 0) {
      if (validWorkExp.length === 0) {
        maxVerifiableTenure = numYoe;
      } else {
        maxVerifiableTenure = Math.max(maxVerifiableTenure, numYoe);
      }
    }
  }

  const entries = Object.entries(rawSkillExp);
  const valueCounts = new Map<number, number>();
  for (const [_, val] of entries) {
    if (typeof val === 'number' && !isNaN(val) && val > 0) {
      valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
    }
  }

  const suspectedFabricatedValues = new Set<number>();
  for (const [val, count] of valueCounts.entries()) {
    if (count >= 4 && val > Math.max(1, maxVerifiableTenure)) {
      suspectedFabricatedValues.add(val);
    }
  }

  for (const [skill, claimedYears] of entries) {
    if (!skill || typeof claimedYears !== 'number' || isNaN(claimedYears) || claimedYears <= 0) {
      continue;
    }
    const clean = cleanSkillKey(skill);
    if (!clean || clean.length > 35) continue;

    // Check if resume text explicitly states duration
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicitRegex = new RegExp(
      `(?:\\b${escaped}\\b[^\\n\\r,]{0,35}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?)|(?:(?:for|with)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,35}?\\b${escaped}\\b)`,
      'i',
    );
    const textMatch = rawResumeText ? rawResumeText.match(explicitRegex) : null;

    if (textMatch) {
      const explicitNum = parseFloat(textMatch[1] || textMatch[2]);
      if (!isNaN(explicitNum) && explicitNum > 0) {
        cleanExp[clean] = Math.round(explicitNum);
        continue;
      }
    }

    const isFabricatedValue = suspectedFabricatedValues.has(claimedYears);

    let skillRoleTenure: number | null = null;
    const lowerSkill = clean.toLowerCase();

    for (const role of validWorkExp) {
      const roleText = `${role.title || ''} ${role.company || ''} ${role.description || ''}`.toLowerCase();
      if (roleText.includes(lowerSkill)) {
        const sYr = parseInt(String(role.startYear || ''), 10);
        if (!isNaN(sYr)) {
          const eYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
          const rTenure = Math.max(0, (!isNaN(eYr) ? eYr : currentYear) - sYr);
          skillRoleTenure = Math.max(skillRoleTenure ?? 0, rTenure);
        }
      }
    }

    const effectiveMaxTenure = Math.max(1, maxVerifiableTenure);

    if (skillRoleTenure !== null) {
      const verifiedYears = Math.min(claimedYears, Math.max(1, skillRoleTenure), effectiveMaxTenure);
      cleanExp[clean] = verifiedYears;
    } else {
      if (isFabricatedValue || claimedYears > effectiveMaxTenure) {
        continue;
      }
      if (claimedYears <= effectiveMaxTenure) {
        cleanExp[clean] = claimedYears;
      }
    }
  }

  return cleanExp;
}

/**
 * Schema for structured candidate work experience.
 */
export const workExperienceItemSchema = z.object({
  id: z.string(),
  company: z.string().trim().min(1, 'Company is required'),
  title: z.string().trim().min(1, 'Job title is required'),
  startMonth: z.string().default(''),
  startYear: z.string().default(''),
  endMonth: z.string().nullable().default(null),
  endYear: z.string().nullable().default(null),
  isCurrent: z.boolean().default(false),
  description: z.string().default(''),
  source: z.enum(['manual', 'resume']).default('manual'),
});

export type IWorkExperienceItem = z.infer<typeof workExperienceItemSchema>;

/**
 * Schema for stored resume profiles with focus tags for auto-selection.
 */
export const resumeProfileItemSchema = z.object({
  id: z.string(),
  fileName: z.string().trim().min(1, 'File name is required'),
  uploadedAt: z.number().default(() => Date.now()),
  focusTags: z.array(z.string()).default([]),
  rawText: z.string().default(''),
  extractedSkills: z.array(z.string()).default([]),
  summary: z.string().optional(),
  targetRole: z.string().optional(),
  isDefault: z.boolean().default(false),
});

export type IResumeProfileItem = z.infer<typeof resumeProfileItemSchema>;

/**
 * Strict Zod Schema for Career Brain.
 * Enforces mandatory resumeText (minimum 50 chars), core contact fields,
 * and valid Golden Q&A list to prevent Bedrock AI form filler crashes.
 */
export const careerBrainSchema = z.object({
  /** Full candidate name */
  fullName: z.string().trim().default(''),
  /** Primary contact email address */
  email: z.string().trim().default(''),
  /** Primary contact phone number */
  phoneNumber: z.string().trim().default(''),
  /** Current or target job title */
  currentTitle: z.string().trim().default(''),
  /** Full raw text of the candidate resume */
  resumeText: z.string().default(''),
  /** Freeform narrative describing candidate strengths & work history */
  backgroundNarrative: z.string().default(''),
  /** Core tech stack & skills */
  skills: z.array(z.string()).default([]),
  /** Total years of relevant professional experience */
  yearsOfExperience: z.number().nonnegative().default(0),
  /** Flag indicating whether the candidate has professional work experience */
  hasWorkExperience: z.boolean().default(true),
  /** Structured work experience items */
  workExperience: z.array(workExperienceItemSchema).default([]),
  /** Education details (Degree, College, CGPA) */
  education: z.string().default(''),
  /** College or University attended */
  college: z.string().optional(),
  /** CGPA, GPA, or marks percentage */
  cgpa: z.string().optional(),
  /** Current compensation / CTC */
  currentCTC: z.string().optional(),
  /** Expected compensation / CTC */
  expectedCTC: z.string().optional(),
  /** Current residential city / location */
  currentLocation: z.string().optional(),
  /** Availability / notice period */
  noticePeriod: z.string().optional(),
  /** Work authorization status */
  workAuthorization: z.string().default('Citizen of India / Authorized to work without sponsorship'),
  /** Target salary expectations */
  salaryExpectation: z.string().default(''),
  /** Preferred location or remote preference */
  preferredLocation: z.string().default(''),
  /** Portfolio website URL */
  portfolioUrl: z.string().default(''),
  /** GitHub profile URL */
  githubUrl: z.string().default(''),
  /** LinkedIn profile URL */
  linkedinUrl: z.string().default(''),
  /** Dynamic Golden Q&A answers for screening questions */
  goldenAnswers: z.array(goldenAnswerSchema).default([]),
  /** Saved Q&A key-value pairs for common custom screening questions */
  customAnswers: z.record(z.string(), z.string()).default({}),
  /** Per-skill experience mapping e.g. { "Node.js": 3, "Spring Boot": 0 } */
  skillExperience: z.record(z.string(), z.number()).default({}),
  /** Predefined target job roles for searching */
  predefinedRoles: z.array(z.string()).default([]),
  /** Predefined preferred job locations */
  preferredLocations: z.array(z.string()).default([]),
  /** Target experience levels */
  experienceLevels: z.array(z.string()).default([]),
  /** Target job types */
  jobTypes: z.array(z.string()).default([]),
  /** Name of the active resume on file */
  resumeFileName: z.string().optional(),
  /** Stored candidate resume profiles for smart matching */
  resumes: z.array(resumeProfileItemSchema).default([]),
  /** ID of active / default resume */
  activeResumeId: z.string().optional(),
  /** Skills auto-extracted from resume to display "from resume" indicator */
  autoExtractedSkills: z.array(z.string()).default([]),
  /** Candidate gender identity (Male, Female, Other, Prefer not to say) */
  gender: z.string().default('Male'),
  /** Candidate date of birth (YYYY-MM-DD or DD/MM/YYYY) */
  dateOfBirth: z.string().optional(),
  /** Highest completed education level */
  highestEducation: z.string().default("Bachelor's Degree"),
  /** Willingness to relocate for the job */
  willingToRelocate: z.string().default('Yes'),
  /** Preferred work shift (Day / Flexible, Night Shift, Any) */
  preferredShift: z.string().default('Day / Flexible'),
  /** Valid driver's license possession */
  driverLicense: z.string().default('Yes'),
  /** Military / Protected Veteran status */
  veteranStatus: z.string().default('I am not a protected veteran'),
  /** Disability self-identification status */
  disabilityStatus: z.string().default('No, I do not have a disability'),
  /** Timestamp of last update */
  updatedAt: z.number().default(() => Date.now()),
});

export const GOLDEN_ANSWER_CATEGORIES = [
  'Eligibility / Legal',
  'Location & Relocation',
  'Compensation',
  'Experience & Education',
  'Availability & Shifts',
  'Yes/No Screening',
  'Diversity / Self-Identification',
] as const;

export type GoldenAnswerCategory = (typeof GOLDEN_ANSWER_CATEGORIES)[number];

export type ICareerBrain = z.infer<typeof careerBrainSchema>;

/**
 * Result of checking candidate profile completeness before application start.
 */
export interface ProfileCompletenessResult {
  isValid: boolean;
  missingFields: string[];
}

/**
 * Validates whether the required fields for submitting job applications are present.
 * Required: fullName, email, phoneNumber, yearsOfExperience, workAuthorization, resume (file or text).
 */
export function validateProfileCompleteness(profile?: Partial<ICareerBrain> | null): ProfileCompletenessResult {
  const missingFields: string[] = [];

  if (!profile?.fullName || !profile.fullName.trim()) {
    missingFields.push('Full Name');
  }

  if (!profile?.email || !profile.email.trim()) {
    missingFields.push('Email');
  }

  if (!profile?.phoneNumber || !profile.phoneNumber.trim()) {
    missingFields.push('Phone Number');
  }

  if (
    profile?.yearsOfExperience === undefined ||
    profile.yearsOfExperience === null ||
    isNaN(Number(profile.yearsOfExperience))
  ) {
    missingFields.push('Years of Experience');
  }

  if (!profile?.workAuthorization || !profile.workAuthorization.trim()) {
    missingFields.push('Work Authorization');
  }

  const hasResume = Boolean(
    (profile?.resumeFileName && profile.resumeFileName.trim()) ||
      (profile?.resumeText && profile.resumeText.trim().length >= 20),
  );
  if (!hasResume) {
    missingFields.push('Resume (File or Text)');
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
  };
}

export const DEFAULT_GOLDEN_ANSWERS: IGoldenAnswer[] = [
  // ── 1. Eligibility / Legal (Strict Gatekeepers) ──
  {
    id: 'work_auth',
    question: 'Are you legally authorized to work in India / your resident country?',
    answer: 'Yes',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'visa_sponsorship',
    question: 'Will you now or in the future require visa sponsorship?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'age_requirement',
    question: 'Are you at least 18 years of age or older?',
    answer: 'Yes',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'felony_conviction',
    question: 'Have you ever been convicted of a criminal offense or felony?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'non_compete',
    question: 'Are you bound by any non-compete or restrictive employment agreement?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'security_clearance',
    question: 'Do you currently hold or require an active security clearance?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },

  // ── 2. Location & Relocation ──
  {
    id: 'relocation',
    question: 'Are you open or willing to relocate for this role if required?',
    answer: 'Yes',
    category: 'Location & Relocation',
    isDefault: true,
  },
  {
    id: 'work_mode_preference',
    question: 'What is your preferred work mode / arrangement?',
    answer: 'Remote / Hybrid / On-site',
    category: 'Location & Relocation',
    isDefault: true,
  },
  {
    id: 'commute_onsite',
    question: 'Can you reliably commute to the job location if needed?',
    answer: 'Yes',
    category: 'Location & Relocation',
    isDefault: true,
  },

  // ── 3. Availability & Shifts (Logistics) ──
  {
    id: 'start_immediately',
    question: 'Can you start immediately upon hire?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'preferred_shift',
    question: 'What is your preferred shift timing (Day / Night / Rotational)?',
    answer: 'Day / Flexible',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'shift_flexibility',
    question: 'Are you open to working flexible hours, weekends, or on-call if required?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'timezone_overlap',
    question: 'Can you commit to daily overlap with US / client working hours?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },

  // ── 4. Yes/No Screening & Compliance ──
  {
    id: 'driver_license',
    question: 'Do you possess a valid driver’s license?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'background_check',
    question: 'Are you comfortable with undergoing a standard background verification check?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'drug_test',
    question: 'Are you willing to undergo a drug screening test if required?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'former_employee',
    question: 'Have you previously worked for or been employed by this company?',
    answer: 'No',
    category: 'Yes/No Screening',
    isDefault: true,
  },

  // ── 5. Diversity / Self-Identification ──
  {
    id: 'gender_identity',
    question: 'What is your gender / gender identity?',
    answer: 'Prefer not to say',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
  {
    id: 'veteran_status',
    question: 'What is your military or veteran status?',
    answer: 'I am not a protected veteran',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
  {
    id: 'disability_status',
    question: 'Do you have a physical or mental disability?',
    answer: 'No, I do not have a disability',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
];

export const DEFAULT_CAREER_BRAIN: ICareerBrain = {
  fullName: '',
  email: '',
  phoneNumber: '',
  currentTitle: '',
  resumeText: '',
  backgroundNarrative: '',
  skills: [],
  yearsOfExperience: 0,
  hasWorkExperience: false,
  workExperience: [],
  education: '',
  college: '',
  cgpa: '',
  currentCTC: undefined,
  expectedCTC: '',
  currentLocation: '',
  noticePeriod: 'Immediate',
  workAuthorization: 'Authorized to work without sponsorship',
  salaryExpectation: '',
  preferredLocation: '',
  portfolioUrl: '',
  githubUrl: '',
  linkedinUrl: '',
  goldenAnswers: DEFAULT_GOLDEN_ANSWERS,
  customAnswers: {},
  skillExperience: {},
  predefinedRoles: [],
  preferredLocations: [],
  experienceLevels: [],
  jobTypes: ['Full-time'],
  resumes: [],
  activeResumeId: undefined,
  autoExtractedSkills: [],
  gender: 'Prefer not to say',
  dateOfBirth: '',
  highestEducation: "Bachelor's Degree",
  willingToRelocate: 'Yes',
  preferredShift: 'Day / Flexible',
  driverLicense: 'Yes',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
  updatedAt: Date.now(),
};

// ─── 2. The Safe Storage Wrapper ────────────────────────────────────────────

const storage = createStorage<ICareerBrain>('linkedin_career_brain', DEFAULT_CAREER_BRAIN, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export interface SaveCareerBrainResult {
  success: boolean;
  data?: ICareerBrain;
  error?: string;
  validationErrors?: Record<string, string>;
}

/**
 * Safely validates and saves Career Brain data to chrome.storage.local
 * with try/catch, quota verification, and comprehensive Zod error formatting.
 */
export async function saveCareerBrainData(data: unknown): Promise<SaveCareerBrainResult> {
  try {
    // 1. Strict Zod Validation
    const parseResult = careerBrainSchema.safeParse(data);
    if (!parseResult.success) {
      const validationErrors: Record<string, string> = {};
      const errorMessages: string[] = [];

      for (const issue of parseResult.error.issues) {
        const path = issue.path.join('.');
        validationErrors[path] = issue.message;
        errorMessages.push(`${issue.path.length > 0 ? issue.path.join(' -> ') + ': ' : ''}${issue.message}`);
      }

      return {
        success: false,
        error: errorMessages.join('; '),
        validationErrors,
      };
    }

    // 2. Add timestamp & enforce clean priority sorting + filter social media questions
    const cleanGoldenAnswers = sortGoldenAnswersByPriority(
      (parseResult.data.goldenAnswers || []).filter(ga => !isSocialMediaOrUrlQuestion(ga.question)),
    );

    // Enforce 3 prioritized locations (Priority 1 mirrored to preferredLocation)
    let finalPreferredLocations = (parseResult.data.preferredLocations || [])
      .map(l => (typeof l === 'string' ? l.trim() : ''))
      .filter(Boolean)
      .slice(0, 3);
    let finalPreferredLocation = parseResult.data.preferredLocation?.trim() || '';

    if (finalPreferredLocations.length > 0) {
      finalPreferredLocation = finalPreferredLocations[0];
    } else if (finalPreferredLocation) {
      finalPreferredLocations = [finalPreferredLocation];
    }

    // Enforce auto-seeding of any primary skills into skillExperience with candidate tenure
    const candidateTenure = Math.max(1, Math.min(parseResult.data.yearsOfExperience || 1, 99));
    const mergedSkillExp = { ...(parseResult.data.skillExperience || {}) };
    let hasNewSkillExp = false;
    if (Array.isArray(parseResult.data.skills)) {
      for (const rawS of parseResult.data.skills) {
        const cleanS = cleanSkillKey(rawS);
        if (cleanS && cleanS.length <= 35 && (!mergedSkillExp[cleanS] || mergedSkillExp[cleanS] <= 0)) {
          mergedSkillExp[cleanS] = candidateTenure;
          hasNewSkillExp = true;
        }
      }
    }

    const validatedData: ICareerBrain = {
      ...parseResult.data,
      preferredLocation: finalPreferredLocation,
      preferredLocations: finalPreferredLocations,
      goldenAnswers: cleanGoldenAnswers,
      skillExperience: mergedSkillExp,
      autoExtractedSkills: hasNewSkillExp
        ? Array.from(new Set([...(parseResult.data.autoExtractedSkills || []), ...Object.keys(mergedSkillExp)]))
        : parseResult.data.autoExtractedSkills,
      updatedAt: Date.now(),
    };

    // 3. Write to storage with Quota error protection
    await storage.set(validatedData);

    return {
      success: true,
      data: validatedData,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[CareerBrainStorage] Failed to save Career Brain data:', err);
    return {
      success: false,
      error: `Storage error: ${message}`,
    };
  }
}

/**
 * Strongly-typed getter for Career Brain data from chrome.storage.local
 * with corrupt-state auto recovery and fallback.
 */
export async function getCareerBrainData(): Promise<ICareerBrain> {
  try {
    const raw = await storage.get();
    if (!raw) return DEFAULT_CAREER_BRAIN;

    // Parse with schema to ensure backwards compatibility & repair corrupt fields
    const parseResult = careerBrainSchema.safeParse(raw);
    let data: ICareerBrain;
    if (parseResult.success) {
      data = parseResult.data;
    } else {
      console.warn(
        '[CareerBrainStorage] Stored data had schema discrepancies. Recovering defaults:',
        parseResult.error,
      );
      // Gracefully merge existing valid fields with defaults; missing optional fields default to undefined
      const merged: ICareerBrain = {
        ...DEFAULT_CAREER_BRAIN,
        ...raw,
        college: raw.college !== undefined ? raw.college : undefined,
        cgpa: raw.cgpa !== undefined ? raw.cgpa : undefined,
        currentCTC: raw.currentCTC !== undefined ? raw.currentCTC : undefined,
        expectedCTC: raw.expectedCTC !== undefined ? raw.expectedCTC : undefined,
        currentLocation: raw.currentLocation !== undefined ? raw.currentLocation : undefined,
        noticePeriod:
          raw.noticePeriod !== undefined ? raw.noticePeriod : (DEFAULT_CAREER_BRAIN.noticePeriod ?? 'Immediate'),
        gender: raw.gender !== undefined ? raw.gender : 'Male',
        dateOfBirth: raw.dateOfBirth !== undefined ? raw.dateOfBirth : undefined,
        highestEducation: raw.highestEducation !== undefined ? raw.highestEducation : "Bachelor's Degree",
        willingToRelocate: raw.willingToRelocate !== undefined ? raw.willingToRelocate : 'Yes',
        preferredShift: raw.preferredShift !== undefined ? raw.preferredShift : 'Day / Flexible',
        driverLicense: raw.driverLicense !== undefined ? raw.driverLicense : 'Yes',
        veteranStatus: raw.veteranStatus !== undefined ? raw.veteranStatus : 'I am not a protected veteran',
        disabilityStatus: raw.disabilityStatus !== undefined ? raw.disabilityStatus : 'No, I do not have a disability',
        goldenAnswers:
          Array.isArray(raw.goldenAnswers) && raw.goldenAnswers.length > 0 ? raw.goldenAnswers : DEFAULT_GOLDEN_ANSWERS,
        customAnswers: raw.customAnswers || {},
        skillExperience: raw.skillExperience || {},
        hasWorkExperience: raw.hasWorkExperience !== undefined ? Boolean(raw.hasWorkExperience) : true,
        workExperience: Array.isArray(raw.workExperience) ? raw.workExperience : [],
        resumeText:
          raw.resumeText && raw.resumeText.length >= 20
            ? raw.resumeText
            : raw.resumeFileName
              ? ''
              : DEFAULT_CAREER_BRAIN.resumeText,
      };
      data = merged;
    }

    // Seamless auto-migration: Purge any stale generic work-experience date fields and social media (Facebook, X, etc.) from goldenAnswers
    let purgedStaleGolden = false;
    if (Array.isArray(data.goldenAnswers) && data.goldenAnswers.length > 0) {
      const filtered = data.goldenAnswers.filter(
        ga => !isGenericWorkExperienceDateField(ga.question) && !isSocialMediaOrUrlQuestion(ga.question),
      );
      if (filtered.length !== data.goldenAnswers.length) {
        data.goldenAnswers = filtered;
        purgedStaleGolden = true;
      }
    }

    // Seamless auto-migration: Sanitize and purge fabricated skillExperience (e.g. uniform "5 years" across 20+ skills)
    let sanitizedSkillExp = false;
    if (data.skillExperience && Object.keys(data.skillExperience).length > 0) {
      const cleaned = sanitizeStoredSkillExperience(
        data.skillExperience,
        data.workExperience,
        data.resumeText,
        data.yearsOfExperience,
      );
      if (
        Object.keys(cleaned).length !== Object.keys(data.skillExperience).length ||
        Object.entries(cleaned).some(([k, v]) => data.skillExperience![k] !== v)
      ) {
        data.skillExperience = cleaned;
        sanitizedSkillExp = true;
      }
    }

    // Seamless auto-migration: Clean any stale "or Remote" suffixes from preferredLocation / currentLocation
    let cleanedLocation = false;
    if (data.preferredLocation && /remote|hybrid/i.test(data.preferredLocation)) {
      const cleaned = cleanLocationForCityField(data.preferredLocation);
      if (cleaned && cleaned !== data.preferredLocation) {
        data.preferredLocation = cleaned;
        cleanedLocation = true;
      }
    }
    if (data.currentLocation && /remote|hybrid/i.test(data.currentLocation)) {
      const cleaned = cleanLocationForCityField(data.currentLocation);
      if (cleaned && cleaned !== data.currentLocation) {
        data.currentLocation = cleaned;
        cleanedLocation = true;
      }
    }

    // Ensure up to 3 prioritized preferred locations
    if (!Array.isArray(data.preferredLocations) || data.preferredLocations.length === 0) {
      if (data.preferredLocation) {
        data.preferredLocations = [data.preferredLocation];
      } else {
        data.preferredLocations = [];
      }
    }
    data.preferredLocations = data.preferredLocations
      .map(l => (typeof l === 'string' ? l.trim() : ''))
      .filter(Boolean)
      .slice(0, 3);
    if (data.preferredLocations.length > 0) {
      data.preferredLocation = data.preferredLocations[0];
    }

    // Clean out any social media handles / URLs and narrative-answerable overlapping questions from golden answers
    let cleanedGoldenAnswers = false;
    if (Array.isArray(data.goldenAnswers)) {
      const validAnswers = data.goldenAnswers.filter(
        ga =>
          ga &&
          ga.question &&
          !isSocialMediaOrUrlQuestion(ga.question) &&
          !isNarrativeAnswerableQuestion(ga.question, ga.id),
      );
      if (validAnswers.length !== data.goldenAnswers.length) {
        data.goldenAnswers = validAnswers;
        cleanedGoldenAnswers = true;
      }
    }

    // Seamless auto-migration: Ensure single resume is migrated into multi-resume profile item
    let migratedResumes = false;
    if ((!data.resumes || data.resumes.length === 0) && data.resumeFileName) {
      const defaultId = `res_${Date.now()}`;
      const legacyTags = extractResumeFocusTags(
        data.resumeText || '',
        data.skills || data.autoExtractedSkills || [],
        data.currentTitle,
      );
      data.resumes = [
        {
          id: defaultId,
          fileName: data.resumeFileName,
          uploadedAt: data.updatedAt || Date.now(),
          focusTags: legacyTags,
          rawText: data.resumeText || '',
          extractedSkills: data.autoExtractedSkills || data.skills || [],
          isDefault: true,
          targetRole: data.currentTitle,
        },
      ];
      data.activeResumeId = defaultId;
      migratedResumes = true;
    }

    // Seamless auto-migration: Seed missing primary skills into skillExperience
    let migratedSkillExp = false;
    if (Array.isArray(data.skills) && data.skills.length > 0) {
      const candidateTenure = Math.max(1, Math.min(data.yearsOfExperience || 1, 99));
      const currentExp = { ...(data.skillExperience || {}) };
      for (const rawS of data.skills) {
        const cleanS = cleanSkillKey(rawS);
        if (cleanS && cleanS.length <= 35 && (!currentExp[cleanS] || currentExp[cleanS] <= 0)) {
          currentExp[cleanS] = candidateTenure;
          migratedSkillExp = true;
        }
      }
      if (migratedSkillExp) {
        data.skillExperience = currentExp;
        const autoSet = new Set(data.autoExtractedSkills || []);
        for (const s of Object.keys(currentExp)) {
          autoSet.add(s);
        }
        data.autoExtractedSkills = Array.from(autoSet);
      }
    }

    // Seamless auto-migration: Ensure all default golden answers exist even for existing users
    const existingIds = new Set((data.goldenAnswers || []).map(ga => ga.id));
    const existingQuestions = new Set((data.goldenAnswers || []).map(ga => ga.question.toLowerCase().trim()));
    const missingDefaults = DEFAULT_GOLDEN_ANSWERS.filter(
      d => !existingIds.has(d.id) && !existingQuestions.has(d.question.toLowerCase().trim()),
    );
    if (
      missingDefaults.length > 0 ||
      cleanedGoldenAnswers ||
      purgedStaleGolden ||
      sanitizedSkillExp ||
      migratedSkillExp ||
      cleanedLocation ||
      migratedResumes
    ) {
      if (missingDefaults.length > 0) {
        data.goldenAnswers = [...(data.goldenAnswers || []), ...missingDefaults];
      }
      data.goldenAnswers = sortGoldenAnswersByPriority(data.goldenAnswers);
      storage
        .set(data)
        .catch(err => console.error('[CareerBrainStorage] Failed to save merged defaults/sanitized data:', err));
    } else if (Array.isArray(data.goldenAnswers) && data.goldenAnswers.length > 0) {
      data.goldenAnswers = sortGoldenAnswersByPriority(data.goldenAnswers);
    }

    return data;
  } catch (err) {
    console.error('[CareerBrainStorage] Failed to load Career Brain data. Returning defaults safely:', err);
    return DEFAULT_CAREER_BRAIN;
  }
}

// ─── 3. Compatibility Store Layer ───────────────────────────────────────────

export type CareerBrainStorage = BaseStorage<ICareerBrain> & {
  getCareerBrain: () => Promise<ICareerBrain>;
  updateCareerBrain: (updates: Partial<ICareerBrain>) => Promise<ICareerBrain>;
  setCustomAnswer: (questionKey: string, answer: string) => Promise<void>;
  saveData: (data: unknown) => Promise<SaveCareerBrainResult>;
  saveSkillExperience: (skill: string, years: number) => Promise<void>;
  saveGoldenAnswer: (question: string, answer: string, category?: string) => Promise<void>;
  deleteGoldenAnswer: (id: string) => Promise<void>;
  updateGoldenAnswer: (id: string, newAnswer: string) => Promise<void>;
  saveWorkExperienceItem: (item: Omit<IWorkExperienceItem, 'id'> & { id?: string }) => Promise<void>;
  deleteWorkExperienceItem: (id: string) => Promise<void>;
  setHasWorkExperience: (hasExperience: boolean) => Promise<void>;
  saveResumeProfile: (
    resume: Omit<IResumeProfileItem, 'id' | 'uploadedAt'> & { id?: string; uploadedAt?: number },
  ) => Promise<IResumeProfileItem>;
  deleteResumeProfile: (id: string) => Promise<void>;
  setActiveResumeId: (id: string) => Promise<void>;
};

export const careerBrainStore: CareerBrainStorage = {
  ...storage,

  async getCareerBrain(): Promise<ICareerBrain> {
    return getCareerBrainData();
  },

  async updateCareerBrain(updates: Partial<ICareerBrain>): Promise<ICareerBrain> {
    const current = await this.getCareerBrain();
    const updated = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    const result = await saveCareerBrainData(updated);
    if (result.success && result.data) {
      return result.data;
    }
    await storage.set(updated as ICareerBrain);
    return updated as ICareerBrain;
  },

  async setCustomAnswer(questionKey: string, answer: string): Promise<void> {
    const current = await this.getCareerBrain();
    const customAnswers = { ...current.customAnswers, [questionKey]: answer };
    await this.updateCareerBrain({ customAnswers });
  },

  async saveSkillExperience(skill: string, years: number): Promise<void> {
    const current = await this.getCareerBrain();
    const cleanSkill = skill.trim();
    const cleanYears = Math.max(0, Math.min(99, Math.round(years)));
    const skillExperience = { ...current.skillExperience, [cleanSkill]: cleanYears };
    await this.updateCareerBrain({ skillExperience });
  },

  async saveGoldenAnswer(question: string, answer: string, category?: string): Promise<void> {
    // Never persist ambiguous relative work-experience date fields, social media questions, or narrative questions
    if (
      isGenericWorkExperienceDateField(question) ||
      isSocialMediaOrUrlQuestion(question) ||
      isNarrativeAnswerableQuestion(question)
    ) {
      return;
    }

    const current = await this.getCareerBrain();
    const cleanQ = question.trim();
    const cleanA = answer.trim();
    const existingIndex = current.goldenAnswers.findIndex(
      ga =>
        ga.question.toLowerCase().trim() === cleanQ.toLowerCase() ||
        areQuestionsSemanticallyEquivalent(ga.question, cleanQ).matched,
    );
    let updatedGolden = [...current.goldenAnswers];
    if (existingIndex >= 0) {
      updatedGolden[existingIndex] = {
        ...updatedGolden[existingIndex],
        answer: cleanA,
        category: category || updatedGolden[existingIndex].category,
      };
    } else {
      updatedGolden.push({
        id: `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        question: cleanQ,
        answer: cleanA,
        category: category || 'Screening',
      });
    }
    updatedGolden = sortGoldenAnswersByPriority(updatedGolden);
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async deleteGoldenAnswer(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const updatedGolden = current.goldenAnswers.filter(ga => ga.id !== id);
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async updateGoldenAnswer(id: string, newAnswer: string): Promise<void> {
    const current = await this.getCareerBrain();
    const cleanA = newAnswer.trim();
    const updatedGolden = current.goldenAnswers.map(ga => (ga.id === id ? { ...ga, answer: cleanA } : ga));
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async setHasWorkExperience(hasExperience: boolean): Promise<void> {
    await this.updateCareerBrain({ hasWorkExperience: hasExperience });
  },

  async saveWorkExperienceItem(item: Omit<IWorkExperienceItem, 'id'> & { id?: string }): Promise<void> {
    const current = await this.getCareerBrain();
    const currentList = Array.isArray(current.workExperience) ? [...current.workExperience] : [];
    const itemId = item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullItem: IWorkExperienceItem = {
      id: itemId,
      company: item.company.trim(),
      title: item.title.trim(),
      startMonth: item.startMonth || '',
      startYear: item.startYear || '',
      endMonth: item.isCurrent ? null : item.endMonth || null,
      endYear: item.isCurrent ? null : item.endYear || null,
      isCurrent: Boolean(item.isCurrent),
      description: item.description || '',
      source: item.source || 'manual',
    };

    const existingIndex = currentList.findIndex(e => e.id === itemId);
    if (existingIndex >= 0) {
      currentList[existingIndex] = fullItem;
    } else {
      currentList.push(fullItem);
    }
    await this.updateCareerBrain({ workExperience: currentList, hasWorkExperience: true });
  },

  async deleteWorkExperienceItem(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const currentList = Array.isArray(current.workExperience) ? [...current.workExperience] : [];
    const updatedList = currentList.filter(e => e.id !== id);
    await this.updateCareerBrain({ workExperience: updatedList });
  },

  async saveResumeProfile(
    resume: Omit<IResumeProfileItem, 'id' | 'uploadedAt'> & { id?: string; uploadedAt?: number },
  ): Promise<IResumeProfileItem> {
    const current = await this.getCareerBrain();
    const currentResumes = Array.isArray(current.resumes) ? [...current.resumes] : [];
    const resumeId = resume.id || `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullItem: IResumeProfileItem = {
      id: resumeId,
      fileName: resume.fileName.trim(),
      uploadedAt: resume.uploadedAt || Date.now(),
      focusTags:
        resume.focusTags && resume.focusTags.length > 0
          ? resume.focusTags
          : extractResumeFocusTags(resume.rawText || '', resume.extractedSkills || [], resume.targetRole),
      rawText: resume.rawText || '',
      extractedSkills: resume.extractedSkills || [],
      summary: resume.summary || '',
      targetRole: resume.targetRole || current.currentTitle,
      isDefault: Boolean(resume.isDefault ?? currentResumes.length === 0),
    };

    const existingIdx = currentResumes.findIndex(r => r.id === resumeId);
    if (existingIdx >= 0) {
      currentResumes[existingIdx] = fullItem;
    } else {
      currentResumes.push(fullItem);
    }

    let activeId = current.activeResumeId;
    if (fullItem.isDefault || currentResumes.length === 1 || !activeId) {
      activeId = fullItem.id;
      for (const r of currentResumes) {
        r.isDefault = r.id === fullItem.id;
      }
    }

    await this.updateCareerBrain({
      resumes: currentResumes,
      activeResumeId: activeId,
      resumeFileName: fullItem.fileName,
      resumeText: fullItem.rawText,
      autoExtractedSkills: fullItem.extractedSkills,
    });

    return fullItem;
  },

  async deleteResumeProfile(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const currentResumes = Array.isArray(current.resumes) ? [...current.resumes] : [];
    const updatedResumes = currentResumes.filter(r => r.id !== id);

    let nextActiveId = current.activeResumeId;
    let nextFileName = current.resumeFileName;
    let nextRawText = current.resumeText;
    let nextExtractedSkills = current.autoExtractedSkills;

    if (current.activeResumeId === id) {
      if (updatedResumes.length > 0) {
        const nextDefault = updatedResumes.find(r => r.isDefault) || updatedResumes[0];
        nextDefault.isDefault = true;
        nextActiveId = nextDefault.id;
        nextFileName = nextDefault.fileName;
        nextRawText = nextDefault.rawText;
        nextExtractedSkills = nextDefault.extractedSkills;
      } else {
        nextActiveId = undefined;
        nextFileName = undefined;
        nextRawText = '';
        nextExtractedSkills = [];
      }
    }

    await this.updateCareerBrain({
      resumes: updatedResumes,
      activeResumeId: nextActiveId,
      resumeFileName: nextFileName,
      resumeText: nextRawText,
      autoExtractedSkills: nextExtractedSkills,
    });
  },

  async setActiveResumeId(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const currentResumes = Array.isArray(current.resumes) ? [...current.resumes] : [];
    const target = currentResumes.find(r => r.id === id);
    if (!target) return;

    for (const r of currentResumes) {
      r.isDefault = r.id === id;
    }

    await this.updateCareerBrain({
      resumes: currentResumes,
      activeResumeId: id,
      resumeFileName: target.fileName,
      resumeText: target.rawText,
      autoExtractedSkills: target.extractedSkills,
    });
  },

  async saveData(data: unknown): Promise<SaveCareerBrainResult> {
    return saveCareerBrainData(data);
  },
};

export default careerBrainStore;
