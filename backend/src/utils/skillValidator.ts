/**
 * Skill Validation and Sanitation Utilities (Backend)
 *
 * Prevents LLM parsing artifacts, stopwords, generic buzzwords,
 * and conversational fragments from entering skill lists and skillExperience maps.
 */

export const KNOWN_SHORT_SKILLS = new Set(['c', 'r', 'go', 'c#', 'f#']);

export const SKILL_STOPWORDS = new Set([
  // Short acronyms & stopwords
  'ai',
  'ml',
  'ui',
  'ux',
  'qa',
  'it',
  'db',
  'os',
  'and',
  'the',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'an',
  'as',
  'is',
  'are',
  'was',
  'were',
  'it',
  'this',
  'that',
  'be',
  'all',
  'any',
  'can',
  'had',
  'has',
  'have',
  'not',
  'but',
  'etc',
  'etc.',
  // Generic job / resume vocabulary with no specific tech stack meaning
  'developer',
  'engineer',
  'engineering',
  'development',
  'programming',
  'programmer',
  'software',
  'hardware',
  'tech',
  'technology',
  'technologies',
  'skill',
  'skills',
  'experience',
  'years',
  'year',
  'month',
  'months',
  'project',
  'projects',
  'team',
  'work',
  'working',
  'role',
  'roles',
  'job',
  'jobs',
  'company',
  'client',
  'customer',
  'management',
  'lead',
  'leader',
  'leadership',
  'communication',
  'problem solving',
  'analytical',
  'general',
  'various',
  'other',
  'others',
  'tool',
  'tools',
  'framework',
  'frameworks',
  'methodology',
  'methodologies',
  'code',
  'coding',
  'testing',
  'tester',
  'design',
  'designing',
  'designer',
  'system',
  'systems',
  'application',
  'applications',
  'solution',
  'solutions',
  'architecture',
  'architect',
  'support',
  'maintenance',
  'database',
  'databases',
  'web',
  'frontend',
  'backend',
  'fullstack',
  'full stack',
]);

export function cleanSkillName(skill: string | undefined | null): string {
  if (!skill || typeof skill !== 'string') return '';
  return skill
    .trim()
    .replace(/^[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+|[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+$/g, '')
    .trim();
}

export function isValidSkillName(skill: string | undefined | null): boolean {
  if (!skill || typeof skill !== 'string') return false;

  const cleaned = cleanSkillName(skill);
  if (!cleaned) return false;

  if (cleaned.length > 35) return false;
  if (cleaned.split(/\s+/).length > 4) return false;
  if (!/[a-zA-Z]/.test(cleaned)) return false;
  if (/https?:\/\/|www\.|\.com|\.org|\.net|@/i.test(cleaned)) return false;

  const lower = cleaned.toLowerCase();
  if (SKILL_STOPWORDS.has(lower)) return false;

  if (cleaned.length < 3) {
    return KNOWN_SHORT_SKILLS.has(lower);
  }

  return true;
}

export interface SkillExperienceWorkRole {
  company?: string;
  title?: string;
  startMonth?: string;
  startYear?: string | number;
  endMonth?: string | null;
  endYear?: string | null | number;
  isCurrent?: boolean;
  description?: string;
}

/**
 * Validates, sanity-checks, and caps extracted skillExperience against candidate's
 * verifiable work experience dates and explicit resume statements.
 *
 * Rules:
 * 1. ZERO FABRICATION: Purges uniform hallucinated defaults (e.g. 4+ skills sharing identical values
 *    exceeding verifiable tenure, such as "5 years" across 26 skills for an intern).
 * 2. EXPLICIT DURATION: Honors explicit durations stated in resume text (e.g. "React (3 years)").
 * 3. WORK EXPERIENCE DERIVATION: Derives skill years from dated employment roles that mention the skill.
 * 4. MAXIMUM TENURE CEILING: No skill can exceed the candidate's total verifiable professional tenure
 *    unless explicitly stated in the resume text.
 * 5. OMISSION: If a skill is listed under a general skills section but has NO verifiable tenure in
 *    employment history and no explicit duration statement, it is omitted so the candidate may add it manually.
 */
export function validateAndSanitizeSkillExperience(
  rawSkillExp: Record<string, number> | undefined | null,
  workExp?: SkillExperienceWorkRole[] | null,
  rawText?: string | null,
  overallYoe?: number | string | null,
): Record<string, number> {
  if (!rawSkillExp || typeof rawSkillExp !== 'object') return {};

  const cleanExp: Record<string, number> = {};
  const currentYear = new Date().getFullYear();

  // 1. Calculate maximum possible verifiable professional tenure from workExperience
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

  // Factor in overall stated YOE if available
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

  // 2. Detect uniform default hallucinations (e.g. 4+ skills having the exact same number > maxVerifiableTenure)
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

  // 3. Evaluate each skill
  for (const [skill, claimedYears] of entries) {
    if (!skill || typeof claimedYears !== 'number' || isNaN(claimedYears) || claimedYears <= 0) {
      continue;
    }

    const clean = cleanSkillName(skill);
    if (!isValidSkillName(clean)) continue;

    // Check if the resume text explicitly states duration for this skill (e.g. "React (3 years)")
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicitRegex = new RegExp(
      `(?:\\b${escaped}\\b[^\\n\\r,]{0,35}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?)|(?:(?:for|with)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,35}?\\b${escaped}\\b)`,
      'i',
    );
    const textMatch = rawText ? rawText.match(explicitRegex) : null;

    if (textMatch) {
      const explicitNum = parseFloat(textMatch[1] || textMatch[2]);
      if (!isNaN(explicitNum) && explicitNum > 0) {
        cleanExp[clean] = Math.round(explicitNum);
        continue;
      }
    }

    // If the claimed years was one of the uniform fabricated values, reject it unless verified by work history
    const isFabricatedValue = suspectedFabricatedValues.has(claimedYears);

    // Check if this skill appears in any verifiable workExperience role
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

    if (skillRoleTenure !== null) {
      // Skill was used in dated employment. Cap at verifiable tenure and role duration.
      if (maxVerifiableTenure === 0) {
        // Intern or fresher with < 1 year in current year; omit so user can manually set
        continue;
      }
      const verifiedYears = Math.min(claimedYears, Math.max(1, skillRoleTenure), Math.max(1, maxVerifiableTenure));
      cleanExp[clean] = verifiedYears;
    } else {
      // Skill was NOT in dated employment and has no explicit text duration.
      // If claimed years is a fabricated value, or exceeds maxVerifiableTenure, omit it.
      if (isFabricatedValue || claimedYears > maxVerifiableTenure) {
        continue;
      }
      // If candidate has overall experience and this wasn't flagged as fabricated
      if (maxVerifiableTenure > 0 && claimedYears <= maxVerifiableTenure) {
        cleanExp[clean] = claimedYears;
      }
    }
  }

  return cleanExp;
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
