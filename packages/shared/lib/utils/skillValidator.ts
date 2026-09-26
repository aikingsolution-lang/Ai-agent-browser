/**
 * Skill Validation and Sanitation Utilities
 *
 * Prevents LLM parsing artifacts, stopwords, generic buzzwords,
 * and conversational fragments from entering skill lists and skillExperience maps.
 */

/**
 * Legitimate technical skills that are shorter than 3 characters.
 * All other < 3 character strings (like "ai", "ui", "ml", "db", "qa", "it") are rejected.
 */
export const KNOWN_SHORT_SKILLS = new Set(['c', 'r', 'go', 'c#', 'f#']);

/**
 * Generic English stopwords, filler words, and non-technical resume buzzwords.
 */
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

/**
 * Cleans leading/trailing punctuation and extra whitespace from skill names.
 */
export function cleanSkillName(skill: string | undefined | null): string {
  if (!skill || typeof skill !== 'string') return '';
  return skill
    .trim()
    .replace(/^[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+|[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+$/g, '')
    .trim();
}

/**
 * Validates whether an extracted string represents a legitimate technical skill.
 *
 * Rules:
 * 1. String must not be empty or purely punctuation/numbers.
 * 2. If length < 3: reject UNLESS in KNOWN_SHORT_SKILLS allowlist (e.g. Go, R, C#, C).
 * 3. Reject generic words/stopwords ("ai", "and", "the", "developer", etc.).
 * 4. Reject long sentences / phrases (>35 characters or >4 words).
 * 5. Reject entries containing obvious non-skill markers (e.g. bullet points, URLs).
 */
export function isValidSkillName(skill: string | undefined | null): boolean {
  if (!skill || typeof skill !== 'string') return false;

  const cleaned = cleanSkillName(skill);
  if (!cleaned) return false;

  // Length check: max 35 chars, max 4 words
  if (cleaned.length > 35) return false;
  if (cleaned.split(/\s+/).length > 4) return false;

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(cleaned)) return false;

  // Reject URLs or emails
  if (/https?:\/\/|www\.|\.com|\.org|\.net|@/i.test(cleaned)) return false;

  const lower = cleaned.toLowerCase();

  // Stopword & generic non-skill term check
  if (SKILL_STOPWORDS.has(lower)) return false;

  // Reject short skills (<3 chars) not in the explicit allowlist
  if (cleaned.length < 3) {
    return KNOWN_SHORT_SKILLS.has(lower);
  }

  return true;
}
