// chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts
import { createLogger } from '@src/background/log';
import type BrowserContext from '@src/background/browser/context';
import type { Executor } from '@src/background/agent/executor';
import { backendApiClient, BACKEND_LLM_URL } from '@extension/shared';
import {
  careerBrainStore,
  validateProfileCompleteness,
  queueSafetyStore,
  processedJobsStore,
  runnerStateStore,
  authStorage,
  llmProviderStore,
  agentModelStore,
  AgentNameEnum,
  linkedInConfigStore,
  type ProcessedJobRecord,
  type ICareerBrain,
  type ILinkedInAutomationConfig,
  type IResumeProfileItem,
  selectBestMatchingResume,
  isCandidateNameOrInvalidTitle,
  sanitizeRoleSearchQuery,
} from '@extension/storage';
import { DailyQuotaManager } from './rateLimiter';
import { normalizeLinkedInJobUrl } from './urlUtils';
import { dedicatedWindowManager, type RunnerMode } from './dedicatedWindow';
import { buildLinkedInApplyTaskDetails } from './taskBuilder';
import { linkedinAdapter } from '../platforms/linkedin/linkedinAdapter';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';
import { indeedAdapter } from '../platforms/indeed/indeedAdapter';
import type { SupportedPlatform, IJobQueueItem } from '../platforms/types';
import { Actors, ExecutionState } from '../event/types';
import { createChatModel } from '../helper';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { userQuestionManager, type BatchQuestionItem } from './userQuestionManager';
import {
  resolveModalFieldWithAudit,
  cleanLinkedInJobTitle,
  adaptAnswerToFieldFormat,
  solveQuestionAutonomousWithLLM,
  matchRuleBased,
} from './formQuestionResolver';
import {
  evaluateDeepRelevance,
  inspectAndHealFormErrors,
  checkBlacklistAndNegativeKeywords,
  extractRequiredExperienceYears,
} from '../intelligence';
import type { FormFieldDescriptor } from '../../browser/page';

const logger = createLogger('DedicatedJobRunner');

const SKILL_ALIASES: Record<string, string[]> = {
  react: ['react', 'reactjs', 'react.js'],
  'react.js': ['react', 'reactjs', 'react.js'],
  reactjs: ['react', 'reactjs', 'react.js'],
  node: ['node', 'nodejs', 'node.js'],
  'node.js': ['node', 'nodejs', 'node.js'],
  nodejs: ['node', 'nodejs', 'node.js'],
  vue: ['vue', 'vuejs', 'vue.js'],
  'vue.js': ['vue', 'vuejs', 'vue.js'],
  next: ['next', 'nextjs', 'next.js'],
  'next.js': ['next', 'nextjs', 'next.js'],
  nest: ['nest', 'nestjs', 'nest.js'],
  'nest.js': ['nest', 'nestjs', 'nest.js'],
  express: ['express', 'expressjs', 'express.js'],
  'express.js': ['express', 'expressjs', 'express.js'],
  postgres: ['postgres', 'postgresql'],
  postgresql: ['postgres', 'postgresql'],
  mongo: ['mongo', 'mongodb'],
  mongodb: ['mongo', 'mongodb'],
  typescript: ['typescript', 'ts'],
  ts: ['typescript', 'ts'],
  javascript: ['javascript', 'js'],
  js: ['javascript', 'js'],
  golang: ['golang', 'go'],
  go: ['golang', 'go'],
  aws: ['aws', 'amazon web services'],
  gcp: ['gcp', 'google cloud'],
  k8s: ['k8s', 'kubernetes'],
  kubernetes: ['k8s', 'kubernetes'],
  docker: ['docker', 'containerization'],
  'full stack': ['full stack', 'fullstack', 'full-stack', 'frontend', 'backend', 'web developer', 'software engineer'],
  fullstack: ['full stack', 'fullstack', 'full-stack', 'frontend', 'backend', 'web developer', 'software engineer'],
  frontend: ['frontend', 'front end', 'front-end', 'ui developer', 'web developer'],
  backend: ['backend', 'back end', 'back-end', 'server-side'],
};

const SOFTWARE_DOMAIN_KEYWORDS = [
  'software',
  'developer',
  'development',
  'engineer',
  'engineering',
  'programmer',
  'programming',
  'full stack',
  'fullstack',
  'full-stack',
  'frontend',
  'front-end',
  'front end',
  'backend',
  'back-end',
  'back end',
  'web developer',
  'web development',
  'application developer',
  'app developer',
  'sde',
  'swe',
  'mern',
  'mean',
  'react',
  'node',
  'javascript',
  'typescript',
  'python',
  'java',
  'golang',
  'devops',
  'cloud',
  'platform engineer',
  'systems engineer',
  'solution architect',
  'solutions architect',
  'data engineer',
  'ai engineer',
  'machine learning',
  'ml engineer',
  'qa engineer',
  'test engineer',
  'automation engineer',
  'coder',
  'coding',
];

const UNRELATED_DOMAINS = [
  'nurse',
  'nursing',
  'doctor',
  'driver',
  'real estate',
  'sales executive',
  'sales representative',
  'telecaller',
  'bpo',
  'call center',
  'customer support',
  'customer care',
  'accountant',
  'accounts executive',
  'cashier',
  'receptionist',
  'store manager',
  'delivery boy',
  'delivery executive',
  'chef',
  'cook',
  'waiter',
  'security guard',
  'civil engineer',
  'mechanical engineer',
  'electrical engineer',
  'construction',
];

function stemWord(w: string): string {
  return w.toLowerCase().replace(/(?:ing|ment|er|ers|ed|tion|tions|s)$/, '');
}

/**
 * Evaluates job relevance against candidate's profile skills and target roles at 0 LLM cost.
 * Scans job title and split-pane description snippet using DOM/regex token matching.
 * Accounts for skill variants (React <-> React.js, Node <-> Node.js), software engineering
 * cluster overlap, word stemming (developer <-> development), and unrelated domain protection.
 */
export interface ISkillRelevanceResult {
  relevant: boolean;
  score: number; // 0 to 100
  threshold: number; // e.g. 25
  matchedSkills: string[];
  totalCandidateSkills: number;
  reason?: string;
  scoringBreakdown: {
    skillMatchCount: number;
    softwareClusterMatch: boolean;
    stemMatch: boolean;
    queryMatch: boolean;
    unrelatedDomainPenalty: boolean;
  };
}

/**
 * Evaluates job relevance against candidate's profile skills and target roles at 0 LLM cost.
 * Scans job title and split-pane description snippet using DOM/regex token matching.
 * Accounts for skill variants (React <-> React.js, Node <-> Node.js), software engineering
 * cluster overlap, word stemming (developer <-> development), and unrelated domain protection.
 * Returns an explicit computed score (0-100%) and comparison threshold for transparent auditing.
 */
export function checkJobSkillRelevance(
  jobTitle: string,
  descriptionSnippet: string | undefined,
  careerBrain: ICareerBrain,
  targetRole?: string,
): ISkillRelevanceResult {
  const threshold = 25;
  const rawSkills = Array.from(
    new Set([...(careerBrain.skills || []), ...Object.keys(careerBrain.skillExperience || {})]),
  )
    .map(s => s.trim())
    .filter(s => s.length > 1);

  // If candidate has no skills configured, fallback to open matching
  if (rawSkills.length === 0) {
    return {
      relevant: true,
      score: 100,
      threshold,
      matchedSkills: [],
      totalCandidateSkills: 0,
      scoringBreakdown: {
        skillMatchCount: 0,
        softwareClusterMatch: true,
        stemMatch: false,
        queryMatch: true,
        unrelatedDomainPenalty: false,
      },
    };
  }

  const combinedText = `${jobTitle} ${descriptionSnippet || ''}`.toLowerCase();
  const lowerTitle = jobTitle.toLowerCase();

  // 1. Build expanded search variants (e.g. "React.js" -> ["react.js", "react", "reactjs"])
  const searchVariants = new Map<string, string>(); // variant -> originalSkillName
  for (const skill of rawSkills) {
    const sLower = skill.toLowerCase();
    searchVariants.set(sLower, skill);

    // Strip .js / js suffix
    if (sLower.endsWith('.js')) {
      const base = sLower.replace(/\.js$/, '');
      if (base.length > 1) {
        searchVariants.set(base, skill);
        searchVariants.set(`${base}js`, skill);
      }
    } else if (sLower.endsWith('js') && sLower.length > 3) {
      const base = sLower.replace(/js$/, '');
      if (base.length > 1) {
        searchVariants.set(base, skill);
        searchVariants.set(`${base}.js`, skill);
      }
    }

    // Check alias table
    if (SKILL_ALIASES[sLower]) {
      for (const alias of SKILL_ALIASES[sLower]) {
        searchVariants.set(alias.toLowerCase(), skill);
      }
    }
  }

  // 2. Find all matched skills using word-boundary matching
  const matchedSkillsSet = new Set<string>();
  for (const [variant, originalSkill] of searchVariants.entries()) {
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // For very short 2-letter tokens like "go", "ts", "js", enforce strict boundary
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9#+])${escaped}(?:$|[^a-zA-Z0-9#+])`, 'i');
    if (regex.test(combinedText)) {
      matchedSkillsSet.add(originalSkill);
    }
  }

  const matchedSkills = Array.from(matchedSkillsSet);
  if (matchedSkills.length > 0) {
    const score = Math.min(100, Math.max(50, Math.round((matchedSkills.length / Math.min(3, rawSkills.length)) * 100)));
    return {
      relevant: score >= threshold,
      score,
      threshold,
      matchedSkills,
      totalCandidateSkills: rawSkills.length,
      scoringBreakdown: {
        skillMatchCount: matchedSkills.length,
        softwareClusterMatch: false,
        stemMatch: false,
        queryMatch: false,
        unrelatedDomainPenalty: false,
      },
    };
  }

  // 3. Unrelated Domain Protection:
  // Reject jobs that clearly belong to non-tech fields (sales, nursing, real estate, etc.)
  const isUnrelated = UNRELATED_DOMAINS.some(ud => {
    const escaped = ud.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`, 'i').test(lowerTitle);
  });
  if (isUnrelated) {
    return {
      relevant: false,
      score: 0,
      threshold,
      reason: `Job title matches non-tech domain`,
      matchedSkills: [],
      totalCandidateSkills: rawSkills.length,
      scoringBreakdown: {
        skillMatchCount: 0,
        softwareClusterMatch: false,
        stemMatch: false,
        queryMatch: false,
        unrelatedDomainPenalty: true,
      },
    };
  }

  // 4. Software Engineering / Tech Cluster Matching:
  // If candidate target role is in the software/tech field (e.g. "Full Stack Developer", "Software Engineer",
  // "Frontend Developer", "full stack development"), and job title belongs to the same engineering cluster,
  // classify as relevant.
  const targetTitles = [targetRole || '', careerBrain.currentTitle || '', ...(careerBrain.predefinedRoles || [])]
    .map(t => t.toLowerCase().trim())
    .filter(t => t.length > 0);

  const isCandidateTech =
    targetTitles.some(t => SOFTWARE_DOMAIN_KEYWORDS.some(kw => t.includes(kw))) || rawSkills.length > 0;

  const matchedJobTechKw = SOFTWARE_DOMAIN_KEYWORDS.find(kw => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`, 'i').test(lowerTitle);
  });

  if (isCandidateTech && matchedJobTechKw) {
    return {
      relevant: true,
      score: 85,
      threshold,
      matchedSkills: [`Software Engineering role match ("${matchedJobTechKw}")`],
      totalCandidateSkills: rawSkills.length,
      scoringBreakdown: {
        skillMatchCount: 0,
        softwareClusterMatch: true,
        stemMatch: false,
        queryMatch: false,
        unrelatedDomainPenalty: false,
      },
    };
  }

  // 5. Stem / Token Overlap Fallback (e.g. "development" <-> "developer")
  const combinedTarget = [targetRole || '', careerBrain.currentTitle || ''].filter(Boolean).join(' ').toLowerCase();
  const targetTokens = combinedTarget
    .split(/[\s,/-]+/)
    .map(w => stemWord(w))
    .filter(w => w.length > 2 && !['senior', 'junior', 'lead', 'staff', 'role', 'intern'].includes(w));

  const titleTokens = lowerTitle
    .split(/[\s,/-]+/)
    .map(w => stemWord(w))
    .filter(w => w.length > 2);

  const sharedStem = targetTokens.find(token =>
    titleTokens.some(tt => tt === token || tt.startsWith(token) || token.startsWith(tt)),
  );
  if (sharedStem) {
    return {
      relevant: true,
      score: 80,
      threshold,
      matchedSkills: [`Role title stem match: "${sharedStem}"`],
      totalCandidateSkills: rawSkills.length,
      scoringBreakdown: {
        skillMatchCount: 0,
        softwareClusterMatch: isCandidateTech,
        stemMatch: true,
        queryMatch: false,
        unrelatedDomainPenalty: false,
      },
    };
  }

  // 6. Platform Search Query Benefit of Doubt (when description is missing/unmounted)
  const hasSubstantialDescription = (descriptionSnippet || '').trim().length > 60;
  if (!hasSubstantialDescription && targetRole) {
    return {
      relevant: true,
      score: 75,
      threshold,
      matchedSkills: ['Platform search query match (description pending)'],
      totalCandidateSkills: rawSkills.length,
      scoringBreakdown: {
        skillMatchCount: 0,
        softwareClusterMatch: isCandidateTech,
        stemMatch: false,
        queryMatch: true,
        unrelatedDomainPenalty: false,
      },
    };
  }

  return {
    relevant: false,
    score: 10,
    threshold,
    reason: `Low relevance: 0 matching skills found in job posting for candidate profile (${rawSkills.slice(0, 5).join(', ')}${rawSkills.length > 5 ? '...' : ''})`,
    matchedSkills: [],
    totalCandidateSkills: rawSkills.length,
    scoringBreakdown: {
      skillMatchCount: 0,
      softwareClusterMatch: false,
      stemMatch: false,
      queryMatch: false,
      unrelatedDomainPenalty: false,
    },
  };
}

/**
 * Resolves an active LLM scoped with x-run-id header for Bedrock Gateway accounting.
 * This guarantees Bedrock deductions are ledger-tagged per job, enabling precise
 * automatic refund on failure or skip without affecting other jobs in the batch.
 */
async function getJobScopedLLM(jobRunId: string): Promise<BaseChatModel | undefined> {
  try {
    const session = await authStorage.getSession();
    if (session?.token) {
      return new ChatOpenAI({
        modelName: 'amazon.nova-lite-v1:0',
        apiKey: session.token,
        configuration: {
          baseURL: BACKEND_LLM_URL,
          defaultHeaders: {
            Authorization: `Bearer ${session.token}`,
            'x-run-id': jobRunId,
          },
        },
        temperature: 0.1,
        maxTokens: 4096,
      });
    }

    const providers = await llmProviderStore.getAllProviders();
    const agentModels = await agentModelStore.getAllAgentModels();
    const plannerAgentModel = agentModels[AgentNameEnum.Planner];
    if (plannerAgentModel && providers[plannerAgentModel.provider]) {
      return createChatModel(providers[plannerAgentModel.provider], plannerAgentModel);
    }
    const firstProviderKey = Object.keys(providers)[0];
    if (firstProviderKey && providers[firstProviderKey]) {
      const p = providers[firstProviderKey];
      return createChatModel(p, {
        provider: firstProviderKey,
        modelName: p.modelNames?.[0] || 'gpt-4o-mini',
      });
    }
  } catch (err) {
    logger.warning('[DedicatedJobRunner] Could not resolve job-scoped LLM:', err);
  }
  return undefined;
}

/** Cached alternate target role derived in the same resume LLM call */
export let lastResolvedAlternateRole: string | undefined = undefined;

export function getLastResolvedAlternateRole(): string | undefined {
  return lastResolvedAlternateRole;
}

/**
 * Analyzes candidate's resume, work experience, and technical skills using LLM
 * to accurately identify their target job title (e.g. "Full Stack Developer", "Software Engineer").
 * In the same LLM call, also extracts an alternate/secondary role term for lightweight fallback search.
 * Strictly prohibits using the candidate's personal name ("MUBASSHIR", "Mubasshir Ali") as a role.
 * Automatically saves the resolved role to careerBrainStore to permanently fix their profile.
 */
export async function resolveTargetRoleFromResumeWithLLM(
  careerBrain: ICareerBrain,
  scopedLLM?: BaseChatModel,
  userNameFallback?: string,
): Promise<string> {
  const candidateNames = [careerBrain.fullName, userNameFallback].filter(Boolean);

  // 1. Check if predefinedRoles has a valid non-name title
  if (Array.isArray(careerBrain.predefinedRoles) && careerBrain.predefinedRoles.length > 0) {
    for (const pr of careerBrain.predefinedRoles) {
      const clean = sanitizeRoleSearchQuery(pr, candidateNames, '');
      if (clean && !isCandidateNameOrInvalidTitle(clean, candidateNames)) {
        await careerBrainStore.updateCareerBrain({ currentTitle: clean });
        careerBrain.currentTitle = clean;
        lastResolvedAlternateRole =
          careerBrain.predefinedRoles[1] ||
          (clean.toLowerCase().includes('software') ? 'Full Stack Developer' : 'Software Engineer');
        return clean;
      }
    }
  }

  // 2. Check if any stored resume profile has a targetRole
  if (Array.isArray(careerBrain.resumes) && careerBrain.resumes.length > 0) {
    for (const r of careerBrain.resumes) {
      const tr = sanitizeRoleSearchQuery(r.targetRole, candidateNames, '');
      if (tr && !isCandidateNameOrInvalidTitle(tr, candidateNames)) {
        await careerBrainStore.updateCareerBrain({ currentTitle: tr });
        careerBrain.currentTitle = tr;
        lastResolvedAlternateRole = tr.toLowerCase().includes('software')
          ? 'Full Stack Developer'
          : 'Software Engineer';
        return tr;
      }
    }
  }

  // 3. Invoke LLM to analyze resumeText, skills, and work experience (single call for primary + alternate)
  let candidateLLM = scopedLLM;
  if (!candidateLLM) {
    try {
      candidateLLM = await getJobScopedLLM('role_resume_resolver');
    } catch {}
  }

  if (candidateLLM) {
    try {
      const skillsStr = (careerBrain.skills || []).slice(0, 20).join(', ');
      const expStr = (careerBrain.workExperience || []).map(e => `${e.title} at ${e.company}`).join('; ');
      const resumeSnippet = (careerBrain.resumeText || '').slice(0, 3500);
      const prohibitedCandidateName = careerBrain.fullName || userNameFallback || '';

      const prompt = `You are an expert technical recruiter analyzing a candidate's profile and resume.
Determine the candidate's primary target job title and one alternate/secondary title for job searching (e.g. Primary: "Full Stack Developer" | Alternate: "Software Engineer").

Candidate Name: "${prohibitedCandidateName || 'Candidate'}"
Skills: ${skillsStr || 'Not provided'}
Experience: ${expStr || 'Not provided'}
Resume Excerpt:
${resumeSnippet || 'Not provided'}

CRITICAL RULES:
1. Output format: Primary: [Job Title] | Alternate: [Alternate Job Title]
2. NEVER output the candidate's name ("${prohibitedCandidateName}") or any part of it.
3. Do NOT include quotes, explanations, markdown, or commentary.`;

      const response = await candidateLLM.invoke(prompt);
      const rawText =
        typeof response?.content === 'string'
          ? response.content
          : Array.isArray(response?.content)
            ? response.content.map((c: any) => c.text || '').join(' ')
            : '';

      let cleanedRole = '';
      let cleanedAlternate = '';

      if (rawText.includes('|') || /alternate\s*:/i.test(rawText)) {
        const parts = rawText.split('|');
        for (const p of parts) {
          if (/primary\s*:/i.test(p)) {
            cleanedRole = p
              .replace(/primary\s*:/i, '')
              .replace(/["'`*#]/g, '')
              .trim();
          } else if (/alternate\s*:/i.test(p)) {
            cleanedAlternate = p
              .replace(/alternate\s*:/i, '')
              .replace(/["'`*#]/g, '')
              .trim();
          }
        }
      }

      if (!cleanedRole) {
        cleanedRole = rawText
          .replace(/["'`*#]/g, '')
          .replace(/^(target\s*(?:job\s*)?title\s*:|role\s*:|title\s*:)/i, '')
          .trim();
      }

      cleanedRole = sanitizeRoleSearchQuery(cleanedRole, candidateNames, '');
      cleanedAlternate = sanitizeRoleSearchQuery(cleanedAlternate, candidateNames, '');

      if (cleanedRole && !isCandidateNameOrInvalidTitle(cleanedRole, candidateNames)) {
        logger.info(`[DedicatedJobRunner] 🧠 AI successfully resolved target role from resume: "${cleanedRole}"`);
        if (
          cleanedAlternate &&
          !isCandidateNameOrInvalidTitle(cleanedAlternate, candidateNames) &&
          cleanedAlternate.toLowerCase() !== cleanedRole.toLowerCase()
        ) {
          lastResolvedAlternateRole = cleanedAlternate;
        } else {
          lastResolvedAlternateRole = cleanedRole.toLowerCase().includes('software')
            ? 'Full Stack Developer'
            : 'Software Engineer';
        }
        await careerBrainStore.updateCareerBrain({
          currentTitle: cleanedRole,
          predefinedRoles: [cleanedRole, ...(lastResolvedAlternateRole ? [lastResolvedAlternateRole] : [])],
        });
        careerBrain.currentTitle = cleanedRole;
        return cleanedRole;
      }
    } catch (llmErr) {
      logger.warning('[DedicatedJobRunner] LLM resume analysis for role failed, using heuristic:', llmErr);
    }
  }

  // 4. Check work experience for valid tech title
  if (Array.isArray(careerBrain.workExperience) && careerBrain.workExperience.length > 0) {
    for (const item of careerBrain.workExperience) {
      const t = sanitizeRoleSearchQuery(item.title, candidateNames, '');
      if (t && !isCandidateNameOrInvalidTitle(t, candidateNames)) {
        lastResolvedAlternateRole = t.toLowerCase().includes('software') ? 'Full Stack Developer' : 'Software Engineer';
        await careerBrainStore.updateCareerBrain({ currentTitle: t, predefinedRoles: [t, lastResolvedAlternateRole] });
        careerBrain.currentTitle = t;
        return t;
      }
    }
  }

  // 5. Intelligent skill stack heuristic
  const skillsLo = (careerBrain.skills || []).map(s => s.toLowerCase());
  const hasReact = skillsLo.some(
    s => s.includes('react') || s.includes('vue') || s.includes('angular') || s.includes('frontend'),
  );
  const hasNode = skillsLo.some(
    s =>
      s.includes('node') ||
      s.includes('express') ||
      s.includes('backend') ||
      s.includes('mongo') ||
      s.includes('sql') ||
      s.includes('python'),
  );

  let fallback = 'Full Stack Developer';
  if (hasReact && hasNode) {
    fallback = skillsLo.some(s => s.includes('mongo') || s.includes('express'))
      ? 'MERN Stack Developer'
      : 'Full Stack Developer';
  } else if (hasReact) {
    fallback = 'Frontend Developer';
  } else if (hasNode) {
    fallback = 'Backend Developer';
  }

  lastResolvedAlternateRole = fallback.toLowerCase().includes('software')
    ? 'Full Stack Developer'
    : 'Software Engineer';
  await careerBrainStore.updateCareerBrain({
    currentTitle: fallback,
    predefinedRoles: [fallback, lastResolvedAlternateRole],
  });
  careerBrain.currentTitle = fallback;
  return fallback;
}

export type JobActivityStatus =
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'running'
  | 'modal_opened'
  | 'modal_failed'
  | 'needs_verification';

export interface RunJobOptions {
  inputUrl: string;
  portToSend?: chrome.runtime.Port | null;
  onLiveActivity?: (activity: {
    jobId: string;
    url: string;
    title: string;
    company: string;
    status: JobActivityStatus;
    reason?: string;
    creditsUsed?: number;
  }) => void;
}

export interface AutonomousLoopOptions {
  maxJobs?: number;
  platform?: SupportedPlatform;
  /**
   * Explicit runner execution mode:
   * - 'tab': opens/reuses a dedicated tab in the user's active/current browser window (default for all platforms).
   * - 'window': opens/reuses a dedicated side-by-side window.
   */
  runnerMode?: RunnerMode;
  portToSend?: chrome.runtime.Port | null;
  onLiveActivity?: (activity: {
    jobId: string;
    url: string;
    title: string;
    company: string;
    status: JobActivityStatus;
    reason?: string;
    creditsUsed?: number;
  }) => void;
}

export type ExecutorFactory = (
  taskId: string,
  prompt: string,
  ctx: BrowserContext,
  options?: any,
  isJobApplyRun?: boolean,
) => Promise<Executor>;

export function formatFriendlySkipReason(rawReason: string): string {
  if (!rawReason) return 'Application could not be completed';
  const r = rawReason.toLowerCase();
  if (r.includes('already applied')) {
    return 'You already applied to this job earlier on LinkedIn.';
  }
  if (r.includes('external application') || r.includes('no easy apply') || r.includes('external site')) {
    return 'Requires applying directly on the company website (not Easy Apply).';
  }
  if (r.includes('no longer accepting') || r.includes('closed listing') || r.includes('closed')) {
    return 'This job posting is closed and no longer accepting applications.';
  }
  if (
    r.includes('over-qualified') ||
    r.includes('low candidate fit') ||
    r.includes('low relevance') ||
    r.includes('relevance')
  ) {
    return 'Job requirements do not match your current skills.';
  }
  if (r.includes('modal failed to open')) {
    return 'LinkedIn Easy Apply form could not be opened.';
  }
  if (r.includes('validation error') || r.includes('required field')) {
    return 'LinkedIn form required answers not available in profile.';
  }
  return rawReason.replace(/^skipped:\s*/i, '');
}

export class DedicatedJobRunner {
  private static instance: DedicatedJobRunner | null = null;
  private browserContext: BrowserContext | null = null;
  private executorFactory: ExecutorFactory | null = null;
  private executorSubscriber: ((exec: Executor) => Promise<void>) | null = null;
  private currentExecutor: Executor | null = null;
  private isRunning = false;
  private activeRunId: string | null = null;
  private activeJobId: string | null = null;
  private activePort: chrome.runtime.Port | null = null;
  private activeLiveActivity: ((act: any) => void) | undefined = undefined;
  private keepAliveInterval: any = null;
  private unregisterWindowCloseListener: (() => void) | null = null;
  private unregisterNavAwayListener: (() => void) | null = null;
  private abortController: AbortController | null = null;
  private onStopCallbacks: Set<() => void> = new Set();

  private async syncJobApplicationToBackend(record: {
    jobId: string;
    jobTitle: string;
    company: string;
    platform?: string;
    applicationUrl?: string;
    location?: string;
    salaryRange?: string;
    fitScore?: number;
    status?: string;
    appliedAt?: string;
  }): Promise<void> {
    try {
      const session = await authStorage.getSession();
      if (!session?.token) {
        return;
      }
      await backendApiClient.recordJobApplication({
        jobId: record.jobId,
        jobTitle: record.jobTitle,
        company: record.company,
        platform: record.platform || 'linkedin',
        applicationUrl: record.applicationUrl,
        location: record.location,
        salaryRange: record.salaryRange,
        fitScore: record.fitScore,
        status: record.status || 'applied',
        appliedAt: record.appliedAt || new Date().toISOString(),
      });
      logger.info(
        `[DedicatedJobRunner] Successfully synced application to backend: ${record.jobTitle} at ${record.company}`,
      );
    } catch (syncErr) {
      // Non-blocking: application submission already succeeded locally
      logger.warning(`[DedicatedJobRunner] Failed to sync job application to backend (non-blocking):`, syncErr);
    }
  }

  public static getInstance(): DedicatedJobRunner {
    if (!DedicatedJobRunner.instance) {
      DedicatedJobRunner.instance = new DedicatedJobRunner();
    }
    return DedicatedJobRunner.instance;
  }

  public setBrowserContext(ctx: BrowserContext): void {
    this.browserContext = ctx;
  }

  public setExecutorFactory(factory: ExecutorFactory): void {
    this.executorFactory = factory;
  }

  public setExecutorSubscriber(subscriber: (exec: Executor) => Promise<void>): void {
    this.executorSubscriber = subscriber;
  }

  public getCurrentExecutor(): Executor | null {
    return this.currentExecutor;
  }

  public isJobRunning(): boolean {
    return this.isRunning;
  }

  public onStop(cb: () => void): () => void {
    this.onStopCallbacks.add(cb);
    return () => {
      this.onStopCallbacks.delete(cb);
    };
  }

  private notifyStopListeners(): void {
    for (const cb of Array.from(this.onStopCallbacks)) {
      try {
        cb();
      } catch (err) {
        logger.error('[DedicatedJobRunner] Error in onStop callback:', err);
      }
    }
  }

  private notify(
    portToSend: chrome.runtime.Port | null | undefined,
    msg: string,
    isErr = false,
    taskId = 'runner_status',
  ): void {
    logger.info(`[DedicatedJobRunner] ${msg}`);
    if (portToSend) {
      try {
        portToSend.postMessage({
          actor: Actors.SYSTEM,
          state: isErr ? ExecutionState.STEP_FAIL : ExecutionState.STEP_OK,
          data: {
            taskId,
            step: 1,
            maxSteps: 1,
            details: msg,
          },
        });
      } catch {}
    }
  }

  private notifyStatus(
    portToSend: chrome.runtime.Port | null | undefined,
    text: string,
    status: 'ok' | 'fail' | 'info' = 'info',
  ): void {
    logger.info(`[DedicatedJobRunner] ${text}`);
    if (portToSend) {
      try {
        portToSend.postMessage({
          type: 'LINKEDIN_STATUS_UPDATE',
          text,
          status,
        });
      } catch {}
    }
  }

  private notifyActivity(
    portToSend: chrome.runtime.Port | null | undefined,
    onLiveActivity: ((act: any) => void) | undefined,
    activity: {
      jobId: string;
      url: string;
      title: string;
      company: string;
      status: JobActivityStatus;
      reason?: string;
      creditsUsed?: number;
    },
  ): void {
    if (onLiveActivity) {
      try {
        onLiveActivity(activity);
      } catch {}
    }
    if (portToSend) {
      try {
        portToSend.postMessage({
          type: 'LIVE_ACTIVITY_UPDATE',
          data: activity,
        });
      } catch {}
    }
  }

  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise(resolve => {
      if (!this.isRunning || !this.abortController || this.abortController.signal.aborted) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        resolve(false);
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };

      this.abortController.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private startKeepAlive(): void {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      chrome.alarms.create('job_runner_keep_alive', { periodInMinutes: 0.5 });
    }
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    this.keepAliveInterval = setInterval(() => {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.getPlatformInfo().catch(() => {});
      }
    }, 12000);
  }

  private stopKeepAlive(): void {
    if (typeof chrome !== 'undefined' && chrome.alarms) {
      chrome.alarms.clear('job_runner_keep_alive').catch(() => {});
    }
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  /**
   * Core M0 Flow: Applies to a single job link in a dedicated browser window.
   */
  public async runJobByUrl(
    options: RunJobOptions,
  ): Promise<{ status: 'success' | 'skipped' | 'error'; message: string }> {
    const { inputUrl, portToSend, onLiveActivity } = options;

    // 0. AUTHENTICATION GATE: Enforce valid user session before starting
    let session = await authStorage.getSession();
    if (!session?.token && session?.refreshToken) {
      const refreshedToken = await backendApiClient.refreshAccessToken();
      if (refreshedToken) {
        session = await authStorage.getSession();
      }
    }

    if (!session?.token) {
      logger.warning('[dedicatedJobRunner] Blocked unauthenticated run attempt.');
      const authErr = 'AUTH_REQUIRED: Please log in to start automation';
      this.notify(portToSend, authErr, true);
      if (portToSend) {
        try {
          portToSend.postMessage({
            type: 'ERROR',
            error: authErr,
          });
        } catch {}
      }
      return { status: 'error', message: authErr };
    }

    if (this.isRunning) {
      this.notify(portToSend, '⚠️ A job application is already running.', true);
      return { status: 'error', message: 'Another job application is already running.' };
    }

    if (!this.browserContext) {
      this.notify(portToSend, '⚠️ Browser context not initialized.', true);
      return { status: 'error', message: 'Browser context not initialized.' };
    }

    if (!this.executorFactory) {
      this.notify(portToSend, '⚠️ Agent executor factory not configured.', true);
      return { status: 'error', message: 'Agent executor factory not configured.' };
    }

    // 1. URL Normalization & Validation
    const norm = normalizeLinkedInJobUrl(inputUrl);
    if (!norm.valid || !norm.jobId || !norm.canonicalUrl) {
      const errMsg = norm.error || 'Invalid LinkedIn job link provided.';
      this.notify(portToSend, `🛑 ${errMsg}`, true);
      return { status: 'error', message: errMsg };
    }

    const { jobId, canonicalUrl } = norm;
    this.activeJobId = jobId;
    this.isRunning = true;

    // 2. Duplicate Check in Processed Jobs Store
    const processedCheck = await processedJobsStore.isJobProcessed(jobId);
    if (processedCheck.isProcessed && processedCheck.status === 'applied') {
      const processedDate = processedCheck.record?.timestamp
        ? new Date(processedCheck.record.timestamp).toLocaleDateString()
        : 'previously';
      const msg = `Job was already applied on ${processedDate}`;
      this.notify(portToSend, `ℹ️ Skipping: ${msg}`);
      if (onLiveActivity) {
        onLiveActivity({
          jobId,
          url: canonicalUrl,
          title: processedCheck.record?.title || 'LinkedIn Job',
          company: processedCheck.record?.company || '',
          status: 'skipped',
          reason: msg,
          creditsUsed: 0,
        });
      }
      this.isRunning = false;
      return { status: 'skipped', message: msg };
    }

    // 3. Quota & Profile Completeness Checks
    const quota = await DailyQuotaManager.canApplyToday();
    if (!quota.allowed) {
      const quotaMsg = `Daily application quota reached (${quota.currentCount} applications today).`;
      this.notify(portToSend, `🛑 ${quotaMsg}`, true);
      this.isRunning = false;
      return { status: 'error', message: quotaMsg };
    }

    const careerBrain = await careerBrainStore.getCareerBrain();
    const completeness = validateProfileCompleteness(careerBrain);
    if (!completeness.isValid) {
      const missingList = completeness.missingFields.join(', ');
      const msg = `Incomplete candidate profile. Missing: ${missingList}. Please update Resume & Profile tab.`;
      this.notify(portToSend, `⚠️ ${msg}`, true);
      this.isRunning = false;
      return { status: 'error', message: msg };
    }

    const runId = `easy_apply_${jobId}_${Date.now()}`;
    this.activeRunId = runId;
    this.activePort = portToSend || null;
    this.activeLiveActivity = onLiveActivity;

    try {
      this.startKeepAlive();
      this.notify(portToSend, `🌐 Opening dedicated runner tab in current window for Job ID ${jobId}...`);

      // 4. Open / Reuse Dedicated Runner Tab
      const { windowId, tabId } = await dedicatedWindowManager.getOrCreateRunnerWindow(canonicalUrl, {
        mode: 'tab',
        allowedDomains: [/linkedin\.com/i, /^about:blank$/i],
      });
      this.browserContext.updateCurrentTabId(tabId);

      // Persist active run state immediately
      await runnerStateStore.setActiveRun({
        runId,
        jobId,
        canonicalUrl,
        jobTitle: 'Loading Job...',
        company: '',
        status: 'navigating',
        step: 1,
        startTime: Date.now(),
        lastUpdated: Date.now(),
        creditsDeducted: 0,
        dedicatedTabId: tabId,
        dedicatedWindowId: windowId,
      });

      // Register tab/window close abort listener
      this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async reason => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(
            `Dedicated runner target closed while run ${runId} was active (reason: ${reason}). Cancelling and refunding...`,
          );
          if (this.currentExecutor) {
            this.currentExecutor.cancel();
          }
          await backendApiClient.refundCredits(runId).catch(() => {});
          await runnerStateStore.updateRunStatus('failed', { errorReason: 'Runner tab closed by user' });
          await processedJobsStore.recordJob({
            jobId,
            url: canonicalUrl,
            title: 'Closed Tab',
            company: '',
            status: 'failed',
            reason: 'Runner tab closed by user',
            creditsUsed: 0,
          });
          this.notify(portToSend, '🛑 Application cancelled: Runner tab was closed.', true, runId);
          if (onLiveActivity) {
            onLiveActivity({
              jobId,
              url: canonicalUrl,
              title: 'Closed Tab',
              company: '',
              status: 'failed',
              reason: 'Runner tab closed by user',
              creditsUsed: 0,
            });
          }
          this.cleanupRun();
        }
      });

      // Register navigation boundary listener
      this.unregisterNavAwayListener = dedicatedWindowManager.onNavigatedAway(async (newUrl: string) => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(
            `Runner tab navigated away to ${newUrl} while run ${runId} was active. Cancelling and refunding...`,
          );
          if (this.currentExecutor) {
            this.currentExecutor.cancel();
          }
          await backendApiClient.refundCredits(runId).catch(() => {});
          await runnerStateStore.updateRunStatus('failed', { errorReason: 'Navigated away from LinkedIn' });
          await processedJobsStore.recordJob({
            jobId,
            url: canonicalUrl,
            title: 'Navigated Away',
            company: '',
            status: 'failed',
            reason: 'Navigated away from LinkedIn',
            creditsUsed: 0,
          });
          this.notify(portToSend, `🛑 Application cancelled: Navigated away from LinkedIn (${newUrl}).`, true, runId);
          this.cleanupRun();
        }
      });

      // Wait a moment for page navigation
      await new Promise(resolve => setTimeout(resolve, 4000));

      const currentPage = await this.browserContext.getCurrentPage();
      await this.markRunnerTabVisually(currentPage);
      const devtoolsNotice =
        '⚠️ DevTools detected on job tab - this may cause a disconnect if DevTools is kept open or toggled.';
      this.notify(portToSend, devtoolsNotice);
      if (onLiveActivity) {
        onLiveActivity({
          jobId,
          url: canonicalUrl,
          title: 'Debugger Attached',
          company: 'LinkedIn Runner',
          status: 'running',
          reason: devtoolsNotice,
          creditsUsed: 0,
        });
      }
      this.notify(portToSend, '🔍 Inspecting job page details & checking login status...');

      // 5. Extract Top-Card Context & Handle Login Wall
      let topCard = await currentPage.extractJobTopCardContext(12000);

      // Login Wall Detection & Pause Gate
      if (topCard.isLoginWall) {
        this.notify(
          portToSend,
          '⚠️ LinkedIn login required. Please log in to LinkedIn in the runner window. (Pausing without spending credits...)',
        );

        if (onLiveActivity) {
          onLiveActivity({
            jobId,
            url: canonicalUrl,
            title: 'Waiting for login',
            company: 'LinkedIn',
            status: 'running',
            reason: 'Please log in to LinkedIn in the runner window',
            creditsUsed: 0,
          });
        }

        // Wait up to 5 minutes (300 seconds) for user to log in
        const loginStartTime = Date.now();
        let loggedIn = false;
        while (Date.now() - loginStartTime < 300_000) {
          await new Promise(r => setTimeout(r, 3000));
          if (!this.isRunning) break;

          topCard = await currentPage.extractJobTopCardContext(5000);
          if (!topCard.isLoginWall) {
            loggedIn = true;
            this.notify(portToSend, '✅ Login detected! Resuming application...');
            break;
          }
        }

        if (!loggedIn) {
          const timeoutMsg = 'Login timeout (5 minutes reached). Please log in and try again.';
          this.notify(portToSend, `🛑 ${timeoutMsg}`, true);
          await runnerStateStore.updateRunStatus('failed', { errorReason: timeoutMsg });
          this.cleanupRun();
          return { status: 'error', message: timeoutMsg };
        }
      }

      // Update state with extracted title & company
      const jobTitle = topCard.title || 'LinkedIn Job';
      const companyName = topCard.company || 'Company';
      const location = topCard.location || '';

      await runnerStateStore.updateRunStatus('running', { jobTitle, company: companyName });

      if (onLiveActivity) {
        onLiveActivity({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'running',
          creditsUsed: 0,
        });
      }

      // 6. Zero-Credit Skips
      // 6a. Closed Job Check
      if (topCard.isClosed) {
        const closedMsg = `Job "${jobTitle}" is no longer accepting applications.`;
        this.notify(portToSend, `ℹ️ Skipping (0 credits): ${closedMsg}`);
        await processedJobsStore.recordJob({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'skipped',
          reason: 'No longer accepting applications',
          creditsUsed: 0,
        });
        await runnerStateStore.updateRunStatus('skipped', { errorReason: closedMsg });
        if (onLiveActivity) {
          onLiveActivity({
            jobId,
            url: canonicalUrl,
            title: jobTitle,
            company: companyName,
            status: 'skipped',
            reason: 'No longer accepting applications',
            creditsUsed: 0,
          });
        }
        this.cleanupRun();
        return { status: 'skipped', message: closedMsg };
      }

      // 6b. Already Applied Check
      if (topCard.isAlreadyApplied) {
        const appliedMsg = `Job "${jobTitle}" already shows as Applied on LinkedIn.`;
        this.notify(portToSend, `ℹ️ Skipping (0 credits): ${appliedMsg}`);
        await processedJobsStore.recordJob({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'applied',
          reason: 'Already applied on LinkedIn',
          creditsUsed: 0,
        });
        await runnerStateStore.updateRunStatus('skipped', { errorReason: appliedMsg });
        if (onLiveActivity) {
          onLiveActivity({
            jobId,
            url: canonicalUrl,
            title: jobTitle,
            company: companyName,
            status: 'skipped',
            reason: 'Already applied on LinkedIn',
            creditsUsed: 0,
          });
        }
        this.cleanupRun();
        return { status: 'skipped', message: appliedMsg };
      }

      // 6c. Non-Easy Apply Check
      if (!topCard.hasEasyApply) {
        const extMsg = `Job "${jobTitle}" does not support Easy Apply (external application required).`;
        this.notify(portToSend, `ℹ️ Skipping (0 credits): ${extMsg}`);
        await processedJobsStore.recordJob({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'skipped',
          reason: 'External application only (no Easy Apply)',
          creditsUsed: 0,
        });
        await runnerStateStore.updateRunStatus('skipped', { errorReason: extMsg });
        if (onLiveActivity) {
          onLiveActivity({
            jobId,
            url: canonicalUrl,
            title: jobTitle,
            company: companyName,
            status: 'skipped',
            reason: 'External application only',
            creditsUsed: 0,
          });
        }
        this.cleanupRun();
        return { status: 'skipped', message: extMsg };
      }

      // 7. Build Apply Prompt using top-card metadata & Candidate profile
      const { taskPrompt, notProvidedFields } = buildLinkedInApplyTaskDetails(
        careerBrain,
        jobTitle,
        companyName,
        location,
      );

      console.debug(
        '[DedicatedRunner] Target Job:',
        jobTitle,
        'Company:',
        companyName,
        'Missing fields:',
        notProvidedFields,
      );
      logger.info(`[DedicatedRunner] Launching Easy Apply for "${jobTitle}" at "${companyName}" (runId=${runId})`);

      this.notify(portToSend, `🚀 Launching AI Agent for "${jobTitle}" at "${companyName}"...`, false, runId);

      // 8. Create and Execute Agent
      const executor = await this.executorFactory(
        runId,
        taskPrompt,
        this.browserContext,
        {
          maxActionsPerStep: 1,
          planningInterval: 1,
          maxSteps: 25,
        },
        true, // isJobApplyRun = true
      );

      this.currentExecutor = executor;
      if (this.executorSubscriber) {
        await this.executorSubscriber(executor);
      }

      const execResult = await executor.execute();

      // 9. Process Result
      if (!execResult || !execResult.success) {
        const failReason = execResult?.reason || 'Application failed or submission could not be verified.';
        logger.error(`❌ Run failed for "${jobTitle}": ${failReason}`);
        this.notify(portToSend, `❌ Application failed: ${failReason}`, true, runId);

        // Refund credits via server computing from ledger for this runId
        logger.info(`[DedicatedRunner] Triggering refund for runId: ${runId}`);
        await backendApiClient.refundCredits(runId).catch(err => {
          logger.error('Failed to trigger refund:', err);
        });

        await runnerStateStore.updateRunStatus('failed', { errorReason: failReason });
        await processedJobsStore.recordJob({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'failed',
          reason: failReason,
          creditsUsed: 0,
        });

        if (onLiveActivity) {
          onLiveActivity({
            jobId,
            url: canonicalUrl,
            title: jobTitle,
            company: companyName,
            status: 'failed',
            reason: failReason,
          });
        }

        this.cleanupRun();
        return { status: 'error', message: failReason };
      }

      // Success Path: Verified Application!
      logger.info(`🎉 Successfully completed application for "${jobTitle}"!`);
      await DailyQuotaManager.incrementAppliedCount();
      await queueSafetyStore.setSingleApplyVerified(true);
      await processedJobsStore.recordJob({
        jobId,
        url: canonicalUrl,
        title: jobTitle,
        company: companyName,
        status: 'applied',
        reason: 'Successfully submitted application via Easy Apply',
        creditsUsed: 1,
      });

      await this.syncJobApplicationToBackend({
        jobId,
        jobTitle,
        company: companyName,
        platform: 'linkedin',
        applicationUrl: canonicalUrl,
        status: 'applied',
        appliedAt: new Date().toISOString(),
      });

      await runnerStateStore.updateRunStatus('completed');

      this.notify(
        portToSend,
        `🎉 Successfully submitted application for "${jobTitle}" at "${companyName}"!`,
        false,
        runId,
      );

      if (onLiveActivity) {
        onLiveActivity({
          jobId,
          url: canonicalUrl,
          title: jobTitle,
          company: companyName,
          status: 'applied',
          reason: 'Verified submission',
        });
      }

      this.cleanupRun();
      return { status: 'success', message: `Applied to ${jobTitle}` };
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      logger.error(`[DedicatedRunner] Unhandled exception during run ${runId}:`, err);
      this.notify(portToSend, `⚠️ Application stopped: ${errMsg}`, true, runId);

      if (runId) {
        await backendApiClient.refundCredits(runId).catch(() => {});
        await runnerStateStore.updateRunStatus('failed', { errorReason: errMsg });
        await processedJobsStore.recordJob({
          jobId,
          url: canonicalUrl,
          title: 'Error',
          company: '',
          status: 'failed',
          reason: errMsg,
          creditsUsed: 0,
        });
      }

      this.cleanupRun();
      return { status: 'error', message: errMsg };
    }
  }

  /**
   * Core Autonomous Loop:
   * 1. Reads candidate title & location (falls back to interactive question if missing).
   * 2. Navigates dedicated window to LinkedIn search with f_AL=true & sortBy=R.
   * 3. Scans left-hand search results pane, extracts job cards (max 3 retries).
   * 4. Deduplicates & checks against processedJobsStore, applies max 10 batch cap.
   * 5. Iterates through eligible jobs:
   *    a. Clicks job item to load details in right pane.
   *    b. Pure DOM top-card extraction (max 2 retries, skips if unresolvable).
   *    c. Pure DOM 0-credit skip checks (isClosed, isAlreadyApplied, !hasEasyApply).
   *    d. Clicks Easy Apply, verifies modal opens via waitForEasyApplyModal (with 1 retry).
   *    e. If open, logs "modal_opened" to Live Activity, dismisses modal cleanly (Discard/X).
   *    f. If failed, logs "modal_failed" to Live Activity with failure reason.
   *    g. Anti-ban pacing delay (30-90s) between jobs.
   * 6. Final summary to Live Activity and returns stats.
   */
  public async startAutonomousJobLoop(options: AutonomousLoopOptions = {}): Promise<{
    status: 'success' | 'stopped' | 'error';
    message: string;
    stats: {
      totalFound: number;
      applied: number;
      modalOpened: number;
      skipped: number;
      failed: number;
    };
  }> {
    const { portToSend, onLiveActivity } = options;
    const stats = {
      totalFound: 0,
      applied: 0,
      modalOpened: 0,
      skipped: 0,
      failed: 0,
    };

    // 0. AUTHENTICATION GATE: Enforce valid user session before starting
    let session = await authStorage.getSession();
    if (!session?.token && session?.refreshToken) {
      const refreshedToken = await backendApiClient.refreshAccessToken();
      if (refreshedToken) {
        session = await authStorage.getSession();
      }
    }

    if (!session?.token) {
      logger.warning('[dedicatedJobRunner] Blocked unauthenticated run attempt.');
      const authErr = 'AUTH_REQUIRED: Please log in to start automation';
      this.notifyStatus(portToSend, authErr, 'fail');
      if (portToSend) {
        try {
          portToSend.postMessage({
            type: 'ERROR',
            error: authErr,
          });
        } catch {}
      }
      return { status: 'error', message: authErr, stats };
    }

    // 1. Concurrency Guard
    if (this.isRunning) {
      const busyMsg = '⚠️ A job application run is already active.';
      this.notifyStatus(portToSend, busyMsg, 'fail');
      return { status: 'error', message: busyMsg, stats };
    }

    if (!this.browserContext) {
      const errCtx = '⚠️ Browser context not initialized.';
      this.notifyStatus(portToSend, errCtx, 'fail');
      return { status: 'error', message: errCtx, stats };
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    const initialQuota = await DailyQuotaManager.canApplyToday();
    if (!initialQuota.allowed) {
      const quotaMsg = `🛑 Daily application quota already completed (${initialQuota.currentCount}/${initialQuota.maxQuota} today). Auto Apply is complete for today.`;
      this.notifyStatus(portToSend, quotaMsg, 'fail');
      return { status: 'stopped', message: quotaMsg, stats };
    }

    const targetToApply = options.maxJobs ? Math.min(options.maxJobs, initialQuota.remaining) : initialQuota.remaining;
    const sessionStartTime = Date.now();
    const MAX_SESSION_DURATION_MS = 60 * 60 * 1000; // 60 minutes session max duration
    const runId = `auto_loop_${Date.now()}`;
    this.activeRunId = runId;
    this.activePort = portToSend || null;
    this.activeLiveActivity = onLiveActivity;

    try {
      this.startKeepAlive();
      this.notifyStatus(portToSend, '🧠 Reading candidate criteria from Career Brain profile...', 'info');

      // 2. Candidate Criteria Extraction + Fallback
      const careerBrain = await careerBrainStore.getCareerBrain();
      const config = await linkedInConfigStore.getConfig();
      let role = (careerBrain.currentTitle || '').trim();

      const candidateNameSources = [careerBrain.fullName, session?.user?.name].filter(Boolean);
      const configuredFallbackRole = config?.targetJobTitle || 'Full Stack Developer';

      // Defensively sanitize role query upfront
      role = sanitizeRoleSearchQuery(role, candidateNameSources, configuredFallbackRole);

      // Extract candidate's prioritized preferred locations (e.g. [#1 Bengaluru, #2 Hyderabad, #3 Pune])
      const candidateLocations = (
        Array.isArray(careerBrain.preferredLocations) && careerBrain.preferredLocations.length > 0
          ? careerBrain.preferredLocations
          : [careerBrain.preferredLocation || careerBrain.currentLocation || '']
      )
        .map(l => (l || '').trim())
        .filter(Boolean);

      let location = candidateLocations[0] || '';

      // Guard against candidate personal name (e.g. "MUBASSHIR ALI") or invalid/empty title:
      // Uses LLM to deeply analyze candidate resume, skills, and experience to determine target tech role.
      if (isCandidateNameOrInvalidTitle(role, candidateNameSources)) {
        this.notifyStatus(
          portToSend,
          `🧠 Profile title "${role || 'empty'}" matches candidate name or is generic. Analyzing resume with AI...`,
          'info',
        );
        const scopedLLM = await getJobScopedLLM(runId);
        role = await resolveTargetRoleFromResumeWithLLM(careerBrain, scopedLLM, session?.user?.name);
        role = sanitizeRoleSearchQuery(role, candidateNameSources, configuredFallbackRole);
        this.notifyStatus(
          portToSend,
          `🎯 AI identified target job role from resume: "${role}" (Profile updated)`,
          'ok',
        );
      }

      if (!role || isCandidateNameOrInvalidTitle(role, candidateNameSources)) {
        role = sanitizeRoleSearchQuery('', candidateNameSources, configuredFallbackRole);
        await careerBrainStore.updateCareerBrain({ currentTitle: role });
        careerBrain.currentTitle = role;
      }

      if (!location) {
        this.notifyStatus(portToSend, '❓ Target location missing in profile. Asking user...', 'info');
        try {
          location = await userQuestionManager.askQuestion({
            questionText:
              'What target location or city are you searching in? (e.g. Remote, Bengaluru, India, United States)',
            fieldType: 'text',
          });
          location = (location || '').trim();
          if (location) {
            await careerBrainStore.updateCareerBrain({ currentLocation: location, preferredLocation: location });
          }
        } catch {
          // If asking location fails, default to Remote rather than crashing
          location = 'Remote';
        }
      }

      const prioritizedLocations: string[] =
        candidateLocations.length > 0 ? candidateLocations : [location || 'Remote'];

      if (!role || isCandidateNameOrInvalidTitle(role, candidateNameSources)) {
        role = sanitizeRoleSearchQuery('', candidateNameSources, configuredFallbackRole);
      }

      if (options.platform === 'naukri') {
        return await this.startNaukriJobLoop(options, careerBrain, role, prioritizedLocations, runId, stats);
      }

      if (options.platform === 'indeed') {
        return await this.startIndeedJobLoop(options, careerBrain, role, prioritizedLocations, runId, stats);
      }

      this.notifyStatus(
        portToSend,
        `🎯 Search Criteria: Role="${role}" | Location(s)=${prioritizedLocations.map((loc, idx) => `#${idx + 1} ${loc}`).join(', ')} | Easy Apply=true`,
        'info',
      );

      // 3. Search URL Navigation with f_AL=true & sortBy=R
      // Sanitize role for LinkedIn search keywords
      const searchUrl = linkedinAdapter.buildSearchUrl(role, location, candidateNameSources);

      const runnerMode: RunnerMode = options.runnerMode || 'tab';
      if (runnerMode === 'tab') {
        this.notifyStatus(portToSend, `🌐 Opening dedicated runner tab in current window for LinkedIn...`, 'info');
      } else {
        this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for LinkedIn...`, 'info');
      }

      let runnerTarget: { windowId: number; tabId: number; mode?: RunnerMode };
      try {
        runnerTarget = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl, {
          mode: runnerMode,
          allowedDomains: [/linkedin\.com/i, /^about:blank$/i],
        });
      } catch (err: any) {
        const openErrMsg = `🛑 Failed to open runner ${runnerMode}: ${err?.message || 'Unknown error'}. Please check browser permissions and try again.`;
        logger.error('[DedicatedJobRunner]', openErrMsg);
        this.notifyStatus(portToSend, openErrMsg, 'fail');
        this.cleanupRun();
        return { status: 'stopped', message: openErrMsg, stats };
      }

      const { windowId, tabId } = runnerTarget;
      this.browserContext.updateCurrentTabId(tabId);

      // 1. Close listener (handles user closing the tab or window mid-run)
      this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async reason => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(
            `Dedicated runner target closed while LinkedIn auto loop ${runId} was active (reason: ${reason}).`,
          );
          const closeMsg =
            reason === 'tab_closed' || runnerMode === 'tab'
              ? '🛑 Runner tab was closed — application stopped.'
              : '🛑 Runner window was closed — application stopped.';
          this.notifyStatus(portToSend, closeMsg, 'fail');
          this.stop();
        }
      });

      // 2. Navigation boundary listener (handles user manually typing a different URL mid-run)
      this.unregisterNavAwayListener = dedicatedWindowManager.onNavigatedAway(async (newUrl: string) => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(`Runner tab navigated away to ${newUrl} while LinkedIn auto loop ${runId} was active.`);
          this.notifyStatus(
            portToSend,
            `🛑 Runner tab navigated away from LinkedIn (${newUrl}) — application stopped cleanly.`,
            'fail',
          );
          this.stop();
        }
      });

      // Wait 4s for initial page load & navigation
      const navWaitAborted = await this.interruptibleSleep(4000);
      if (navWaitAborted || !this.isRunning) {
        this.cleanupRun();
        return { status: 'stopped', message: 'Stopped by user', stats };
      }

      const currentPage = await this.browserContext.getCurrentPage();
      await this.markRunnerTabVisually(currentPage);
      const devtoolsNotice =
        '⚠️ DevTools detected on job tab - this may cause a disconnect if DevTools is kept open or toggled.';
      this.notifyStatus(portToSend, devtoolsNotice, 'info');
      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: 'devtools_guard',
        url: searchUrl,
        title: 'Debugger Attached',
        company: 'LinkedIn Runner',
        status: 'running',
        reason: devtoolsNotice,
        creditsUsed: 0,
      });

      // 4. Login Wall Detection & Pause Gate
      let topCardCheck = await currentPage.extractJobTopCardContext(5000);
      if (topCardCheck.isLoginWall) {
        this.notifyStatus(
          portToSend,
          '⚠️ LinkedIn login required. Please log in to LinkedIn in the runner window. (Pausing without spending credits...)',
          'info',
        );

        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: 'login_check',
          url: searchUrl,
          title: 'Waiting for login',
          company: 'LinkedIn',
          status: 'running',
          reason: 'Please log in to LinkedIn in the runner window',
          creditsUsed: 0,
        });

        const loginStartTime = Date.now();
        let loggedIn = false;
        while (Date.now() - loginStartTime < 300_000) {
          const sleepAborted = await this.interruptibleSleep(3000);
          if (sleepAborted || !this.isRunning) break;

          topCardCheck = await currentPage.extractJobTopCardContext(4000);
          if (!topCardCheck.isLoginWall) {
            loggedIn = true;
            this.notifyStatus(portToSend, '✅ Login detected! Resuming autonomous search...', 'ok');
            break;
          }
        }

        if (!loggedIn) {
          const timeoutMsg = 'Login timeout (5 minutes reached). Please log in and retry.';
          this.notifyStatus(portToSend, `🛑 ${timeoutMsg}`, 'fail');
          this.cleanupRun();
          return { status: 'error', message: timeoutMsg, stats };
        }
      }

      // 5. Continuous Search & Apply across prioritized locations and search pages until Daily Limit is reached
      const seenJobIds = new Set<string>();
      const maxPagesPerLocation = 10;
      let totalLinkedInScanned = 0;

      this.notifyStatus(
        portToSend,
        `🚀 Starting continuous LinkedIn Auto Apply session! Goal: Complete daily application limit (${stats.applied + targetToApply} total, need ${targetToApply} today). Safe pacing across 30–60 minutes.`,
        'ok',
      );

      locationLoop: for (let locIdx = 0; locIdx < prioritizedLocations.length; locIdx++) {
        if (
          !this.isRunning ||
          stats.applied >= targetToApply ||
          Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS
        )
          break;

        const currentLoc = prioritizedLocations[locIdx];
        const locRank = locIdx + 1;

        pageLoop: for (let searchPageIndex = 0; searchPageIndex < maxPagesPerLocation; searchPageIndex++) {
          if (
            !this.isRunning ||
            stats.applied >= targetToApply ||
            Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS
          )
            break;

          // Daily Quota check before each search page
          const quota = await DailyQuotaManager.canApplyToday();
          if (!quota.allowed) {
            this.notifyStatus(
              portToSend,
              `🎉 Daily application quota reached (${quota.currentCount}/${quota.maxQuota} today)! Auto Apply completed.`,
              'ok',
            );
            break locationLoop;
          }

          // Hard credit budget check (minimum 5 credits to ensure balance for form-filling LLM calls)
          const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
          if (balanceRes?.data?.remainingCredits !== undefined && balanceRes.data.remainingCredits < 5) {
            const creditMsg = `🛑 Insufficient credit budget (${balanceRes.data.remainingCredits} remaining, minimum 5 required). Halting run.`;
            this.notifyStatus(portToSend, creditMsg, 'fail');
            break locationLoop;
          }

          const startOffset = searchPageIndex * 25;
          const searchUrl = linkedinAdapter.buildSearchUrl(role, currentLoc, candidateNameSources, startOffset);
          const elapsedMins = Math.floor((Date.now() - sessionStartTime) / 60000);

          this.notifyStatus(
            portToSend,
            `📄 [LinkedIn] [Location #${locRank}: ${currentLoc}] Loading page ${searchPageIndex + 1} (start=${startOffset}) | Progress: ${stats.applied}/${targetToApply} applied (${elapsedMins}m elapsed)...`,
            'info',
          );

          try {
            if (currentPage.puppeteerPage) {
              await currentPage.puppeteerPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
            } else if ((currentPage as any).navigateTo) {
              await (currentPage as any).navigateTo(searchUrl);
            }
          } catch {}

          const sleepAborted = await this.interruptibleSleep(3500);
          if (sleepAborted || !this.isRunning) break locationLoop;

          let jobCards: Array<{ jobId: string; title: string; company: string; url: string }> = [];
          let readAttempts = 0;
          while (readAttempts < 3 && jobCards.length === 0) {
            readAttempts++;
            if (!this.isRunning) break;
            this.notifyStatus(
              portToSend,
              `🔍 Scanning LinkedIn job search results for "${currentLoc}" (page ${searchPageIndex + 1}, attempt ${readAttempts}/3)...`,
              'info',
            );
            jobCards = await currentPage.readJobListFromSearchPane(readAttempts);
            if (jobCards.length === 0 && readAttempts < 3) {
              const retrySleep = await this.interruptibleSleep(2000);
              if (retrySleep || !this.isRunning) break;
            }
          }

          totalLinkedInScanned += jobCards.length;
          stats.totalFound = totalLinkedInScanned;

          const unseenCards = jobCards.filter(card => !seenJobIds.has(card.jobId));
          if (unseenCards.length === 0) {
            logger.info(
              `[DedicatedJobRunner] No new job cards on page ${searchPageIndex + 1} for ${currentLoc}. Advancing...`,
            );
            if (jobCards.length === 0) {
              break pageLoop; // No jobs rendered at all on this page, move to next location
            }
            continue pageLoop;
          }

          for (const job of unseenCards) {
            if (
              !this.isRunning ||
              stats.applied >= targetToApply ||
              Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS
            )
              break locationLoop;

            seenJobIds.add(job.jobId);
            const jobRunId = `${runId}_${job.jobId}`;
            this.activeJobId = job.jobId;

            const proc = await processedJobsStore.isJobProcessed(job.jobId);
            if (proc.isProcessed && proc.status === 'applied') {
              stats.skipped++;
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: job.title,
                company: job.company,
                status: 'skipped',
                reason: 'Already applied previously',
                creditsUsed: 0,
              });
              continue;
            }

            const safeTitle = cleanLinkedInJobTitle(job.title) || 'Loading title...';
            const safeCompany = job.company || 'Unknown Company';

            // 4a-0. Instant 0-Credit Blacklist & Negative Keyword Check on Search Card
            const earlyBlacklist = checkBlacklistAndNegativeKeywords(
              safeTitle,
              safeCompany,
              undefined,
              config.negativeKeywords,
              config.blacklistedCompanies,
              role,
            );
            if (earlyBlacklist.blacklisted) {
              this.notifyStatus(portToSend, `🚫 Skipped "${safeTitle}": ${earlyBlacklist.reason}.`, 'info');
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: safeTitle,
                company: safeCompany,
                status: 'skipped',
                reason: `Blacklisted: ${earlyBlacklist.reason}`,
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: safeTitle,
                company: safeCompany,
                status: 'skipped',
                reason: earlyBlacklist.reason || 'Blacklisted',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            this.notifyStatus(
              portToSend,
              `💼 Checking job: "${safeTitle}" (${safeCompany}) [Progress: ${stats.applied}/${targetToApply} applied]`,
              'info',
            );

            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: safeTitle,
              company: safeCompany,
              status: 'running',
              reason: 'Loading details in split-pane...',
              creditsUsed: 0,
            });

            // 4a. Click Job in Left Pane to Load Details in Right Pane
            const clicked = await currentPage.clickJobInSearchList(job.jobId);
            if (!clicked) {
              logger.warning(
                `[DedicatedJobRunner] Could not click job card for ${job.jobId}. Retrying via direct anchor...`,
              );
            }

            // Wait 2.5s for split pane details to render
            const waitAborted = await this.interruptibleSleep(2500);
            if (waitAborted || !this.isRunning) break locationLoop;

            // 4b. Pure DOM Top-Card Extraction + Max-2 Retry Guard
            let topCard = await currentPage.extractJobTopCardContext(5000);
            let retryCount = 0;
            while (
              (!topCard.title || !topCard.company) &&
              !topCard.isClosed &&
              !topCard.isAlreadyApplied &&
              !topCard.isLoginWall &&
              retryCount < 2
            ) {
              retryCount++;
              this.notifyStatus(
                portToSend,
                `Checking job details for ${job.jobId} (attempt ${retryCount}/2)...`,
                'info',
              );
              const retrySleepAborted = await this.interruptibleSleep(1500);
              if (retrySleepAborted || !this.isRunning) break;
              topCard = await currentPage.extractJobTopCardContext(4000);
            }

            const displayTitle = topCard.title || job.title;
            const displayCompany = topCard.company || job.company;

            // Check if details extraction completely failed
            if (
              (!topCard.title || !topCard.company) &&
              !topCard.isClosed &&
              !topCard.isAlreadyApplied &&
              !topCard.isLoginWall
            ) {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": Could not load job details from LinkedIn.`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Could not load job details from LinkedIn',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Selector timeout',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            // 4b. Pure DOM 0-Credit Skip Checks
            if (topCard.isClosed) {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": This job is closed and no longer accepting applications.`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'No longer accepting applications',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Closed listing',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            if (topCard.isAlreadyApplied) {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": You already applied to this job earlier on LinkedIn.`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'applied',
                reason: 'Already applied on LinkedIn',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Already applied on LinkedIn',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            if (!topCard.hasEasyApply) {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": Requires applying directly on company website (not Easy Apply).`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'External application only (no Easy Apply)',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'External application only',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            // 4b-1. Post-Load Blacklist & Negative Keyword Check (Includes full split-pane description snippet)
            const postBlacklist = checkBlacklistAndNegativeKeywords(
              displayTitle,
              displayCompany,
              topCard.descriptionSnippet,
              config.negativeKeywords,
              config.blacklistedCompanies,
              role,
            );
            if (postBlacklist.blacklisted) {
              this.notifyStatus(portToSend, `🚫 Skipped "${displayTitle}": ${postBlacklist.reason}.`, 'info');
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: `Blacklisted: ${postBlacklist.reason}`,
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: postBlacklist.reason || 'Blacklisted',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            // 4c. Pre-Apply Skill Relevance Check (0 LLM credits)
            const relevance = checkJobSkillRelevance(displayTitle, topCard.descriptionSnippet, careerBrain, role);
            if (!relevance.relevant) {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": Required skills do not closely match your profile.`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Skills do not closely match profile',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: 'Low skill match',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            if (relevance.matchedSkills.length > 0) {
              logger.info(
                `[DedicatedJobRunner] Job "${displayTitle}" matched skills: ${relevance.matchedSkills.slice(0, 5).join(', ')}`,
              );
            }

            // Tier-2 Deep JD Relevance & Match Score Threshold Check (with Experience Gap Detection)
            const minScoreThreshold = config.minFitScore || 70;
            const maxExpGap = config.maxExperienceGapYears ?? 3;
            const deepMatch = evaluateDeepRelevance(
              topCard.descriptionSnippet || '',
              careerBrain,
              role,
              minScoreThreshold,
              maxExpGap,
              displayTitle,
            );

            if (deepMatch.recommendation === 'skip') {
              this.notifyStatus(
                portToSend,
                `ℹ️ Skipped "${displayTitle}": ${deepMatch.reason || 'Match score below threshold'} (${deepMatch.score}% < ${minScoreThreshold}%).`,
                'info',
              );
              stats.skipped++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: deepMatch.reason || `Fit score ${deepMatch.score}% below threshold`,
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'skipped',
                reason: deepMatch.reason || 'Low fit score',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            // Click Easy Apply button
            const clickRes = await currentPage.clickEasyApplyButton();
            if (!clickRes.success) {
              this.notifyStatus(portToSend, `⚠️ Could not click Easy Apply for "${displayTitle}".`, 'fail');
              stats.failed++;
              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'failed',
                reason: clickRes.error || 'Could not click Easy Apply button',
                creditsUsed: 0,
              });
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'modal_failed',
                reason: clickRes.error || 'Button click failed',
                creditsUsed: 0,
              });
              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
              continue;
            }

            let modalRes = await currentPage.waitForEasyApplyModal(6000, 300);
            if (!modalRes.opened) {
              logger.warning(`[DedicatedJobRunner] Modal did not open on first attempt. Retrying click...`);
              const modalSleepAborted = await this.interruptibleSleep(1000);
              if (modalSleepAborted || !this.isRunning) break locationLoop;
              await currentPage.clickEasyApplyButton();
              modalRes = await currentPage.waitForEasyApplyModal(5000, 300);
            }

            // 4d. Handle Modal Form-Filling & Verified Submission
            if (modalRes.opened) {
              stats.modalOpened++;
              this.notifyStatus(portToSend, `📝 Application form opened: Filling your details...`, 'info');
              const fillRes = await this.fillAndSubmitModal(
                currentPage,
                { ...job, title: displayTitle, company: displayCompany },
                jobRunId,
                portToSend,
                onLiveActivity,
              );

              if (fillRes.success) {
                stats.applied++;
                await DailyQuotaManager.incrementAppliedCount();
                await queueSafetyStore.setSingleApplyVerified(true);
                const successMsg = `Applied to "${displayTitle}" at ${displayCompany || 'company'} successfully! 🎉 [Daily Progress: ${stats.applied}/${targetToApply}]`;
                this.notifyStatus(portToSend, `✅ ${successMsg}`, 'ok');

                await processedJobsStore.recordJob({
                  jobId: job.jobId,
                  url: job.url,
                  title: displayTitle,
                  company: displayCompany,
                  location: topCard.location,
                  platform: 'linkedin',
                  fitScore: deepMatch.score,
                  status: 'applied',
                  reason: 'Application submitted and verified',
                  creditsUsed: 0,
                });

                await this.syncJobApplicationToBackend({
                  jobId: job.jobId,
                  jobTitle: displayTitle,
                  company: displayCompany,
                  location: topCard.location,
                  platform: 'linkedin',
                  applicationUrl: job.url,
                  fitScore: deepMatch?.score,
                  status: 'applied',
                  appliedAt: new Date().toISOString(),
                });

                this.notifyActivity(portToSend, onLiveActivity, {
                  jobId: job.jobId,
                  url: job.url,
                  title: displayTitle,
                  company: displayCompany,
                  status: 'applied',
                  reason: 'Application submitted and verified',
                  creditsUsed: 0,
                });

                if (stats.applied >= targetToApply) {
                  this.notifyStatus(
                    portToSend,
                    `🎉 Daily Application Limit reached (${stats.applied}/${targetToApply})!`,
                    'ok',
                  );
                  break locationLoop;
                }

                // Human pacing delay between submitted applications (60 to 90 seconds)
                const pacingMs = 60_000 + Math.floor(Math.random() * 30_000);
                const pacingSec = Math.round(pacingMs / 1000);
                const currentElapsedMins = Math.floor((Date.now() - sessionStartTime) / 60000);
                this.notifyStatus(
                  portToSend,
                  `⏱️ [Session: ${currentElapsedMins}m / max 60m | Daily Quota: ${stats.applied}/${targetToApply} applied] Human pacing delay: resting ${pacingSec}s before next application to protect your account...`,
                  'info',
                );
                const pacingAborted = await this.interruptibleSleep(pacingMs);
                if (pacingAborted || !this.isRunning) break locationLoop;
              } else {
                stats.skipped++;
                const skipReason = fillRes.reason || 'Form filling could not be completed';
                const friendlySkip = formatFriendlySkipReason(skipReason);
                this.notifyStatus(portToSend, `ℹ️ Skipped "${displayTitle}": ${friendlySkip}`, 'info');

                await backendApiClient.refundCredits(jobRunId).catch(err => {
                  const errMsg = String(err?.message || err);
                  if (/no billable usage|run_not_found|already_refunded/i.test(errMsg)) {
                    logger.debug(`[DedicatedJobRunner] No billable usage to refund for ${jobRunId}.`);
                  } else {
                    logger.info(`[DedicatedJobRunner] Refund note for ${jobRunId}: ${errMsg}`);
                  }
                });

                await currentPage.dismissEasyApplyModal(5000).catch(() => {});

                await processedJobsStore.recordJob({
                  jobId: job.jobId,
                  url: job.url,
                  title: displayTitle,
                  company: displayCompany,
                  location: topCard.location,
                  platform: 'linkedin',
                  fitScore: deepMatch.score,
                  status: 'skipped',
                  reason: skipReason,
                  creditsUsed: 0,
                });

                this.notifyActivity(portToSend, onLiveActivity, {
                  jobId: job.jobId,
                  url: job.url,
                  title: displayTitle,
                  company: displayCompany,
                  status: 'skipped',
                  reason: skipReason,
                  creditsUsed: 0,
                });

                const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
                if (skipWait || !this.isRunning) break locationLoop;
              }
            } else {
              stats.failed++;
              const failReason = modalRes.error || clickRes.error || 'Easy Apply modal failed to open within timeout';
              this.notifyStatus(portToSend, `⚠️ Could not open Easy Apply for "${displayTitle}".`, 'fail');

              await backendApiClient.refundCredits(jobRunId).catch(() => {});
              await currentPage.dismissEasyApplyModal(3000).catch(() => {});

              await processedJobsStore.recordJob({
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                location: topCard.location,
                platform: 'linkedin',
                fitScore: deepMatch.score,
                status: 'failed',
                reason: failReason,
                creditsUsed: 0,
              });

              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: displayTitle,
                company: displayCompany,
                status: 'modal_failed',
                reason: failReason,
                creditsUsed: 0,
              });

              const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
              if (skipWait || !this.isRunning) break locationLoop;
            }
          }
        }
      }

      // 6. Final Summary
      const sessionDurationMins = Math.round((Date.now() - sessionStartTime) / 60000);
      let summaryMsg = '';
      if (stats.applied >= targetToApply) {
        summaryMsg = `🎉 Daily Application Limit achieved! Applied to ${stats.applied}/${targetToApply} jobs in ${sessionDurationMins} minutes (${stats.skipped} skipped).`;
      } else if (Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS) {
        summaryMsg = `⏱️ Maximum session duration of 60 minutes reached. Applied to ${stats.applied}/${targetToApply} jobs (${stats.skipped} skipped). Safe pacing completed.`;
      } else if (!this.isRunning) {
        summaryMsg = `🛑 Auto Apply stopped by user. Applied to ${stats.applied} jobs (${stats.skipped} skipped) in ${sessionDurationMins} minutes.`;
      } else {
        summaryMsg = `🏁 Auto Apply finished! Submitted ${stats.applied}/${targetToApply} applications (${stats.skipped} skipped) in ${sessionDurationMins} minutes.`;
      }
      this.notifyStatus(portToSend, summaryMsg, 'ok');

      if (portToSend) {
        try {
          portToSend.postMessage({
            type: 'LINKEDIN_RUN_FINISHED',
            summary: summaryMsg,
            stats,
          });
        } catch {}
      }

      this.cleanupRun();
      return { status: 'success', message: summaryMsg, stats };
    } catch (err: any) {
      if (!this.isRunning) {
        logger.info('[DedicatedJobRunner] Autonomous loop exited cleanly after stop or window close.');
        this.cleanupRun();
        return { status: 'stopped', message: 'Application stopped by user', stats };
      }
      const errMsg = String(err?.message || err);
      logger.error(`[DedicatedJobRunner] Unhandled error in startAutonomousJobLoop:`, err);
      this.notifyStatus(portToSend, `🛑 Auto Apply encountered an error: ${errMsg}`, 'fail');

      if (portToSend) {
        try {
          portToSend.postMessage({
            type: 'LINKEDIN_RUN_FINISHED',
            summary: `Run ended with error: ${errMsg}`,
            stats,
          });
        } catch {}
      }

      this.cleanupRun();
      return { status: 'error', message: errMsg, stats };
    }
  }

  /**
   * Autonomous application loop for Naukri.com
   */
  private async startNaukriJobLoop(
    options: AutonomousLoopOptions,
    careerBrain: ICareerBrain,
    role: string,
    location: string | string[],
    runId: string,
    stats: { totalFound: number; applied: number; modalOpened: number; skipped: number; failed: number },
  ): Promise<{
    status: 'success' | 'stopped' | 'error';
    message: string;
    stats: typeof stats;
  }> {
    const { portToSend, onLiveActivity } = options;
    const initialQuota = await DailyQuotaManager.canApplyToday();
    if (!initialQuota.allowed) {
      const quotaMsg = `🛑 Daily application quota already reached (${initialQuota.currentCount}/${initialQuota.maxQuota} today). Auto Apply is complete for today.`;
      this.notifyStatus(portToSend, quotaMsg, 'fail');
      this.cleanupRun();
      return { status: 'stopped', message: quotaMsg, stats };
    }

    const targetToApply = options.maxJobs ? Math.min(options.maxJobs, initialQuota.remaining) : initialQuota.remaining;
    const sessionStartTime = Date.now();
    const MAX_SESSION_DURATION_MS = 60 * 60 * 1000;

    const targetLocations: string[] = (Array.isArray(location) ? location : [location])
      .map(l => (l || '').trim())
      .filter(Boolean);
    const primaryLocation = targetLocations[0] || 'All India';

    const candidateNameSources = [careerBrain.fullName].filter(Boolean);
    const cleanRole = sanitizeRoleSearchQuery(role, candidateNameSources, 'Software Engineer');
    const searchUrl = naukriAdapter.buildSearchUrl(cleanRole, primaryLocation, candidateNameSources);
    this.notifyStatus(
      portToSend,
      `🎯 [Naukri.com] Search Criteria: Role="${cleanRole}" | Location(s)="${targetLocations.join(', ') || 'All India'}"`,
      'info',
    );

    const runnerMode: RunnerMode = options.runnerMode || 'tab';
    if (runnerMode === 'tab') {
      this.notifyStatus(portToSend, `🌐 Opening dedicated runner tab in current window for Naukri...`, 'info');
    } else {
      this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for Naukri...`, 'info');
    }

    let runnerTarget: { windowId: number; tabId: number; mode?: RunnerMode };
    try {
      runnerTarget = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl, {
        mode: runnerMode,
        allowedDomains: [/naukri\.com/i, /^about:blank$/i],
      });
    } catch (err: any) {
      const openErrMsg = `🛑 Failed to open runner ${runnerMode}: ${err?.message || 'Unknown error'}. Please check browser permissions and try again.`;
      logger.error('[DedicatedJobRunner]', openErrMsg);
      this.notifyStatus(portToSend, openErrMsg, 'fail');
      this.cleanupRun();
      return { status: 'stopped', message: openErrMsg, stats };
    }

    const { windowId, tabId } = runnerTarget;
    this.browserContext!.updateCurrentTabId(tabId);

    // 1. Close listener (handles user closing the tab or window mid-run)
    this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async reason => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(
          `Dedicated runner target closed while Naukri auto loop ${runId} was active (reason: ${reason}).`,
        );
        const closeMsg =
          reason === 'tab_closed' || runnerMode === 'tab'
            ? '🛑 Runner tab was closed — application stopped.'
            : '🛑 Runner window was closed — application stopped.';
        this.notifyStatus(portToSend, closeMsg, 'fail');
        this.stop();
      }
    });

    // 2. Navigation boundary listener (handles user manually typing a different URL mid-run)
    this.unregisterNavAwayListener = dedicatedWindowManager.onNavigatedAway(async (newUrl: string) => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(`Runner tab navigated away to ${newUrl} while Naukri auto loop ${runId} was active.`);
        this.notifyStatus(
          portToSend,
          `🛑 Runner tab navigated away from Naukri (${newUrl}) — application stopped cleanly.`,
          'fail',
        );
        this.stop();
      }
    });

    // Wait 4s for navigation
    const navAborted = await this.interruptibleSleep(4000);
    if (navAborted || !this.isRunning) {
      this.cleanupRun();
      return { status: 'stopped', message: 'Stopped by user', stats };
    }

    const currentPage = await this.browserContext!.getCurrentPage();
    await this.markRunnerTabVisually(currentPage);

    // Session / Login check
    let session = await naukriAdapter.validateSession(currentPage);
    if (session.isLoginWall) {
      this.notifyStatus(
        portToSend,
        '⚠️ Naukri login required. Please log in to Naukri in the runner window. (Pausing without spending credits...)',
        'info',
      );

      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: 'naukri_login',
        url: searchUrl,
        title: 'Waiting for login',
        company: 'Naukri.com',
        status: 'running',
        reason: 'Please log in to Naukri in the runner window',
        creditsUsed: 0,
      });

      const loginStart = Date.now();
      let loggedIn = false;
      while (Date.now() - loginStart < 300_000) {
        const waitAborted = await this.interruptibleSleep(3000);
        if (waitAborted || !this.isRunning) break;

        session = await naukriAdapter.validateSession(currentPage);
        if (!session.isLoginWall && session.isLoggedIn) {
          loggedIn = true;
          this.notifyStatus(portToSend, '✅ Naukri login detected! Resuming autonomous search...', 'ok');
          break;
        }
      }

      if (!loggedIn && !session.isLoggedIn) {
        const timeoutMsg = 'Login timeout (5 minutes reached). Please log in to Naukri and retry.';
        this.notifyStatus(portToSend, `🛑 ${timeoutMsg}`, 'fail');
        this.cleanupRun();
        return { status: 'error', message: timeoutMsg, stats };
      }
    }

    // Continuous pagination and application across locations and search pages
    const seenJobIds = new Set<string>();
    const maxPagesPerLocation = 10;
    const config = await linkedInConfigStore.getConfig();

    this.notifyStatus(
      portToSend,
      `🚀 Starting continuous Naukri Auto Apply session! Goal: Complete daily application limit (${stats.applied + targetToApply} total, need ${targetToApply} today). Safe pacing across 30–60 minutes.`,
      'ok',
    );

    locationLoop: for (let locIdx = 0; locIdx < targetLocations.length; locIdx++) {
      if (!this.isRunning || stats.applied >= targetToApply || Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS)
        break;

      const currentLoc = targetLocations[locIdx];
      const locRank = locIdx + 1;

      pageLoop: for (let pageNo = 1; pageNo <= maxPagesPerLocation; pageNo++) {
        if (
          !this.isRunning ||
          stats.applied >= targetToApply ||
          Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS
        )
          break;

        const quota = await DailyQuotaManager.canApplyToday();
        if (!quota.allowed) {
          this.notifyStatus(
            portToSend,
            `🎉 Daily application quota reached (${quota.currentCount}/${quota.maxQuota} today)! Auto Apply completed.`,
            'ok',
          );
          break locationLoop;
        }

        const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
        if (balanceRes?.data?.remainingCredits !== undefined && balanceRes.data.remainingCredits < 1) {
          this.notifyStatus(
            portToSend,
            `🛑 Insufficient credits (${balanceRes.data.remainingCredits} remaining). Halting run.`,
            'fail',
          );
          break locationLoop;
        }

        const pageSearchUrl = naukriAdapter.buildSearchUrl(cleanRole, currentLoc, candidateNameSources, pageNo);
        const elapsedMins = Math.floor((Date.now() - sessionStartTime) / 60000);
        this.notifyStatus(
          portToSend,
          `📄 [Naukri] [Location #${locRank}: ${currentLoc}] Loading page ${pageNo} | Progress: ${stats.applied}/${targetToApply} applied (${elapsedMins}m elapsed)...`,
          'info',
        );

        try {
          if (currentPage.puppeteerPage) {
            await currentPage.puppeteerPage.goto(pageSearchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
          } else if ((currentPage as any).navigateTo) {
            await (currentPage as any).navigateTo(pageSearchUrl);
          }
        } catch {}

        const navWait = await this.interruptibleSleep(3500);
        if (navWait || !this.isRunning) break locationLoop;

        let jobs: IJobQueueItem[] = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          await currentPage.puppeteerPage?.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
          const scanWait = await this.interruptibleSleep(1500);
          if (scanWait || !this.isRunning) break;
          jobs = await naukriAdapter.extractJobCards(currentPage);
          if (jobs.length > 0) break;
          const retryWait = await this.interruptibleSleep(2000);
          if (retryWait || !this.isRunning) break;
        }

        stats.totalFound += jobs.length;

        const unseenJobs = jobs.filter(j => !seenJobIds.has(j.jobId));
        if (unseenJobs.length === 0) {
          if (jobs.length === 0) break pageLoop;
          continue pageLoop;
        }

        // Sort quick apply first
        const sortedJobs = [...unseenJobs].sort((a, b) => (b.isQuickApply ? 1 : 0) - (a.isQuickApply ? 1 : 0));

        for (const job of sortedJobs) {
          if (
            !this.isRunning ||
            stats.applied >= targetToApply ||
            Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS
          )
            break locationLoop;

          seenJobIds.add(job.jobId);
          const jobRunId = `${runId}_${job.jobId}`;
          this.activeJobId = job.jobId;

          const proc = await processedJobsStore.isJobProcessed(job.jobId);
          if (proc.isProcessed && proc.status === 'applied') {
            stats.skipped++;
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: 'Already applied previously',
              creditsUsed: 0,
            });
            continue;
          }

          // Blacklist & negative keyword check
          const blacklist = checkBlacklistAndNegativeKeywords(
            job.title,
            job.company,
            undefined,
            config.negativeKeywords,
            config.blacklistedCompanies,
            role,
          );
          if (blacklist.blacklisted) {
            this.notifyStatus(portToSend, `🚫 [Naukri] Skipped "${job.title}": ${blacklist.reason}.`, 'info');
            stats.skipped++;
            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: `Blacklisted: ${blacklist.reason}`,
              creditsUsed: 0,
            });
            const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
            if (skipWait || !this.isRunning) break locationLoop;
            continue;
          }

          // Relevance check
          const relevance = checkJobSkillRelevance(job.title, job.descriptionSnippet, careerBrain, role);
          if (!relevance.relevant) {
            this.notifyStatus(
              portToSend,
              `ℹ️ Skipped "${job.title}": Match score ${relevance.score}% < threshold ${relevance.threshold}%. (${relevance.reason || 'Skills do not match profile'})`,
              'info',
            );
            stats.skipped++;
            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: `Match score ${relevance.score}% < ${relevance.threshold}%: ${relevance.reason || 'Skills do not closely match profile'}`,
              creditsUsed: 0,
            });
            const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
            if (skipWait || !this.isRunning) break locationLoop;
            continue;
          }

          this.notifyStatus(
            portToSend,
            `💼 [Naukri.com] Applying to: "${job.title}" (${job.company}) [Progress: ${stats.applied}/${targetToApply} applied]`,
            'info',
          );

          this.notifyActivity(portToSend, onLiveActivity, {
            jobId: job.jobId,
            url: job.url,
            title: job.title,
            company: job.company,
            status: 'running',
            reason: 'Applying on Naukri...',
            creditsUsed: 0,
          });

          // Pre-apply delay (1.5s - 3s)
          const preApplyDelay = 1500 + Math.floor(Math.random() * 1500);
          const preAborted = await this.interruptibleSleep(preApplyDelay);
          if (preAborted || !this.isRunning) break locationLoop;

          const scopedLLM = await getJobScopedLLM(jobRunId);
          const applyResult = await naukriAdapter.applyToJob(job, {
            page: currentPage,
            browserContext: this.browserContext!,
            careerBrain,
            portToSend,
            onLiveActivity,
            signal: this.abortController?.signal,
            runId: jobRunId,
            scopedLLM,
          });

          if (!this.isRunning || this.abortController?.signal?.aborted) break locationLoop;

          if (applyResult.status === 'applied') {
            stats.applied++;
            await DailyQuotaManager.incrementAppliedCount();
            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'applied',
              creditsUsed: 1,
            });

            await this.syncJobApplicationToBackend({
              jobId: job.jobId,
              jobTitle: job.title,
              company: job.company,
              platform: 'naukri',
              applicationUrl: job.url,
              status: 'applied',
              appliedAt: new Date().toISOString(),
            });

            this.notifyStatus(
              portToSend,
              `✅ Successfully applied to "${job.title}" at ${job.company}! [Daily Progress: ${stats.applied}/${targetToApply}]`,
              'ok',
            );

            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'applied',
              creditsUsed: 1,
            });

            if (stats.applied >= targetToApply) {
              this.notifyStatus(
                portToSend,
                `🎉 Daily Application Limit reached (${stats.applied}/${targetToApply})!`,
                'ok',
              );
              break locationLoop;
            }

            // Human pacing delay: 60 to 90 seconds
            const pacingMs = 60_000 + Math.floor(Math.random() * 30_000);
            const pacingSec = Math.round(pacingMs / 1000);
            const currentElapsedMins = Math.floor((Date.now() - sessionStartTime) / 60000);
            this.notifyStatus(
              portToSend,
              `⏱️ [Session: ${currentElapsedMins}m / max 60m | Daily Quota: ${stats.applied}/${targetToApply} applied] Human pacing delay: resting ${pacingSec}s before next application to protect your account...`,
              'info',
            );
            const pacingAborted = await this.interruptibleSleep(pacingMs);
            if (pacingAborted || !this.isRunning) break locationLoop;
          } else if (applyResult.status === 'skipped') {
            stats.skipped++;
            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: applyResult.reason || 'Skipped',
              creditsUsed: 0,
            });
            this.notifyStatus(portToSend, `ℹ️ Skipped "${job.title}": ${applyResult.reason || 'Skipped'}`, 'info');
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: applyResult.reason,
              creditsUsed: 0,
            });
            const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
            if (skipWait || !this.isRunning) break locationLoop;
          } else {
            stats.failed++;
            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'failed',
              reason: applyResult.reason || 'Failed',
              creditsUsed: 0,
            });
            this.notifyStatus(
              portToSend,
              `❌ Failed application for "${job.title}": ${applyResult.reason || 'Failed'}`,
              'fail',
            );
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'failed',
              reason: applyResult.reason,
              creditsUsed: 0,
            });
            const skipWait = await this.interruptibleSleep(4000 + Math.floor(Math.random() * 2000));
            if (skipWait || !this.isRunning) break locationLoop;
          }
        }
      }
    }
    const sessionDurationMins = Math.round((Date.now() - sessionStartTime) / 60000);
    let summaryMsg = '';
    if (stats.applied >= targetToApply) {
      summaryMsg = `🎉 Daily Application Limit achieved! Applied to ${stats.applied}/${targetToApply} jobs on Naukri in ${sessionDurationMins} minutes (${stats.skipped} skipped).`;
    } else if (Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS) {
      summaryMsg = `⏱️ Maximum session duration of 60 minutes reached. Applied to ${stats.applied}/${targetToApply} jobs on Naukri (${stats.skipped} skipped).`;
    } else if (!this.isRunning) {
      summaryMsg = `🛑 Auto Apply stopped by user. Applied to ${stats.applied} jobs on Naukri in ${sessionDurationMins} minutes.`;
    } else {
      summaryMsg = `🏁 Naukri Apply finished! Submitted ${stats.applied}/${targetToApply} applications (${stats.skipped} skipped) in ${sessionDurationMins} minutes.`;
    }
    this.notifyStatus(portToSend, `🏁 ${summaryMsg}`, 'ok');

    if (portToSend) {
      try {
        portToSend.postMessage({
          type: 'LINKEDIN_RUN_FINISHED',
          summary: summaryMsg,
          stats,
        });
      } catch {}
    }

    this.cleanupRun();
    return { status: 'success', message: summaryMsg, stats };
  }

  /**
   * Autonomous application loop for Indeed.com
   */
  private async startIndeedJobLoop(
    options: AutonomousLoopOptions,
    careerBrain: ICareerBrain,
    role: string,
    locationInput: string | string[],
    runId: string,
    stats: { totalFound: number; applied: number; modalOpened: number; skipped: number; failed: number },
  ): Promise<{
    status: 'success' | 'stopped' | 'error';
    message: string;
    stats: typeof stats;
  }> {
    const { portToSend, onLiveActivity } = options;
    const initialQuota = await DailyQuotaManager.canApplyToday();
    if (!initialQuota.allowed) {
      const quotaMsg = `🛑 Daily application quota already reached (${initialQuota.currentCount}/${initialQuota.maxQuota} today). Auto Apply is complete for today.`;
      this.notifyStatus(portToSend, quotaMsg, 'fail');
      this.cleanupRun();
      return { status: 'stopped', message: quotaMsg, stats };
    }

    const targetToApply = options.maxJobs ? Math.min(options.maxJobs, initialQuota.remaining) : initialQuota.remaining;
    const BATCH_CAP = targetToApply;
    const sessionStartTime = Date.now();
    const MAX_SESSION_DURATION_MS = 60 * 60 * 1000;

    // 0. Safety Pause Check: Check if Indeed is already paused for the day
    const pauseCheck = await queueSafetyStore.getPlatformPause('indeed');
    if (pauseCheck.isPaused) {
      const pausedNotice = `🛑 Indeed auto-apply is paused for today (${pauseCheck.reason || 'Verification challenge detected'}). Auto-apply will resume tomorrow.`;
      this.notifyStatus(portToSend, pausedNotice, 'fail');
      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: 'indeed_daily_pause',
        url: '',
        title: 'Indeed Paused Today',
        company: 'Indeed',
        status: 'skipped',
        reason: pausedNotice,
        creditsUsed: 0,
      });
      return { status: 'stopped', message: pausedNotice, stats };
    }

    // Resolve prioritized target locations (e.g. [#1 Bengaluru, #2 Hyderabad, #3 Pune])
    const targetLocations: string[] = (Array.isArray(locationInput) ? locationInput : [locationInput])
      .map(l => (l || '').trim())
      .filter(Boolean);

    if (targetLocations.length === 0) {
      targetLocations.push('Remote');
    }

    const candidateNameSources = [careerBrain.fullName].filter(Boolean);
    const cleanRole = sanitizeRoleSearchQuery(role, candidateNameSources, 'Software Engineer');
    const primaryLocation = targetLocations[0];
    const searchUrl = indeedAdapter.buildSearchUrl(cleanRole, primaryLocation, undefined, candidateNameSources);
    const locationsDisplay = targetLocations.map((loc, idx) => `#${idx + 1} ${loc}`).join(', ');
    this.notifyStatus(
      portToSend,
      `🎯 [Indeed] Search Criteria: Role="${cleanRole}" | Location(s): ${locationsDisplay}`,
      'info',
    );

    const runnerMode: RunnerMode = options.runnerMode || 'tab';
    if (runnerMode === 'tab') {
      this.notifyStatus(portToSend, `🌐 Opening dedicated runner tab in current window for Indeed...`, 'info');
    } else {
      this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for Indeed...`, 'info');
    }

    let runnerTarget: { windowId: number; tabId: number; mode?: RunnerMode };
    try {
      runnerTarget = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl, {
        mode: runnerMode,
        allowedDomains: [/indeed\.com/i, /^about:blank$/i],
      });
    } catch (err: any) {
      const openErrMsg = `🛑 Failed to open runner ${runnerMode}: ${err?.message || 'Unknown error'}. Please check browser permissions and try again.`;
      logger.error('[DedicatedJobRunner]', openErrMsg);
      this.notifyStatus(portToSend, openErrMsg, 'fail');
      this.cleanupRun();
      return { status: 'stopped', message: openErrMsg, stats };
    }

    const { windowId, tabId } = runnerTarget;
    this.browserContext!.updateCurrentTabId(tabId);

    // 1. Close listener (handles user closing the tab or window mid-run)
    this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async reason => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(
          `Dedicated runner target closed while Indeed auto loop ${runId} was active (reason: ${reason}).`,
        );
        const closeMsg =
          reason === 'tab_closed' || runnerMode === 'tab'
            ? '🛑 Runner tab was closed — application stopped.'
            : '🛑 Runner window was closed — application stopped.';
        this.notifyStatus(portToSend, closeMsg, 'fail');
        this.stop();
      }
    });

    // 2. Navigation boundary listener (handles user manually typing a different URL mid-run)
    this.unregisterNavAwayListener = dedicatedWindowManager.onNavigatedAway(async (newUrl: string) => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(`Runner tab navigated away to ${newUrl} while Indeed auto loop ${runId} was active.`);
        this.notifyStatus(
          portToSend,
          `🛑 Runner tab navigated away from Indeed (${newUrl}) — application stopped cleanly.`,
          'fail',
        );
        this.stop();
      }
    });

    // Helper: Zero-interaction CAPTCHA handler that immediately pauses for the day and closes window
    const handleIndeedCaptchaDetected = async (jobTitle?: string) => {
      const captchaMsg =
        "Indeed requested additional verification — pausing Indeed auto-apply for today to protect your account. You can solve it manually by opening Indeed directly if you'd like to continue browsing there.";
      logger.warning(
        `[DedicatedJobRunner] Indeed CAPTCHA detected (${jobTitle || 'search'}). Pausing Indeed for the rest of today.`,
      );

      // 1. Update quota/safety state so Indeed auto-apply won't retry until the next scheduled day
      await queueSafetyStore.pausePlatformForToday('indeed', 'Indeed requested additional verification');

      // 2. Log clear user-facing message in Live Activity feed
      this.notifyStatus(portToSend, `🛑 ${captchaMsg}`, 'fail');
      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: this.activeJobId || 'indeed_captcha_pause',
        url: searchUrl,
        title: jobTitle || 'Indeed Verification Check',
        company: 'Indeed',
        status: 'failed',
        reason: captchaMsg,
        creditsUsed: 0,
      });

      // 3. Clean up run state, notify listeners, and close the dedicated runner window cleanly
      this.isRunning = false;
      this.notifyStopListeners();
      if (portToSend) {
        try {
          portToSend.postMessage({
            type: 'LINKEDIN_RUN_FINISHED',
            summary: captchaMsg,
            stats,
          });
        } catch {}
      }
      await dedicatedWindowManager.closeRunnerWindow().catch(() => {});
      this.cleanupRun();
      return { status: 'stopped' as const, message: captchaMsg, stats };
    };

    // Wait randomized 4.5s - 7.5s for initial navigation to settle
    const initialWaitMs = 4500 + Math.floor(Math.random() * 3000);
    const navAborted = await this.interruptibleSleep(initialWaitMs);
    if (navAborted || !this.isRunning) {
      this.cleanupRun();
      return { status: 'stopped', message: 'Stopped by user', stats };
    }

    const currentPage = await this.browserContext!.getCurrentPage();
    await this.markRunnerTabVisually(currentPage);

    const checkAndHandleSearchCaptcha = async (title: string = 'Indeed Search') => {
      if (
        currentPage.puppeteerPage &&
        (await indeedAdapter.checkCaptchaPresent(currentPage.puppeteerPage, currentPage.tabId))
      ) {
        const waitResult = await indeedAdapter.waitForManualCaptchaResolution(
          currentPage.tabId,
          currentPage.puppeteerPage,
          {
            signal: this.abortController?.signal,
            onLiveActivity,
            portToSend,
            runId,
            page: currentPage,
            browserContext: this.browserContext!,
            careerBrain,
          },
          title,
        );
        if (waitResult.aborted || !this.isRunning) {
          this.cleanupRun();
          return { status: 'stopped' as const, message: 'Stopped by user', stats };
        }
        if (!waitResult.solved) {
          return await handleIndeedCaptchaDetected(title);
        }
        this.notifyStatus(portToSend, '✅ Verification solved — resuming search...', 'ok');
      }
      return null;
    };

    // Check for CAPTCHA immediately after search navigation (zero interaction)
    const initialCaptchaExit = await checkAndHandleSearchCaptcha('Indeed Search');
    if (initialCaptchaExit) return initialCaptchaExit;

    // Session check
    let session = await indeedAdapter.validateSession(currentPage);
    if (session.isLoginWall) {
      this.notifyStatus(
        portToSend,
        '⚠️ Indeed login required. Please log in to Indeed in the runner window. (Pausing without spending credits...)',
        'info',
      );

      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: 'indeed_login',
        url: searchUrl,
        title: 'Waiting for login',
        company: 'Indeed',
        status: 'running',
        reason: 'Please log in to Indeed in the runner window',
        creditsUsed: 0,
      });

      const loginStart = Date.now();
      let loggedIn = false;
      while (Date.now() - loginStart < 300_000) {
        const waitAborted = await this.interruptibleSleep(3000);
        if (waitAborted || !this.isRunning) break;

        session = await indeedAdapter.validateSession(currentPage);
        if (!session.isLoginWall && session.isLoggedIn) {
          loggedIn = true;
          this.notifyStatus(portToSend, '✅ Indeed login detected! Resuming autonomous search...', 'ok');
          break;
        }
      }

      if (!loggedIn && !session.isLoggedIn) {
        const timeoutMsg = 'Login timeout (5 minutes reached). Please log in to Indeed and retry.';
        this.notifyStatus(portToSend, `🛑 ${timeoutMsg}`, 'fail');
        this.cleanupRun();
        return { status: 'error', message: timeoutMsg, stats };
      }
    }

    // Helper to safely navigate the runner tab
    const navigateTab = async (url: string) => {
      try {
        if (typeof currentPage.puppeteerPage?.goto === 'function') {
          await currentPage.puppeteerPage
            .goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 })
            .catch(async () => {
              if ((currentPage as any).navigateTo) await (currentPage as any).navigateTo(url).catch(() => {});
            });
        } else if ((currentPage as any).navigateTo) {
          await (currentPage as any).navigateTo(url).catch(() => {});
        } else if (typeof chrome !== 'undefined' && chrome.tabs && currentPage.tabId) {
          await chrome.tabs.update(currentPage.tabId, { url });
        }
      } catch (err) {
        logger.warning('[DedicatedJobRunner] Navigation error:', err);
      }
    };

    // Scan jobs across prioritized locations in strict priority order until BATCH_CAP is met
    const queue: IJobQueueItem[] = [];
    const seenJobIds = new Set<string>();
    const maxSearchPagesPerLocation = 4;
    let totalScanned = 0;

    for (let locIdx = 0; locIdx < targetLocations.length; locIdx++) {
      if (queue.length >= BATCH_CAP || !this.isRunning || this.abortController?.signal?.aborted) {
        break;
      }

      const currentLoc = targetLocations[locIdx];
      const locRank = locIdx + 1;

      this.notifyStatus(
        portToSend,
        `📍 [Indeed] Searching Location #${locRank} (${currentLoc}) for "${cleanRole}" (${queue.length}/${BATCH_CAP} Quick Apply jobs gathered so far)...`,
        'info',
      );

      // If switching to Location #2, Location #3, etc., navigate runner tab to that location's search URL
      if (locIdx > 0) {
        const nextLocUrl = indeedAdapter.buildSearchUrl(cleanRole, currentLoc, 0, candidateNameSources);
        await navigateTab(nextLocUrl);
        const locWaitAborted = await this.interruptibleSleep(3500 + Math.floor(Math.random() * 2000));
        if (locWaitAborted || !this.isRunning) break;
        await this.markRunnerTabVisually(currentPage);

        const locCaptchaExit = await checkAndHandleSearchCaptcha(`Indeed Search (Location #${locRank}: ${currentLoc})`);
        if (locCaptchaExit) return locCaptchaExit;
      }

      for (let searchPageIndex = 0; searchPageIndex < maxSearchPagesPerLocation; searchPageIndex++) {
        if (queue.length >= BATCH_CAP || !this.isRunning || this.abortController?.signal?.aborted) break;

        if (searchPageIndex > 0) {
          const nextPageUrl = indeedAdapter.buildSearchUrl(
            cleanRole,
            currentLoc,
            searchPageIndex * 10,
            candidateNameSources,
          );
          this.notifyStatus(
            portToSend,
            `📄 [Indeed] [${currentLoc}] Loading search page ${searchPageIndex + 1} (${queue.length}/${BATCH_CAP} Quick Apply jobs gathered so far)...`,
            'info',
          );
          await navigateTab(nextPageUrl);
          const pageWaitAborted = await this.interruptibleSleep(3500 + Math.floor(Math.random() * 2000));
          if (pageWaitAborted || !this.isRunning) break;
          await this.markRunnerTabVisually(currentPage);
        }

        let pageJobs: IJobQueueItem[] = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
          // Check if Cloudflare appeared (zero programmatic interaction)
          const attemptCaptchaExit = await checkAndHandleSearchCaptcha(
            `Indeed Search (${currentLoc} - Page ${searchPageIndex + 1})`,
          );
          if (attemptCaptchaExit) return attemptCaptchaExit;

          this.notifyStatus(
            portToSend,
            `🔍 [Indeed] [${currentLoc}] Scanning search results page ${searchPageIndex + 1} for "${cleanRole}" (attempt ${attempt}/3)...`,
            'info',
          );
          await currentPage.puppeteerPage
            ?.evaluate(() => window.scrollBy(0, 350 + Math.floor(Math.random() * 300)))
            .catch(() => {});
          const scanWait = await this.interruptibleSleep(2000 + Math.floor(Math.random() * 2000));
          if (scanWait || !this.isRunning) break;

          // Re-check before extraction
          const preExtractCaptchaExit = await checkAndHandleSearchCaptcha(
            `Indeed Search (${currentLoc} - Page ${searchPageIndex + 1})`,
          );
          if (preExtractCaptchaExit) return preExtractCaptchaExit;

          pageJobs = await indeedAdapter.extractJobCards(currentPage);
          if (pageJobs.length > 0) break;
          const retryWait = await this.interruptibleSleep(2500 + Math.floor(Math.random() * 1500));
          if (retryWait || !this.isRunning) break;
        }

        totalScanned += pageJobs.length;

        // Filter and collect Quick Apply jobs from this page
        const pageQuickApply = pageJobs.filter(j => j.isQuickApply === true && !(j as any).isExternal);
        for (const job of pageQuickApply) {
          if (seenJobIds.has(job.jobId)) continue;
          seenJobIds.add(job.jobId);

          const proc = await processedJobsStore.isJobProcessed(job.jobId);
          if (proc.isProcessed && proc.status === 'applied') {
            stats.skipped++;
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: 'Already applied previously',
              creditsUsed: 0,
            });
            continue;
          }

          queue.push(job);
          if (queue.length >= BATCH_CAP) break;
        }

        if (queue.length >= BATCH_CAP) break;
        if (pageJobs.length === 0) {
          logger.info(
            `[DedicatedJobRunner] No further job listings found for ${currentLoc} on page ${searchPageIndex + 1}.`,
          );
          break;
        }
      }

      if (queue.length >= BATCH_CAP) {
        logger.info(
          `[DedicatedJobRunner] BATCH_CAP (${BATCH_CAP}) reached in Location #${locRank} (${currentLoc}). Stopping location search.`,
        );
        this.notifyStatus(
          portToSend,
          `🎯 [Indeed] Batch cap of ${BATCH_CAP} jobs reached with Location #${locRank} (${currentLoc}). Proceeding to applications...`,
          'ok',
        );
        break;
      }

      if (locIdx < targetLocations.length - 1) {
        const nextLoc = targetLocations[locIdx + 1];
        const nextRank = locIdx + 2;
        this.notifyStatus(
          portToSend,
          `📍 [Indeed] Location #${locRank} (${currentLoc}) yielded ${queue.length} jobs (< ${BATCH_CAP}). Checking Location #${nextRank} (${nextLoc})...`,
          'info',
        );
      }
    }

    stats.totalFound = totalScanned;

    // Fallback search trigger: If fewer than 3 genuine Quick Apply jobs were found,
    // trigger ONE additional fallback search using the secondary role term.
    const rawAlternateRole =
      lastResolvedAlternateRole ||
      (careerBrain.predefinedRoles && careerBrain.predefinedRoles[1]) ||
      (cleanRole.toLowerCase().includes('software') ? 'Full Stack Developer' : 'Software Engineer');
    const cleanAlternateRole = sanitizeRoleSearchQuery(rawAlternateRole, candidateNameSources, 'Software Engineer');

    if (
      queue.length < 3 &&
      this.isRunning &&
      !this.abortController?.signal?.aborted &&
      cleanAlternateRole &&
      cleanAlternateRole.toLowerCase() !== cleanRole.toLowerCase()
    ) {
      const fallbackMsg = `Found only ${queue.length} jobs for '${cleanRole}', also checking '${cleanAlternateRole}'...`;
      logger.info(`[DedicatedJobRunner] ${fallbackMsg}`);
      this.notifyStatus(portToSend, `🔍 ${fallbackMsg}`, 'info');

      const fallbackSearchUrl = indeedAdapter.buildSearchUrl(
        cleanAlternateRole,
        primaryLocation,
        0,
        candidateNameSources,
      );
      await navigateTab(fallbackSearchUrl);
      const fbWaitAborted = await this.interruptibleSleep(3500 + Math.floor(Math.random() * 2000));
      if (!fbWaitAborted && this.isRunning) {
        await this.markRunnerTabVisually(currentPage);

        // Scan up to 2 pages for fallback role to reach BATCH_CAP
        for (let fbPageIndex = 0; fbPageIndex < 2 && queue.length < BATCH_CAP; fbPageIndex++) {
          if (!this.isRunning || this.abortController?.signal?.aborted) break;

          if (fbPageIndex > 0) {
            const nextFbUrl = indeedAdapter.buildSearchUrl(
              cleanAlternateRole,
              primaryLocation,
              fbPageIndex * 10,
              candidateNameSources,
            );
            await navigateTab(nextFbUrl);
            const pWait = await this.interruptibleSleep(3500 + Math.floor(Math.random() * 1500));
            if (pWait || !this.isRunning) break;
            await this.markRunnerTabVisually(currentPage);
          }

          let fbJobs: IJobQueueItem[] = [];
          for (let attempt = 1; attempt <= 2; attempt++) {
            const fbCaptchaExit = await checkAndHandleSearchCaptcha(`Indeed Fallback Search (${cleanAlternateRole})`);
            if (fbCaptchaExit) return fbCaptchaExit;

            await currentPage.puppeteerPage
              ?.evaluate(() => window.scrollBy(0, 350 + Math.floor(Math.random() * 300)))
              .catch(() => {});
            const sWait = await this.interruptibleSleep(2000 + Math.floor(Math.random() * 1500));
            if (sWait || !this.isRunning) break;

            fbJobs = await indeedAdapter.extractJobCards(currentPage);
            if (fbJobs.length > 0) break;
          }

          totalScanned += fbJobs.length;

          const fbQuickApply = fbJobs.filter(j => j.isQuickApply === true && !(j as any).isExternal);
          for (const job of fbQuickApply) {
            if (seenJobIds.has(job.jobId)) continue;
            seenJobIds.add(job.jobId);

            const proc = await processedJobsStore.isJobProcessed(job.jobId);
            if (proc.isProcessed && proc.status === 'applied') {
              stats.skipped++;
              continue;
            }

            queue.push(job);
            if (queue.length >= BATCH_CAP) break;
          }

          if (fbJobs.length === 0) break;
        }
      }
      stats.totalFound = totalScanned;
    }

    if (queue.length === 0) {
      const noQuickMsg = `No direct "Easily apply" jobs found among the ${totalScanned} scanned listings on Indeed (all require external company sites). Concluding run without spending credits.`;
      logger.info(`[DedicatedJobRunner] ${noQuickMsg}`);
      this.notifyStatus(portToSend, `ℹ️ ${noQuickMsg}`, 'info');
      this.cleanupRun();
      return { status: 'success', message: noQuickMsg, stats };
    }

    this.notifyStatus(
      portToSend,
      `🎯 Queued ${queue.length} eligible Indeed "Easily apply" jobs for this run (from ${totalScanned} scanned listings across search pages, capped at ${BATCH_CAP}).`,
      'info',
    );

    // Execution loop
    const config = await linkedInConfigStore.getConfig();
    for (let i = 0; i < queue.length; i++) {
      if (!this.isRunning || this.abortController?.signal?.aborted) {
        logger.info('[DedicatedJobRunner] Loop stopped by user signal.');
        break;
      }

      const job = queue[i];
      const jobRunId = `${runId}_${job.jobId}`;
      this.activeJobId = job.jobId;

      // Quota check
      const quota = await DailyQuotaManager.canApplyToday();
      if (!quota.allowed) {
        const quotaMsg = `🛑 Daily application quota reached (${quota.currentCount} today). Stopping run.`;
        this.notifyStatus(portToSend, quotaMsg, 'fail');
        break;
      }

      // Hard credit budget check
      const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
      if (balanceRes?.data?.remainingCredits !== undefined && balanceRes.data.remainingCredits < 1) {
        const creditMsg = `🛑 Insufficient credits (${balanceRes.data.remainingCredits} remaining). Halting run.`;
        this.notifyStatus(portToSend, creditMsg, 'fail');
        break;
      }

      // 1. Blacklist & Negative Keyword Check
      const blacklist = checkBlacklistAndNegativeKeywords(
        job.title,
        job.company,
        undefined,
        config.negativeKeywords,
        config.blacklistedCompanies,
        role,
      );
      if (blacklist.blacklisted) {
        this.notifyStatus(portToSend, `🚫 [Indeed] Skipped "${job.title}": ${blacklist.reason}.`, 'info');
        stats.skipped++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: `Blacklisted: ${blacklist.reason}`,
          creditsUsed: 0,
        });
        continue;
      }

      // Relevance check
      const relevance = checkJobSkillRelevance(job.title, job.descriptionSnippet, careerBrain, role);
      logger.info(
        `[Indeed Match Audit] "${job.title}": Score=${relevance.score}% (Threshold=${relevance.threshold}%, Relevant=${relevance.relevant}). Matched: [${relevance.matchedSkills.join(', ')}]. Candidate skills count: ${relevance.totalCandidateSkills}. Target role: "${role}"`,
      );

      if (!relevance.relevant) {
        this.notifyStatus(
          portToSend,
          `ℹ️ Skipped "${job.title}": Match score ${relevance.score}% < threshold ${relevance.threshold}%. (${relevance.reason || 'Skills do not match profile'})`,
          'info',
        );
        stats.skipped++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: `Match score ${relevance.score}% < ${relevance.threshold}%: ${relevance.reason || 'Skills do not closely match profile'}`,
          creditsUsed: 0,
        });
        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: `Match: ${relevance.score}% (<${relevance.threshold}%)`,
          creditsUsed: 0,
        });
        continue;
      }

      this.notifyStatus(
        portToSend,
        `💼 [Indeed] Applying to job ${i + 1} of ${queue.length}: "${job.title}" (${job.company})`,
        'info',
      );

      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        status: 'running',
        reason: 'Applying on Indeed...',
        creditsUsed: 0,
      });

      // Pre-navigation safety jitter (1.5s - 3.5s) to avoid rapid sequential page loads
      const preNavJitter = 1500 + Math.floor(Math.random() * 2000);
      const preNavAborted = await this.interruptibleSleep(preNavJitter);
      if (preNavAborted || !this.isRunning) break;

      await indeedAdapter.disableBeforeUnload(currentPage.tabId, currentPage.puppeteerPage);

      const scopedLLM = await getJobScopedLLM(jobRunId);
      const applyResult = await indeedAdapter.applyToJob(job, {
        page: currentPage,
        browserContext: this.browserContext!,
        careerBrain,
        portToSend,
        onLiveActivity,
        signal: this.abortController?.signal,
        runId: jobRunId,
        scopedLLM,
      });

      await indeedAdapter.disableBeforeUnload(currentPage.tabId, currentPage.puppeteerPage);

      if (!this.isRunning || this.abortController?.signal?.aborted || applyResult.reason?.includes('stopped by user')) {
        logger.info('[DedicatedJobRunner] Execution halted by user stop signal.');
        break;
      }

      if (applyResult.status === 'applied') {
        stats.applied++;
        await DailyQuotaManager.incrementAppliedCount();
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'applied',
          creditsUsed: 1,
        });

        await this.syncJobApplicationToBackend({
          jobId: job.jobId,
          jobTitle: job.title,
          company: job.company,
          platform: 'indeed',
          applicationUrl: job.url,
          status: 'applied',
          appliedAt: new Date().toISOString(),
        });

        this.notifyStatus(portToSend, `✅ Successfully applied to "${job.title}" at ${job.company}!`, 'ok');

        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'applied',
          creditsUsed: 1,
        });
      } else if (applyResult.status === 'skipped') {
        stats.skipped++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: applyResult.reason || 'Skipped',
          creditsUsed: 0,
        });
        this.notifyStatus(portToSend, `ℹ️ Skipped "${job.title}": ${applyResult.reason || 'Skipped'}`, 'info');
        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: applyResult.reason,
          creditsUsed: 0,
        });
      } else {
        // Check if failed due to Cloudflare/Captcha challenge (zero programmatic interaction)
        if (applyResult.reason?.includes('Captcha') || applyResult.reason?.includes('Bot Challenge')) {
          stats.failed++;
          await processedJobsStore.recordJob({
            jobId: job.jobId,
            url: job.url,
            title: job.title,
            company: job.company,
            status: 'failed',
            reason: 'Indeed Captcha/Bot Challenge detected',
            creditsUsed: 0,
          });
          return await handleIndeedCaptchaDetected(job.title);
        }

        stats.failed++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'failed',
          reason: applyResult.reason || 'Failed',
          creditsUsed: 0,
        });
        this.notifyStatus(
          portToSend,
          `❌ Failed application for "${job.title}": ${applyResult.reason || 'Failed'}`,
          'fail',
        );
        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'failed',
          reason: applyResult.reason,
          creditsUsed: 0,
        });
      }

      // Human-like anti-bot pacing delay (60-90s when applied, 4-6s when skipped) between Indeed applications
      if (applyResult.status === 'applied') {
        if (stats.applied >= targetToApply) {
          this.notifyStatus(
            portToSend,
            `🎉 Daily Application Limit reached (${stats.applied}/${targetToApply})!`,
            'ok',
          );
          break;
        }
        const pacingMs = 60_000 + Math.floor(Math.random() * 30_000);
        const pacingSec = Math.round(pacingMs / 1000);
        const currentElapsedMins = Math.floor((Date.now() - sessionStartTime) / 60000);
        this.notifyStatus(
          portToSend,
          `⏱️ [Session: ${currentElapsedMins}m / max 60m | Daily Quota: ${stats.applied}/${targetToApply} applied] Human pacing delay: resting ${pacingSec}s before next application to protect your account...`,
          'info',
        );
        const aborted = await this.interruptibleSleep(pacingMs);
        if (aborted || !this.isRunning) break;
      } else if (i < queue.length - 1 && this.isRunning) {
        const skipDelay = 4_000 + Math.floor(Math.random() * 2_000);
        const aborted = await this.interruptibleSleep(skipDelay);
        if (aborted || !this.isRunning) break;
      }
    }

    const sessionDurationMins = Math.round((Date.now() - sessionStartTime) / 60000);
    let summaryMsg = '';
    if (stats.applied >= targetToApply) {
      summaryMsg = `🎉 Daily Application Limit achieved! Applied to ${stats.applied}/${targetToApply} jobs on Indeed in ${sessionDurationMins} minutes (${stats.skipped} skipped).`;
    } else if (Date.now() - sessionStartTime >= MAX_SESSION_DURATION_MS) {
      summaryMsg = `⏱️ Maximum session duration of 60 minutes reached. Applied to ${stats.applied}/${targetToApply} jobs on Indeed (${stats.skipped} skipped).`;
    } else if (!this.isRunning) {
      summaryMsg = `🛑 Auto Apply stopped by user. Applied to ${stats.applied} jobs on Indeed in ${sessionDurationMins} minutes.`;
    } else {
      summaryMsg = `🏁 Indeed Apply finished! Submitted ${stats.applied}/${targetToApply} applications (${stats.skipped} skipped) in ${sessionDurationMins} minutes.`;
    }
    this.notifyStatus(portToSend, `🏁 ${summaryMsg}`, 'ok');

    if (portToSend) {
      try {
        portToSend.postMessage({
          type: 'LINKEDIN_RUN_FINISHED',
          summary: summaryMsg,
          stats,
        });
      } catch {}
    }

    this.cleanupRun();
    return { status: 'success', message: summaryMsg, stats };
  }

  /**
   * Stops active runner cleanly, closes dedicated window, and refunds credits.
   */
  public async stop(): Promise<void> {
    logger.info('[DedicatedJobRunner] User triggered stop.');
    // 1. Immediately flag as not running and trigger abort signal
    this.isRunning = false;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
    }
    if (this.currentExecutor) {
      this.currentExecutor.cancel();
      this.currentExecutor = null;
    }

    // 2. Immediately notify background listeners (resets isJobApplyInProgress flag)
    this.notifyStopListeners();

    // 3. Immediately notify UI port so SidePanel exits isApplying state
    if (this.activePort) {
      try {
        this.activePort.postMessage({
          type: 'LINKEDIN_STATUS_UPDATE',
          text: '⏹️ Application stopped by user.',
          status: 'info',
        });
        this.activePort.postMessage({
          type: 'LINKEDIN_RUN_FINISHED',
          summary: 'Application stopped by user.',
          stats: {
            totalFound: 0,
            applied: 0,
            modalOpened: 0,
            skipped: 0,
            failed: 0,
          },
        });
      } catch {}
    }

    // 4. Immediately close runner window
    await dedicatedWindowManager.closeRunnerWindow().catch(() => {});

    // 5. Background cleanup: refund active job credits and update status
    if (this.activeRunId) {
      const runId = this.activeRunId;
      await backendApiClient.refundCredits(runId).catch(() => {});
      await runnerStateStore.updateRunStatus('failed', { errorReason: 'Stopped by user' });
      if (this.activeJobId) {
        await processedJobsStore.recordJob({
          jobId: this.activeJobId,
          url: '',
          title: 'Stopped',
          company: '',
          status: 'failed',
          reason: 'Stopped by user',
          creditsUsed: 0,
        });
      }
    }

    this.cleanupRun();
  }

  /**
   * Handles unexpected debugger detachment (e.g. user opened DevTools on the runner tab).
   */
  public async handleDebuggerDetach(_detachedTabId?: number): Promise<void> {
    if (!this.isRunning && !this.activeRunId) return;

    logger.warning('[DedicatedJobRunner] Debugger detached while run was active. Failing run cleanly and refunding...');
    if (this.currentExecutor) {
      this.currentExecutor.cancel();
      this.currentExecutor = null;
    }

    const runId = this.activeRunId;
    if (runId) {
      await backendApiClient.refundCredits(runId).catch(err => {
        const errMsg = String(err?.message || err);
        if (/no billable usage|run_not_found|already_refunded/i.test(errMsg)) {
          logger.debug(`[DedicatedJobRunner] No billable usage to refund on detach for ${runId}.`);
        } else {
          logger.info(`[DedicatedJobRunner] Refund note on detach for ${runId}: ${errMsg}`);
        }
      });
      await runnerStateStore.updateRunStatus('failed', {
        errorReason:
          'Lost control of the tab (DevTools opened on it?). Please close DevTools on the job tab and retry.',
      });
      const detachMsg =
        '🛑 DevTools detected on job tab - this caused a disconnect. Please close DevTools on the job tab and retry.';
      this.notifyStatus(this.activePort, detachMsg, 'fail');
      this.notifyActivity(this.activePort, this.activeLiveActivity, {
        jobId: this.activeJobId || 'detached',
        url: '',
        title: 'DevTools Detached',
        company: 'Runner Tab',
        status: 'failed',
        reason: detachMsg,
        creditsUsed: 0,
      });
      if (this.activeJobId) {
        await processedJobsStore.recordJob({
          jobId: this.activeJobId,
          url: '',
          title: 'Detached',
          company: '',
          status: 'failed',
          reason: 'Lost control of tab (DevTools conflict)',
          creditsUsed: 0,
        });
      }
    }

    this.cleanupRun();
  }

  private async fillAndSubmitModal(
    page: any,
    job: { jobId: string; title: string; company: string; url: string },
    jobRunId: string,
    portToSend?: chrome.runtime.Port | null,
    onLiveActivity?: (activity: any) => void,
  ): Promise<{ success: boolean; reason?: string }> {
    let careerBrain = await careerBrainStore.getCareerBrain();
    const scopedLLM = await getJobScopedLLM(jobRunId);

    const onAuditLog = (
      category: 'MATCHED' | 'GENERATED' | 'ASKED',
      label: string,
      answer: string,
      detail?: string,
    ) => {
      const auditMsg = `[${category}] "${label}" -> "${answer}"${detail ? ` (${detail})` : ''}`;
      this.notifyStatus(portToSend, auditMsg, 'info');
      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: job.jobId,
        url: job.url,
        title: job.title,
        company: job.company,
        status: 'running',
        reason: auditMsg,
        creditsUsed: 0,
      });
    };

    // Resume "Best Match" Auto-Select:
    // Determine the optimal candidate resume for this specific job posting
    const candidateResumes: IResumeProfileItem[] =
      Array.isArray(careerBrain.resumes) && careerBrain.resumes.length > 0
        ? careerBrain.resumes
        : careerBrain.resumeFileName
          ? [
              {
                id: careerBrain.activeResumeId || 'default',
                fileName: careerBrain.resumeFileName,
                uploadedAt: careerBrain.updatedAt || Date.now(),
                focusTags: careerBrain.skills || [],
                rawText: careerBrain.resumeText || '',
                extractedSkills: careerBrain.autoExtractedSkills || careerBrain.skills || [],
                isDefault: true,
              },
            ]
          : [];

    const bestMatch = selectBestMatchingResume(candidateResumes, job.title);
    const bestResume = bestMatch.bestResume;

    if (bestResume && candidateResumes.length > 1) {
      onAuditLog(
        'MATCHED',
        'Resume Auto-Select',
        bestResume.fileName,
        `${bestMatch.score}% match (Tags: ${bestMatch.matchedTags.join(', ') || 'General'})`,
      );
      this.notifyStatus(
        portToSend,
        `🎯 [Best Resume Match] Auto-selected "${bestResume.fileName}" for "${job.title}" (${bestMatch.score}% match, Tags: ${bestMatch.matchedTags.join(', ') || 'General'})`,
        'info',
      );
    }

    let step = 0;
    const maxSteps = 10;
    let submitted = false;

    // Loop-prevention guards: limit repeat attempts on individual fields and modal steps
    const fieldAttemptCounts = new Map<string, number>();
    const MAX_FIELD_ATTEMPTS = 3;
    const stepRetryCounts = new Map<number, number>();
    const MAX_STEP_RETRIES = 2;

    const checkFieldRepeat = (fieldDesc: FormFieldDescriptor): boolean => {
      const key = `${(fieldDesc.label || '').trim().toLowerCase()}:::${fieldDesc.fieldType || 'text'}`;
      const current = (fieldAttemptCounts.get(key) || 0) + 1;
      fieldAttemptCounts.set(key, current);
      if (current >= MAX_FIELD_ATTEMPTS) {
        logger.error(
          `[DedicatedJobRunner] Field "${fieldDesc.label}" has reached ${current} resolution attempts. Aborting modal workflow to prevent infinite loop.`,
        );
        return false;
      }
      return true;
    };

    while (step < maxSteps && this.isRunning) {
      step++;
      this.notifyStatus(portToSend, `📄 Reviewing Step ${step} of the application...`, 'info');

      // 1. Check if application was already confirmed sent
      const preCheck = await page.verifyApplicationConfirmation();
      if (preCheck.confirmed) {
        submitted = true;
        break;
      }

      // 1b. Smart Resume Auto-Select on resume selection screen
      if (bestResume && typeof page.selectResumeInModal === 'function') {
        try {
          const resSel = await page.selectResumeInModal(bestResume.fileName, bestResume.focusTags);
          if (resSel.selected) {
            onAuditLog('MATCHED', 'Resume Selected in Form', bestResume.fileName, resSel.label);
          }
        } catch (selErr) {
          logger.warning('[DedicatedJobRunner] selectResumeInModal non-blocking warning:', selErr);
        }
      }

      // 2. Discover interactive form fields on current step
      const fields = await page.discoverModalFormFields();
      if (fields.length > 0) {
        this.notifyStatus(
          portToSend,
          `✨ Found ${fields.length} question${fields.length > 1 ? 's' : ''} on Step ${step}: Answering automatically...`,
          'info',
        );
        const unresolvedFields: FormFieldDescriptor[] = [];

        // Phase A: Auto-resolve with skipAskUser to fill all known/inferred fields first
        for (const field of fields) {
          if (!this.isRunning) break;
          if (!checkFieldRepeat(field)) {
            return {
              success: false,
              reason: `Field "${field.label}" repeated ${MAX_FIELD_ATTEMPTS} times (validation loop detected)`,
            };
          }
          try {
            const res = await resolveModalFieldWithAudit(page, field, careerBrain, scopedLLM, onAuditLog, {
              skipAskUser: true,
            });
            if (res.needsUserAnswer) {
              const isOptionalField =
                field.required === false ||
                /\boptional\b/i.test(field.label) ||
                /top\s*choice/i.test(field.label) ||
                Boolean(field.hintText && /\boptional\b/i.test(field.hintText));

              if (!isOptionalField) {
                unresolvedFields.push(field);
              } else {
                logger.info(`[DedicatedJobRunner] Skipping candidate prompt for optional field "${field.label}"`);
              }
            } else if (!res.success) {
              logger.warning(`[DedicatedJobRunner] Field "${field.label}" was not filled successfully in DOM.`);
            }
          } catch (err: any) {
            const errStr = String(err?.message || err);
            logger.warning(
              `[DedicatedJobRunner] Failed to resolve field "${field.label}" in Phase A: ${errStr}. Queueing for Phase B / Autonomous resolution...`,
            );
            unresolvedFields.push(field);
          }
          await new Promise(r => setTimeout(r, 400));
        }

        // Phase B: Handle unresolved fields via candidate prompt or autonomous LLM resolution
        if (unresolvedFields.length > 0 && this.isRunning) {
          if (unresolvedFields.length === 1) {
            const singleField = unresolvedFields[0];
            try {
              const res = await resolveModalFieldWithAudit(page, singleField, careerBrain, scopedLLM, onAuditLog, {
                skipAskUser: false,
              });
              careerBrain = await careerBrainStore.getCareerBrain();
              if (!res.success && scopedLLM) {
                logger.info(
                  `[DedicatedJobRunner] Field "${singleField.label}" was not filled. Attempting autonomous LLM solver...`,
                );
                const autoSol = await solveQuestionAutonomousWithLLM(singleField, careerBrain, scopedLLM);
                if (autoSol.success && autoSol.answer) {
                  await page.fillModalFieldDirect(singleField, autoSol.answer);
                }
              }
            } catch (err: any) {
              const errStr = String(err?.message || err);
              logger.warning(
                `[DedicatedJobRunner] Field "${singleField.label}" prompt failed: ${errStr}. Attempting autonomous LLM fallback...`,
              );
              if (scopedLLM) {
                const autoSol = await solveQuestionAutonomousWithLLM(singleField, careerBrain, scopedLLM);
                if (autoSol.success && autoSol.answer) {
                  await page.fillModalFieldDirect(singleField, autoSol.answer);
                }
              }
            }
          } else {
            // Present multiple unresolved fields in Side Panel (10s timeout)
            this.notifyStatus(
              portToSend,
              `🙋 Needs your input for ${unresolvedFields.length} question${unresolvedFields.length > 1 ? 's' : ''} (or answering automatically in 10s)...`,
              'info',
            );

            const batchItems: BatchQuestionItem[] = unresolvedFields.map((f, idx) => ({
              id: `field_${idx}_${Date.now()}`,
              fieldIndex: idx,
              questionText: f.label,
              fieldType: f.fieldType,
              options: f.options,
              min: f.min,
              max: f.max,
              skillName: userQuestionManager.extractSkillName(f.label) || undefined,
              required: f.required,
            }));

            try {
              const batchAnswers = await userQuestionManager.askQuestionBatch(batchItems);
              for (let i = 0; i < unresolvedFields.length; i++) {
                const f = unresolvedFields[i];
                const item = batchItems[i];
                const rawAns = batchAnswers[item.id];
                if (rawAns !== undefined && rawAns !== null && rawAns !== '') {
                  const adapted = adaptAnswerToFieldFormat(rawAns, f);
                  const valToFill = adapted.valid ? adapted.value : rawAns;
                  const fillSuccess = await page.fillModalFieldDirect(f, valToFill);
                  onAuditLog(
                    'ASKED',
                    f.label,
                    valToFill,
                    `Batch answer | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                  );
                }
              }
              careerBrain = await careerBrainStore.getCareerBrain();
            } catch (err: any) {
              const errStr = String(err?.message || err);
              logger.warning(
                `[DedicatedJobRunner] Batch question answering timed out or failed: ${errStr}. Resolving remaining fields autonomously with LLM...`,
              );
              if (scopedLLM) {
                for (const f of unresolvedFields) {
                  try {
                    const autoSol = await solveQuestionAutonomousWithLLM(f, careerBrain, scopedLLM);
                    if (autoSol.success && autoSol.answer) {
                      const fillSuccess = await page.fillModalFieldDirect(f, autoSol.answer);
                      onAuditLog(
                        'GENERATED',
                        f.label,
                        autoSol.answer,
                        `Autonomous LLM resolution (batch timeout fallback) | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                      );
                    }
                  } catch (solErr) {
                    logger.warning(`[DedicatedJobRunner] Failed to auto-solve "${f.label}":`, solErr);
                  }
                }
                careerBrain = await careerBrainStore.getCareerBrain();
              }
            }
          }
        }
      }

      // 3. Pre-advance validation check (checks required empty fields & aria-invalid)
      const validation = await page.validateModalFormState();
      if (validation.hasErrors) {
        if (validation.emptyRequiredFields.length > 0) {
          this.notifyStatus(
            portToSend,
            `⚡ Answering ${validation.emptyRequiredFields.length} remaining question${validation.emptyRequiredFields.length > 1 ? 's' : ''}...`,
            'info',
          );
          const unresolvedReqFields: FormFieldDescriptor[] = [];
          for (const reqField of validation.emptyRequiredFields) {
            if (!this.isRunning) break;
            if (!checkFieldRepeat(reqField)) {
              return {
                success: false,
                reason: `Required field "${reqField.label}" repeated ${MAX_FIELD_ATTEMPTS} times (validation loop detected)`,
              };
            }
            try {
              const res = await resolveModalFieldWithAudit(page, reqField, careerBrain, scopedLLM, onAuditLog, {
                skipAskUser: true,
              });
              if (res.needsUserAnswer) {
                unresolvedReqFields.push(reqField);
              } else if (!res.success) {
                logger.warning(
                  `[DedicatedJobRunner] Required field "${reqField.label}" was not filled successfully in DOM.`,
                );
              }
            } catch (err: any) {
              unresolvedReqFields.push(reqField);
            }
            await new Promise(r => setTimeout(r, 400));
          }

          if (unresolvedReqFields.length > 0 && this.isRunning) {
            if (unresolvedReqFields.length === 1) {
              const singleReq = unresolvedReqFields[0];
              try {
                await resolveModalFieldWithAudit(page, singleReq, careerBrain, scopedLLM, onAuditLog, {
                  skipAskUser: false,
                });
                careerBrain = await careerBrainStore.getCareerBrain();
              } catch (err: any) {
                logger.warning(
                  `[DedicatedJobRunner] Single required field timed out. Attempting autonomous LLM fallback...`,
                );
                if (scopedLLM) {
                  const autoSol = await solveQuestionAutonomousWithLLM(singleReq, careerBrain, scopedLLM);
                  if (autoSol.success && autoSol.answer) {
                    await page.fillModalFieldDirect(singleReq, autoSol.answer);
                  }
                }
              }
            } else {
              const batchItems: BatchQuestionItem[] = unresolvedReqFields.map((f, idx) => ({
                id: `req_field_${idx}_${Date.now()}`,
                fieldIndex: idx,
                questionText: f.label,
                fieldType: f.fieldType,
                options: f.options,
                min: f.min,
                max: f.max,
                skillName: userQuestionManager.extractSkillName(f.label) || undefined,
                required: f.required,
              }));

              try {
                const batchAnswers = await userQuestionManager.askQuestionBatch(batchItems);
                for (let i = 0; i < unresolvedReqFields.length; i++) {
                  const f = unresolvedReqFields[i];
                  const item = batchItems[i];
                  const rawAns = batchAnswers[item.id];
                  if (rawAns !== undefined && rawAns !== null && rawAns !== '') {
                    const adapted = adaptAnswerToFieldFormat(rawAns, f);
                    const valToFill = adapted.valid ? adapted.value : rawAns;
                    const fillSuccess = await page.fillModalFieldDirect(f, valToFill);
                    onAuditLog(
                      'ASKED',
                      f.label,
                      valToFill,
                      `Batch answer | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                    );
                  }
                }
                careerBrain = await careerBrainStore.getCareerBrain();
              } catch (err: any) {
                logger.warning(
                  `[DedicatedJobRunner] Batch required input timed out. Auto-solving remaining fields with LLM...`,
                );
                if (scopedLLM) {
                  for (const f of unresolvedReqFields) {
                    try {
                      const autoSol = await solveQuestionAutonomousWithLLM(f, careerBrain, scopedLLM);
                      if (autoSol.success && autoSol.answer) {
                        const fillSuccess = await page.fillModalFieldDirect(f, autoSol.answer);
                        onAuditLog(
                          'GENERATED',
                          f.label,
                          autoSol.answer,
                          `Autonomous LLM resolution (batch timeout fallback) | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                        );
                      }
                    } catch {}
                  }
                  careerBrain = await careerBrainStore.getCareerBrain();
                }
              }
            }
          }
        }

        // Re-check validation
        const recheck = await page.validateModalFormState();
        if (recheck.hasErrors) {
          if (recheck.emptyRequiredFields && recheck.emptyRequiredFields.length > 0) {
            logger.info(
              `[DedicatedJobRunner] Attempting emergency resolution for ${recheck.emptyRequiredFields.length} invalid/unfilled fields...`,
            );
            for (const reqF of recheck.emptyRequiredFields) {
              if (!checkFieldRepeat(reqF)) {
                return {
                  success: false,
                  reason: `Validation auto-heal field "${reqF.label}" repeated ${MAX_FIELD_ATTEMPTS} times (validation loop detected)`,
                };
              }
              try {
                // Try rule-based adaptation first (with newly detected error/numeric context in hintText)
                const ruleMatch = matchRuleBased(reqF, careerBrain);
                if (ruleMatch.matched && ruleMatch.answer) {
                  const adapted = adaptAnswerToFieldFormat(ruleMatch.answer, reqF);
                  if (adapted.valid) {
                    const fillSuccess = await page.fillModalFieldDirect(reqF, adapted.value);
                    onAuditLog(
                      'MATCHED',
                      reqF.label,
                      adapted.value,
                      `Validation auto-heal | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                    );
                  } else {
                    logger.warning(
                      `[DedicatedJobRunner] Validation auto-heal skipped incompatible ruleMatch value "${ruleMatch.answer}" for field "${reqF.label}"`,
                    );
                  }
                } else if (scopedLLM) {
                  const autoSol = await solveQuestionAutonomousWithLLM(reqF, careerBrain, scopedLLM);
                  if (autoSol.success && autoSol.answer) {
                    const adapted = adaptAnswerToFieldFormat(autoSol.answer, reqF);
                    if (adapted.valid) {
                      const fillSuccess = await page.fillModalFieldDirect(reqF, adapted.value);
                      onAuditLog(
                        'GENERATED',
                        reqF.label,
                        adapted.value,
                        `Validation recovery LLM | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                      );
                    } else {
                      logger.warning(
                        `[DedicatedJobRunner] Validation recovery LLM skipped incompatible value "${autoSol.answer}" for field "${reqF.label}"`,
                      );
                    }
                  }
                }
              } catch {}
            }
          }

          // Test if we can advance despite remaining validation warnings (often non-blocking in LinkedIn DOM)
          const testActions = await page.getModalActionButtons();
          if (testActions.hasNext || testActions.hasReview) {
            logger.info(
              `[DedicatedJobRunner] Attempting forward click to see if modal advances despite validation warnings...`,
            );
            const testAdvance = await page.clickModalForwardButton();
            if (testAdvance.clicked) {
              await new Promise(r => setTimeout(r, 1500));
              const postAdvanceCheck = await page.validateModalFormState();
              if (!postAdvanceCheck.hasErrors || postAdvanceCheck.emptyRequiredFields.length === 0) {
                continue; // Modal advanced successfully!
              }
              // Self-heal form validation errors
              const healing = await inspectAndHealFormErrors(page, '.jobs-easy-apply-modal');
              if (healing.correctedCount > 0) {
                logger.info(
                  `[DedicatedJobRunner] Self-healed ${healing.correctedCount} validation errors in modal. Re-clicking forward...`,
                );
                await page.clickModalForwardButton();
                await new Promise(r => setTimeout(r, 1500));
                continue;
              }
              // If errors still block the exact same fields, don't increment step; re-try on this step
              const retries = (stepRetryCounts.get(step) || 0) + 1;
              stepRetryCounts.set(step, retries);
              if (retries > MAX_STEP_RETRIES) {
                logger.error(
                  `[DedicatedJobRunner] Modal step ${step} failed validation ${retries} times. Aborting modal workflow to prevent infinite loop.`,
                );
                return {
                  success: false,
                  reason: `Modal step ${step} failed validation after ${retries} attempts`,
                };
              }
              logger.warning(
                `[DedicatedJobRunner] Modal forward click was blocked by validation errors. Re-correcting on step ${step} (attempt ${retries}/${MAX_STEP_RETRIES})...`,
              );
              step = Math.max(0, step - 1);
            }
          }
        }
      }

      // 4. Check action buttons (Submit vs Review/Next)
      const actions = await page.getModalActionButtons();

      if (actions.hasSubmit) {
        this.notifyStatus(portToSend, `🎉 All steps completed! Submitting your application now...`, 'info');
        const submitRes = await page.submitApplication();
        if (!submitRes.clicked) {
          return {
            success: false,
            reason: submitRes.error || 'Failed to click submit button',
          };
        }

        // 5. Verify submission confirmation
        this.notifyStatus(portToSend, `⏳ Confirming with LinkedIn that application was received...`, 'info');
        const confirmRes = await page.verifySubmissionConfirmation(8000);
        if (confirmRes.confirmed) {
          submitted = true;
          this.notifyStatus(portToSend, `✅ Application submitted successfully! 🎉`, 'ok');
          break;
        } else {
          return {
            success: false,
            reason: 'Submission was clicked but confirmation was not verified by LinkedIn DOM',
          };
        }
      } else if (actions.hasReview || actions.hasNext) {
        const fwdRes = await page.clickModalForwardButton();
        if (!fwdRes.clicked) {
          return {
            success: false,
            reason: 'Failed to advance to next modal step',
          };
        }
        await new Promise(r => setTimeout(r, 1500));
      } else {
        // Neither submit nor forward button found
        const modalOpen = await page.isEasyApplyModalOpen();
        if (!modalOpen) {
          const postCheck = await page.verifyApplicationConfirmation();
          if (postCheck.confirmed) {
            submitted = true;
            break;
          }
          return { success: false, reason: 'Modal closed unexpectedly without confirmation' };
        }
        return { success: false, reason: 'No action button (Next/Review/Submit) found on step' };
      }
    }

    if (submitted) {
      // Dismiss any lingering thank-you confirmation overlay
      await page.dismissEasyApplyModal(3000).catch(() => {});
      return { success: true };
    }

    return {
      success: false,
      reason: `Exceeded maximum steps (${maxSteps}) without submission`,
    };
  }

  /**
   * Visually distinguishes the automated runner tab so the user doesn't confuse it with their own tabs.
   * Prefixes the tab title with '🤖 [Runner]' and injects a non-intrusive floating indicator pill.
   */
  private async markRunnerTabVisually(page: any): Promise<void> {
    if (!page) return;
    try {
      const evaluateFn =
        typeof page?.evaluate === 'function'
          ? page.evaluate.bind(page)
          : typeof page?.puppeteerPage?.evaluate === 'function'
            ? page.puppeteerPage.evaluate.bind(page.puppeteerPage)
            : null;
      if (!evaluateFn) return;

      await evaluateFn(() => {
        if (!document.title.startsWith('🤖 [Runner]')) {
          document.title = `🤖 [Runner] ${document.title}`;
        }
        if (!document.getElementById('nanobrowser-runner-indicator') && document.body) {
          const pill = document.createElement('div');
          pill.id = 'nanobrowser-runner-indicator';
          pill.innerHTML = `
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;"></span>
            <span style="color:#e2e8f0;font-weight:600;font-size:11px;font-family:system-ui,-apple-system,sans-serif;letter-spacing:0.3px;">NanoBrowser Runner Active</span>
          `;
          Object.assign(pill.style, {
            position: 'fixed',
            top: '10px',
            right: '16px',
            zIndex: '2147483647',
            background: 'rgba(15, 23, 42, 0.92)',
            border: '1px solid rgba(56, 189, 248, 0.5)',
            borderRadius: '9999px',
            padding: '4px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            pointerEvents: 'none',
            userSelect: 'none',
          });
          document.body.appendChild(pill);
        }
      });
    } catch {
      // Non-fatal if page navigation is currently in flight
    }
  }

  private cleanupRun(): void {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
      this.abortController = null;
    }
    this.isRunning = false;
    this.activeRunId = null;
    this.activeJobId = null;
    this.activePort = null;
    this.activeLiveActivity = undefined;
    this.currentExecutor = null;
    this.stopKeepAlive();
    if (this.unregisterWindowCloseListener) {
      this.unregisterWindowCloseListener();
      this.unregisterWindowCloseListener = null;
    }
    if (this.unregisterNavAwayListener) {
      this.unregisterNavAwayListener();
      this.unregisterNavAwayListener = null;
    }
    this.notifyStopListeners();
    runnerStateStore.clearActiveRun().catch(() => {});
  }

  /**
   * Service worker recovery on startup: checks if an interrupted run succeeded or refunds.
   */
  public async recoverInterruptedRunOnStartup(): Promise<void> {
    try {
      const activeRun = await runnerStateStore.getActiveRun();
      if (!activeRun || activeRun.status !== 'running') {
        return;
      }

      logger.info(`[DedicatedRunner] Recovering interrupted run ${activeRun.runId} for job ${activeRun.jobId}`);

      let verifiedApplied = false;
      let testWin: chrome.windows.Window | undefined;
      try {
        testWin = await chrome.windows.create({
          url: activeRun.canonicalUrl,
          type: 'normal',
          focused: false,
          width: 1000,
          height: 800,
        });

        await new Promise(r => setTimeout(r, 6000));
        const tab = testWin?.tabs?.[0];
        if (tab?.id) {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const text = document.body ? document.body.innerText : '';
              return (
                /you applied on|applied \d+ (day|hour|week|month)s? ago/i.test(text) ||
                Boolean(document.querySelector('.jobs-s-apply__application-link, [data-test-applied-badge]'))
              );
            },
          });
          verifiedApplied = Boolean(results?.[0]?.result);
        }

        if (testWin && testWin.id) {
          await chrome.windows.remove(testWin.id).catch(() => {});
        }
      } catch (checkErr) {
        logger.warning('[DedicatedRunner] Failed to inspect page for recovery:', checkErr);
        if (testWin && testWin.id) {
          await chrome.windows.remove(testWin.id).catch(() => {});
        }
      }

      if (verifiedApplied) {
        logger.info(`[DedicatedRunner] Job ${activeRun.jobId} verified as applied during startup recovery.`);
        await DailyQuotaManager.incrementAppliedCount();
        await queueSafetyStore.setSingleApplyVerified(true);
        await processedJobsStore.recordJob({
          jobId: activeRun.jobId,
          url: activeRun.canonicalUrl,
          title: activeRun.jobTitle || 'Recovered Job',
          company: activeRun.company || '',
          status: 'applied',
          reason: 'Verified applied upon service worker restart',
          creditsUsed: 1,
        });
      } else {
        logger.info(`[DedicatedRunner] Refunding interrupted run ${activeRun.runId}`);
        await backendApiClient.refundCredits(activeRun.runId).catch(() => {});
        await processedJobsStore.recordJob({
          jobId: activeRun.jobId,
          url: activeRun.canonicalUrl,
          title: activeRun.jobTitle || 'Interrupted Job',
          company: activeRun.company || '',
          status: 'failed',
          reason: 'Interrupted by service worker restart',
          creditsUsed: 0,
        });
      }

      await runnerStateStore.clearActiveRun();
    } catch (err) {
      logger.error('[DedicatedRunner] Error in recoverInterruptedRunOnStartup:', err);
    }
  }
}

export const dedicatedJobRunner = DedicatedJobRunner.getInstance();
