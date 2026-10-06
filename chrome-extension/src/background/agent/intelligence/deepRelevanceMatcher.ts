// chrome-extension/src/background/agent/intelligence/deepRelevanceMatcher.ts
import type { ICareerBrain } from '@extension/storage';

export interface IDeepRelevanceResult {
  isMatch: boolean;
  score: number; // 0 to 100
  matchedSkills: string[];
  missingSkills: string[];
  recommendation: 'apply' | 'caution' | 'skip';
  reason: string;
}

export interface IBlacklistCheckResult {
  blacklisted: boolean;
  reason?: string;
  matchedKeyword?: string;
  matchedCompany?: string;
}

/**
 * Checks whether a job listing matches user negative keywords or blacklisted companies.
 * Executes at 0 LLM cost using word-boundary regex checks.
 */
export function checkBlacklistAndNegativeKeywords(
  jobTitle: string,
  company: string,
  descriptionSnippet: string | undefined,
  negativeKeywords: string[] = [],
  blacklistedCompanies: string[] = [],
  targetRole?: string,
): IBlacklistCheckResult {
  const lowerTitle = (jobTitle || '').toLowerCase();
  const lowerCompany = (company || '').toLowerCase().trim();
  const lowerDesc = (descriptionSnippet || '').toLowerCase();
  const lowerTargetRole = (targetRole || '').toLowerCase().trim();

  // 1. Company Blacklist Check (Exact or partial match)
  if (lowerCompany && blacklistedCompanies.length > 0) {
    for (const bCompany of blacklistedCompanies) {
      const cleanBComp = bCompany.toLowerCase().trim();
      if (!cleanBComp) continue;
      if (lowerCompany === cleanBComp || lowerCompany.includes(cleanBComp)) {
        return {
          blacklisted: true,
          reason: `Company "${company}" is blacklisted`,
          matchedCompany: bCompany,
        };
      }
    }
  }

  // 2. Negative Keywords Check (in Job Title first with high priority, then in description snippet)
  if (negativeKeywords.length > 0) {
    for (const kw of negativeKeywords) {
      const cleanKw = kw.toLowerCase().trim();
      if (!cleanKw) continue;

      // Smart override: If the user's target role or search query explicitly includes this keyword
      // (e.g. user is looking for "Next.js Developer Intern" and keyword is "intern" or "internship"),
      // DO NOT filter it out!
      if (lowerTargetRole && (lowerTargetRole.includes(cleanKw) || cleanKw.includes(lowerTargetRole))) {
        continue;
      }
      if (
        (lowerTargetRole.includes('intern') ||
          lowerTargetRole.includes('trainee') ||
          lowerTargetRole.includes('fresher')) &&
        (cleanKw === 'intern' || cleanKw === 'internship' || cleanKw === 'trainee')
      ) {
        continue;
      }

      const escaped = cleanKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|[^a-zA-Z0-9#+])${escaped}(?:$|[^a-zA-Z0-9#+])`, 'i');

      if (regex.test(lowerTitle)) {
        return {
          blacklisted: true,
          reason: `Job title contains blacklisted keyword "${kw}"`,
          matchedKeyword: kw,
        };
      }

      // Check first 800 characters of description snippet if present
      if (lowerDesc && regex.test(lowerDesc.slice(0, 800))) {
        return {
          blacklisted: true,
          reason: `Job posting contains blacklisted keyword "${kw}"`,
          matchedKeyword: kw,
        };
      }
    }
  }

  return { blacklisted: false };
}

/**
 * Detects minimum years of experience required from Job Title and Description.
 * E.g., "10+ years", "8-10 years", "minimum 5 years of experience", "5+ yrs".
 */
export function extractRequiredExperienceYears(title: string, description?: string): number | null {
  const combined = `${title} ${description || ''}`.toLowerCase();

  // Pattern 1: e.g. "10+ years", "8+ yrs", "12+ years of experience"
  const plusMatch = combined.match(/\b(\d{1,2})\s*\+\s*(?:years?|yrs?)(?:\s*of\s*experience)?\b/i);
  if (plusMatch && plusMatch[1]) {
    const yrs = parseInt(plusMatch[1], 10);
    if (!isNaN(yrs) && yrs > 0 && yrs <= 25) return yrs;
  }

  // Pattern 2: e.g. "minimum 7 years", "min 5 years", "at least 6 years"
  const minMatch = combined.match(/\b(?:minimum|min|at least)\s*(?:of\s*)?(\d{1,2})\s*(?:years?|yrs?)\b/i);
  if (minMatch && minMatch[1]) {
    const yrs = parseInt(minMatch[1], 10);
    if (!isNaN(yrs) && yrs > 0 && yrs <= 25) return yrs;
  }

  // Pattern 3: e.g. "5 to 8 years", "5-8 years of experience"
  const rangeMatch = combined.match(/\b(\d{1,2})\s*(?:to|-)\s*(\d{1,2})\s*(?:years?|yrs?)(?:\s*of\s*experience)?\b/i);
  if (rangeMatch && rangeMatch[1]) {
    const yrs = parseInt(rangeMatch[1], 10);
    if (!isNaN(yrs) && yrs > 0 && yrs <= 25) return yrs;
  }

  // Pattern 4: Title seniority heuristics (e.g. Principal / Director / VP implies 8+ years)
  const lowerTitle = title.toLowerCase();
  if (/\b(?:principal|staff architect|director of|vp of|head of engineering)\b/i.test(lowerTitle)) {
    return 8;
  }

  return null;
}

const COMMON_TECH_TAXONOMY: string[] = [
  'react',
  'next.js',
  'nextjs',
  'vue',
  'angular',
  'node.js',
  'nodejs',
  'express',
  'nest.js',
  'typescript',
  'javascript',
  'python',
  'django',
  'flask',
  'fastapi',
  'java',
  'spring',
  'springboot',
  'golang',
  'go',
  'rust',
  'c++',
  'c#',
  '.net',
  'php',
  'laravel',
  'sql',
  'postgresql',
  'mysql',
  'mongodb',
  'redis',
  'graphql',
  'rest api',
  'docker',
  'kubernetes',
  'aws',
  'azure',
  'gcp',
  'tailwind',
  'html',
  'css',
  'git',
];

/**
 * Tier-2 Deep Job Description Relevance Matcher
 * Analyzes full JD text against candidate profile to guarantee high interview probability.
 * Checks experience gap tolerance and user-defined minimum match score threshold.
 */
export function evaluateDeepRelevance(
  jobDescriptionText: string,
  candidateBrain: ICareerBrain,
  targetRole?: string,
  minScoreThreshold = 70,
  maxExperienceGap = 3,
  jobTitle = '',
): IDeepRelevanceResult {
  // 1. Experience Gap Check
  const requiredYears = extractRequiredExperienceYears(jobTitle, jobDescriptionText);
  const candidateYears =
    candidateBrain.yearsOfExperience !== undefined && candidateBrain.yearsOfExperience !== null
      ? Number(candidateBrain.yearsOfExperience) || 0
      : 0;

  if (requiredYears !== null && requiredYears > candidateYears + maxExperienceGap) {
    return {
      isMatch: false,
      score: Math.max(10, Math.min(60, Math.round((candidateYears / requiredYears) * 60))),
      matchedSkills: [],
      missingSkills: [`Experience gap: requires ${requiredYears}+ yrs`],
      recommendation: 'skip',
      reason: `Experience mismatch: Role requires ${requiredYears}+ years, but candidate has ${candidateYears} years (tolerance: +${maxExperienceGap} yrs).`,
    };
  }

  if (!jobDescriptionText || jobDescriptionText.length < 50) {
    // If JD is short or missing, give benefit of doubt if title aligns
    return {
      isMatch: true,
      score: 75,
      matchedSkills: [],
      missingSkills: [],
      recommendation: 'apply',
      reason: 'Job description text was minimal; proceeding with application based on title match.',
    };
  }

  const jdLower = jobDescriptionText.toLowerCase();

  // 2. Identify all technologies mentioned in JD
  const jdSkills = new Set<string>();
  for (const tech of COMMON_TECH_TAXONOMY) {
    const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9#+])${escaped}(?:$|[^a-zA-Z0-9#+])`, 'i');
    if (regex.test(jdLower)) {
      jdSkills.add(tech);
    }
  }

  // 3. Identify candidate skills
  const candidateSkills = new Set(
    [...(candidateBrain.skills || []), ...Object.keys(candidateBrain.skillExperience || {}), targetRole || '']
      .map(s => s.toLowerCase().trim())
      .filter(s => s.length > 1),
  );

  // 4. Calculate overlap
  const matched: string[] = [];
  const missing: string[] = [];

  for (const tech of jdSkills) {
    let candidateHas = false;
    for (const cSkill of candidateSkills) {
      if (
        cSkill === tech ||
        cSkill.includes(tech) ||
        tech.includes(cSkill) ||
        (tech.startsWith('next') && cSkill.startsWith('next')) ||
        (tech.startsWith('react') && cSkill.startsWith('react')) ||
        (tech.startsWith('node') && cSkill.startsWith('node'))
      ) {
        candidateHas = true;
        break;
      }
    }

    if (candidateHas) {
      matched.push(tech);
    } else {
      missing.push(tech);
    }
  }

  // If JD has no detectable standard tech stack, default to pass
  if (jdSkills.size === 0) {
    return {
      isMatch: true,
      score: 75,
      matchedSkills: [],
      missingSkills: [],
      recommendation: 'apply',
      reason: 'No conflicting tech stack detected in posting.',
    };
  }

  // Base score from skill overlap percentage
  let score = Math.round((matched.length / jdSkills.size) * 100);

  // If candidate matched 2+ core technologies, give a relevance boost
  if (matched.length >= 2) {
    score = Math.max(score, Math.min(95, 50 + matched.length * 12));
  }

  // Enforce user-configured threshold
  const isMatch = score >= minScoreThreshold;

  let recommendation: 'apply' | 'caution' | 'skip' = 'apply';
  if (!isMatch && (missing.length > matched.length * 2 || score < minScoreThreshold)) {
    recommendation = 'skip';
  } else if (!isMatch) {
    recommendation = 'caution';
  }

  return {
    isMatch,
    score,
    matchedSkills: matched,
    missingSkills: missing,
    recommendation,
    reason: isMatch
      ? `Strong alignment: ${matched.length} core technologies match candidate profile (${matched.slice(0, 4).join(', ')}) with ${score}% match score.`
      : `Relevance score ${score}% is below threshold (${minScoreThreshold}%). Missing required stack: [${missing.slice(0, 4).join(', ')}].`,
  };
}
