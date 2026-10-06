import type { IResumeProfileItem } from './careerBrain';

// ─── 1. Technical Taxonomy & Domain Dictionaries ────────────────────────────

export const DOMAIN_TAG_MAP: Record<string, string[]> = {
  frontend: [
    'frontend',
    'front-end',
    'react',
    'reactjs',
    'vue',
    'angular',
    'svelte',
    'next.js',
    'nextjs',
    'html',
    'css',
    'tailwind',
    'ui/ux',
    'web developer',
    'client-side',
    'redux',
  ],
  backend: [
    'backend',
    'back-end',
    'node',
    'nodejs',
    'express',
    'nestjs',
    'django',
    'fastapi',
    'flask',
    'spring boot',
    'java',
    'golang',
    'go',
    'microservices',
    'rest api',
    'graphql',
    'server-side',
    'sql',
    'postgres',
    'mongodb',
  ],
  fullstack: ['fullstack', 'full stack', 'full-stack', 'mern', 'mean', 'pern'],
  mobile: ['mobile', 'react native', 'flutter', 'android', 'ios', 'swift', 'kotlin'],
  devops: [
    'devops',
    'docker',
    'kubernetes',
    'k8s',
    'ci/cd',
    'terraform',
    'aws',
    'gcp',
    'azure',
    'cloud',
    'jenkins',
    'ansible',
    'helm',
  ],
  'ml-ai': [
    'machine learning',
    'deep learning',
    'ml',
    'ai',
    'artificial intelligence',
    'nlp',
    'llm',
    'computer vision',
    'pytorch',
    'tensorflow',
    'langchain',
    'hugging face',
    'openai',
    'bedrock',
  ],
  'data-engineering': [
    'data engineering',
    'data engineer',
    'spark',
    'hadoop',
    'kafka',
    'airflow',
    'etl',
    'sql',
    'bigquery',
    'snowflake',
    'databricks',
  ],
  'qa-testing': [
    'qa',
    'testing',
    'automation testing',
    'test automation',
    'selenium',
    'cypress',
    'playwright',
    'jest',
    'vitest',
    'unit testing',
  ],
  security: ['cybersecurity', 'infosec', 'penetration testing', 'soc', 'appsec', 'cryptography', 'owasp'],
};

export const CORE_TECH_TAGS = [
  'react',
  'nextjs',
  'vue',
  'angular',
  'typescript',
  'javascript',
  'html',
  'css',
  'tailwind',
  'node',
  'express',
  'nestjs',
  'python',
  'django',
  'fastapi',
  'flask',
  'java',
  'spring',
  'c++',
  'c#',
  '.net',
  'golang',
  'rust',
  'php',
  'ruby',
  'rails',
  'sql',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'elasticsearch',
  'dynamodb',
  'aws',
  'gcp',
  'azure',
  'docker',
  'kubernetes',
  'terraform',
  'linux',
  'git',
  'graphql',
  'rest',
  'kafka',
  'spark',
  'pytorch',
  'tensorflow',
  'langchain',
];

// Helper to sanitize tokens
function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]/g, '')
    .trim();
}

function normalizeFrameworkNames(text: string): string {
  return text
    .replace(/next\.js/gi, 'nextjs')
    .replace(/react\.js/gi, 'react')
    .replace(/node\.js/gi, 'node')
    .replace(/vue\.js/gi, 'vue');
}

/**
 * Extracts 3 to 8 high-level focus tags from a resume's text, skills, and target role.
 * Includes broad domains (e.g. 'frontend', 'backend', 'fullstack') and primary tech stacks.
 */
export function extractResumeFocusTags(
  rawResumeText: string = '',
  skills: string[] = [],
  targetRole: string = '',
): string[] {
  const combined = normalizeFrameworkNames(`${targetRole} ${skills.join(' ')} ${rawResumeText}`.toLowerCase());
  const tags = new Set<string>();

  // 1. Check domain categories
  for (const [domain, keywords] of Object.entries(DOMAIN_TAG_MAP)) {
    let matchCount = 0;
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regex.test(combined)) {
        matchCount++;
      }
    }
    // If multiple keywords or explicit domain term matched, add domain tag
    if (matchCount >= 2 || new RegExp(`\\b${domain}\\b`, 'i').test(combined)) {
      tags.add(domain);
    }
  }

  // 2. Check core technology tags
  for (const tech of CORE_TECH_TAGS) {
    const regex = new RegExp(`\\b${tech.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (regex.test(combined)) {
      tags.add(tech);
    }
  }

  // 3. Include top skills that are valid slugs
  for (const s of skills) {
    const norm = normalizeToken(s);
    if (norm.length >= 3 && norm.length <= 20) {
      tags.add(norm);
    }
  }

  // Rank and limit to top 8 tags
  const result = Array.from(tags).slice(0, 8);
  return result.length > 0 ? result : ['software-engineer'];
}

/**
 * Extracts job requirement tags from job title and description.
 */
export function extractJobFocusTags(jobTitle: string = '', jobDescription: string = ''): string[] {
  const titleLower = normalizeFrameworkNames(jobTitle.toLowerCase());
  const descLower = normalizeFrameworkNames(jobDescription.toLowerCase());
  const combined = `${titleLower} ${descLower}`;
  const tags = new Set<string>();

  // Title tags are high-confidence
  for (const [domain, keywords] of Object.entries(DOMAIN_TAG_MAP)) {
    for (const kw of keywords) {
      const regex = new RegExp(`\\b${kw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regex.test(titleLower)) {
        tags.add(domain);
        break;
      }
    }
  }

  // Core technologies in title
  for (const tech of CORE_TECH_TAGS) {
    const regex = new RegExp(`\\b${tech.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (regex.test(titleLower)) {
      tags.add(tech);
    }
  }

  // Core technologies in description
  for (const tech of CORE_TECH_TAGS) {
    const regex = new RegExp(`\\b${tech.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (regex.test(descLower)) {
      tags.add(tech);
    }
  }

  return Array.from(tags);
}

/**
 * Computes a match score (0 - 100) between a stored resume and a job's requirements.
 */
export function scoreResumeForJob(
  resume: IResumeProfileItem,
  jobTitle: string,
  jobDescription: string = '',
): { score: number; matchedTags: string[] } {
  if (!resume) return { score: 0, matchedTags: [] };

  const jobTags = extractJobFocusTags(jobTitle, jobDescription);
  const titleLower = jobTitle.toLowerCase();
  const fileNameLower = (resume.fileName || '').toLowerCase();
  const targetRoleLower = (resume.targetRole || '').toLowerCase();
  const resumeTags = Array.isArray(resume.focusTags) ? resume.focusTags : [];

  const matched = new Set<string>();

  // 1. Tag overlap matching
  for (const rTag of resumeTags) {
    const norm = rTag.toLowerCase();
    // Direct match with job tags
    if (jobTags.includes(norm)) {
      matched.add(rTag);
    } else if (titleLower.includes(norm)) {
      matched.add(rTag);
    } else if (jobDescription.toLowerCase().includes(norm)) {
      matched.add(rTag);
    }
  }

  let score = 0;

  // Base score from tag overlap
  if (jobTags.length > 0) {
    const overlapRatio = matched.size / Math.max(jobTags.length, 1);
    score += Math.min(60, Math.round(overlapRatio * 60));
  } else if (matched.size > 0) {
    score += Math.min(50, matched.size * 15);
  }

  // Bonus for Title matches (e.g. resume explicitly mentions job title or target role)
  if (targetRoleLower && titleLower) {
    const roleWords = targetRoleLower.split(/\s+/).filter(w => w.length > 2);
    const hasRoleOverlap = roleWords.some(w => titleLower.includes(w));
    if (hasRoleOverlap) score += 20;
  }

  // Bonus for File Name keywords matching job title (e.g. "React_Frontend_Resume.pdf" for "React Developer")
  for (const tag of matched) {
    if (fileNameLower.includes(tag.toLowerCase())) {
      score += 10;
      break;
    }
  }

  // Bonus for active skills matching
  if (resume.extractedSkills && resume.extractedSkills.length > 0) {
    let skillMatches = 0;
    for (const sk of resume.extractedSkills) {
      if (titleLower.includes(sk.toLowerCase())) {
        skillMatches++;
      }
    }
    score += Math.min(15, skillMatches * 5);
  }

  // If resume is marked default, grant a tiny tie-breaker
  if (resume.isDefault) {
    score += 1;
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    matchedTags: Array.from(matched),
  };
}

export interface BestMatchResult {
  bestResume: IResumeProfileItem | null;
  score: number;
  matchedTags: string[];
  allScores: Array<{
    resumeId: string;
    fileName: string;
    score: number;
    matchedTags: string[];
  }>;
}

/**
 * Evaluates all candidate resumes against target job title and description,
 * selecting the highest-scoring resume profile.
 */
export function selectBestMatchingResume(
  resumes: IResumeProfileItem[] = [],
  jobTitle: string = '',
  jobDescription: string = '',
): BestMatchResult {
  if (!resumes || resumes.length === 0) {
    return {
      bestResume: null,
      score: 0,
      matchedTags: [],
      allScores: [],
    };
  }

  if (resumes.length === 1) {
    const single = resumes[0];
    const { score, matchedTags } = scoreResumeForJob(single, jobTitle, jobDescription);
    return {
      bestResume: single,
      score,
      matchedTags,
      allScores: [{ resumeId: single.id, fileName: single.fileName, score, matchedTags }],
    };
  }

  const scoredList = resumes.map(r => {
    const evaluation = scoreResumeForJob(r, jobTitle, jobDescription);
    return {
      resume: r,
      resumeId: r.id,
      fileName: r.fileName,
      score: evaluation.score,
      matchedTags: evaluation.matchedTags,
    };
  });

  // Sort descending by score; if tied, default resume comes first
  scoredList.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.resume.isDefault && !a.resume.isDefault) return 1;
    if (a.resume.isDefault && !b.resume.isDefault) return -1;
    return 0;
  });

  const winner = scoredList[0];

  return {
    bestResume: winner.resume,
    score: winner.score,
    matchedTags: winner.matchedTags,
    allScores: scoredList.map(s => ({
      resumeId: s.resumeId,
      fileName: s.fileName,
      score: s.score,
      matchedTags: s.matchedTags,
    })),
  };
}
