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
