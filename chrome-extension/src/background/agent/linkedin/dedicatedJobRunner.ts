// chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts
import { createLogger } from '@src/background/log';
import type BrowserContext from '@src/background/browser/context';
import type { Executor } from '@src/background/agent/executor';
import { backendApiClient, BACKEND_LLM_URL, MINIMUM_RUN_CREDITS } from '@extension/shared';
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
import { DailyQuotaManager, applicationKey, quotaStopMessage } from './rateLimiter';
import { runPreflight } from './preflight';
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
  solveValidationErrorWithLLM,
  analyzeModalStepWithLLM,
  matchRuleBased,
} from './formQuestionResolver';
import {
  evaluateDeepRelevance,
  inspectAndHealFormErrors,
  checkBlacklistAndNegativeKeywords,
  extractRequiredExperienceYears,
} from '../intelligence';
import { buildDraftResumePdf, buildDraftResumeFileName, bytesToBase64 } from './resumeDraft';
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
    new Set([
      ...(careerBrain.skills || []),
      ...Object.keys(careerBrain.skillExperience || {}),
      ...(careerBrain.autoExtractedSkills || []),
    ]),
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
  const combinedTarget = [targetRole || '', careerBrain.currentTitle || '', ...(careerBrain.predefinedRoles || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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

/**
 * Borderline relevance arbitration. The deterministic matcher is fast and free, but near
 * the threshold its keyword ratio produces false negatives — and a wrong skip burns a whole
 * job opportunity. When a job scores in the 40-60 band, one scoped-LLM judgement call
 * decides whether to proceed. Returns null on any failure so the deterministic result
 * always stands as the fallback.
 */
async function arbitrateBorderlineRelevance(
  llm: BaseChatModel,
  jobTitle: string,
  jdText: string,
  careerBrain: ICareerBrain,
): Promise<{
  isMatch: boolean;
  score: number;
  recommendation: 'apply' | 'skip';
  reason: string;
  matchedSkills: string[];
  missingSkills: string[];
} | null> {
  try {
    const skillsList = Array.from(
      new Set([
        ...(careerBrain.skills || []),
        ...(careerBrain.autoExtractedSkills || []),
        ...Object.keys(careerBrain.skillExperience || {}),
      ]),
    )
      .map(s => s.trim())
      .filter(s => s.length > 1)
      .slice(0, 40)
      .join(', ');

    const workHistory = (careerBrain.workExperience || [])
      .slice(0, 3)
      .map(w => `${w.title} at ${w.company}`)
      .join('; ');

    const prompt = `You are a senior technical recruiter deciding whether this job posting is a realistic fit for the candidate.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION (truncated):
${(jdText || '').slice(0, 3000)}

CANDIDATE PROFILE:
- Current / target role: ${careerBrain.currentTitle || 'Not specified'}
- Skills: ${skillsList || 'Not listed'}
- Years of experience: ${careerBrain.yearsOfExperience || 'Unknown'}
- Work history: ${workHistory || 'Not specified'}

Reply with ONLY "YES" if the candidate has a realistic chance of an interview and should apply, otherwise "NO". Then add one short sentence explaining why.`;

    const res = await llm.invoke(prompt);
    const content = typeof res?.content === 'string' ? res.content : JSON.stringify(res?.content || '');
    const trimmed = content.trim();
    if (/^(yes|proceed|apply)\b/i.test(trimmed)) {
      return {
        isMatch: true,
        score: 55,
        recommendation: 'apply',
        reason: 'Borderline score upgraded by relevance arbitration: candidate judged a realistic fit.',
        matchedSkills: [],
        missingSkills: [],
      };
    }
    if (/^(no|skip|irrelevant)\b/i.test(trimmed)) {
      return {
        isMatch: false,
        score: 40,
        recommendation: 'skip',
        reason: 'Borderline score confirmed by relevance arbitration: judged not a fit.',
        matchedSkills: [],
        missingSkills: [],
      };
    }
    return null;
  } catch (err) {
    logger.warning('[DedicatedJobRunner] Borderline arbitration failed; keeping deterministic result:', err);
    return null;
  }
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
  if (
    r.includes('no longer accepting') ||
    r.includes('closed listing') ||
    /\bjob (?:is )?closed\b/i.test(r) ||
    /\bposting (?:is )?closed\b/i.test(r)
  ) {
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

/**
 * Increments the skipped counter AND records a stable reason bucket so the run
 * summary can show exactly WHY jobs were skipped (instrumentation for skip reduction).
 * Safe no-op when stats is undefined or lacks the skipReasons map.
 */
export function recordSkip(
  stats: { skipped: number; skipReasons?: Record<string, number> } | undefined,
  reasonBucket: string,
): void {
  if (!stats) return;
  stats.skipped++;
  if (stats.skipReasons) {
    stats.skipReasons[reasonBucket] = (stats.skipReasons[reasonBucket] || 0) + 1;
  }
}

/**
 * Buckets raw form-filling failure reasons into a small, stable set of categories
 * so the run summary table stays readable instead of fragmenting per job.
 */
export function bucketFillFailureReason(rawReason: string | undefined): string {
  const r = (rawReason || '').toLowerCase();
  if (r.includes('security')) return 'form: security checkpoint';
  if (r.includes('validation loop')) return 'form: validation loop detected';
  if (r.includes('mandatory')) return 'form: mandatory document missing';
  if (r.includes('failed validation')) return 'form: step validation failed';
  if (r.includes('confirmation')) return 'form: submission confirmation unverified';
  if (r.includes('submit')) return 'form: submit click failed';
  if (r.includes('validation blocked')) return 'form: Next/Review rejected (validation)';
  if (r.includes('advance')) return 'form: could not advance step';
  if (r.includes('modal closed')) return 'form: modal closed unexpectedly';
  if (r.includes('no action button')) return 'form: no action button found';
  if (r.includes('maximum steps')) return 'form: max steps exceeded';
  const trimmed = (rawReason || 'unknown error').trim().slice(0, 60);
  return trimmed ? `form: ${trimmed}` : 'form: unknown failure';
}

/**
 * Formats the skip-reason counter map into a compact "reason ×count" breakdown line.
 * Returns empty string when the map is missing or empty.
 */
export function formatSkipBreakdown(skipReasons: Record<string, number> | undefined): string {
  if (!skipReasons) return '';
  const entries = Object.entries(skipReasons).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '';
  return `📊 Skip breakdown: ${entries.map(([reason, count]) => `${reason} ×${count}`).join(' | ')}`;
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

    // 3. Quota (a server-held slot for this job) & Profile Completeness Checks
    const quota = await DailyQuotaManager.reserveApplication(applicationKey(jobId, canonicalUrl), 'runner');
    if (!quota.allowed) {
      let allowFallback = false;
      if (quota.reason === 'error') {
        const localQuota = await DailyQuotaManager.getQuotaData().catch(() => null);
        const applied = localQuota?.appliedCount ?? 0;
        const maxQ = localQuota?.maxDailyQuota || 10;
        const remaining = maxQ - applied;
        if (remaining > 0 && !localQuota?.isPausedDueToQuota) {
          logger.warning(
            `[DedicatedJobRunner] Server quota verification slow/unavailable; proceeding with local quota fallback (${applied}/${maxQ}).`,
          );
          this.notify(
            portToSend,
            `⚠️ Server quota check was slow/unavailable. Continuing with local quota (${applied}/${maxQ} used).`,
            false,
          );
          allowFallback = true;
        }
      }
      if (!allowFallback) {
        const quotaMsg = quotaStopMessage(quota);
        this.notify(portToSend, `🛑 ${quotaMsg}`, true);
        this.isRunning = false;
        return { status: 'error', message: quotaMsg };
      }
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
      await DailyQuotaManager.commitApplication(applicationKey(jobId, canonicalUrl));
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
      skipReasons?: Record<string, number>;
    };
  }> {
    const { portToSend, onLiveActivity } = options;
    const stats = {
      totalFound: 0,
      applied: 0,
      modalOpened: 0,
      skipped: 0,
      failed: 0,
      skipReasons: {} as Record<string, number>,
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

    // 0.1 PREFLIGHT CHECK: API Reachability & Entitlement / Quota (Fail-Closed)
    this.notifyStatus(portToSend, '🔍 Performing preflight health check & verifying credit balance...', 'info');
    const preflight = await runPreflight();
    if (!preflight.ok) {
      this.notifyStatus(portToSend, preflight.statusMessage, 'fail');
      if (preflight.error === 'AUTH_REQUIRED' && portToSend) {
        try {
          portToSend.postMessage({
            type: 'AUTH_REQUIRED',
            error: preflight.statusMessage,
          });
        } catch {}
      }
      return { status: 'error', message: preflight.statusMessage, stats };
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

    const BATCH_CAP = Math.min(options.maxJobs || 10, 10);
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

      const candidateNameSources: string[] = [careerBrain.fullName, session?.user?.name].filter(Boolean) as string[];
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
      const primaryLocation = prioritizedLocations[0] || location || 'Remote';
      const searchUrl = linkedinAdapter.buildSearchUrl(role, primaryLocation, candidateNameSources);

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

      const currentPage = await this.browserContext.getCurrentPage();

      // Allow Chrome tab navigation to load the LinkedIn search page
      const navWaitAborted = await this.interruptibleSleep(3000);
      if (navWaitAborted || !this.isRunning) {
        this.cleanupRun('Stopped by user', stats);
        return { status: 'stopped', message: 'Stopped by user', stats };
      }

      if (typeof currentPage.waitForDomSettlement === 'function') {
        await currentPage.waitForDomSettlement(
          '.jobs-search-results-list, .scaffold-layout__list, [data-view-name="job-card"]',
          { maxWaitMs: 5000, quietPeriodMs: 200 },
        );
      }
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

      // 4.1 Check if runner tab is already on an active LinkedIn search page
      try {
        const currentUrl = (await currentPage.url?.()) || '';
        if (currentUrl.includes('/jobs/search')) {
          const parsedUrl = new URL(currentUrl);
          const activeLocation = parsedUrl.searchParams.get('location');
          const activeKeywords = parsedUrl.searchParams.get('keywords');
          if (activeLocation && !prioritizedLocations.includes(activeLocation)) {
            // Prioritize the user's actively open search location at the top of the queue
            prioritizedLocations.unshift(activeLocation);
            this.notifyStatus(
              portToSend,
              `🔍 Detected active search on runner tab: Location="${activeLocation}"${activeKeywords ? `, Role="${activeKeywords}"` : ''}. Prioritizing current page search results.`,
              'info',
            );
          }
        }
      } catch (err) {
        logger.debug('[DedicatedJobRunner] Could not inspect active runner tab URL:', err);
      }

      // 5. Sequential find-and-apply: scan the left-hand job list and immediately finish
      // each eligible job before looking for the next one. There is no up-front "gather N
      // jobs" batch — the run keeps going until BATCH_CAP applications are submitted.
      const seenJobIds = new Set<string>();
      let totalLinkedInScanned = 0;
      let candidateCount = 0;
      let halted = false;

      const navigateLinkedInTab = async (url: string) => {
        try {
          if (currentPage.tabId) {
            await chrome.tabs.update(currentPage.tabId, { url });
            // Wait for tab navigation to commit or complete
            await new Promise<void>(resolve => {
              let done = false;
              const finish = () => {
                if (!done) {
                  done = true;
                  try {
                    chrome.tabs.onUpdated.removeListener(listener);
                  } catch {}
                  resolve();
                }
              };
              const listener = (tid: number, info: chrome.tabs.TabChangeInfo) => {
                if (
                  tid === currentPage.tabId &&
                  (info.status === 'complete' || (info.url && info.url.startsWith('http')))
                ) {
                  finish();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              setTimeout(finish, 3500);
            });
          } else if (currentPage.puppeteerPage) {
            await currentPage.puppeteerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
          }
        } catch {
          try {
            if (currentPage.puppeteerPage) {
              await currentPage.puppeteerPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
            }
          } catch {}
        }
      };

      /**
       * Reads every job card on the currently loaded search page and finishes each eligible
       * job one at a time (apply -> close modal -> next). Returns false when the page has no
       * cards at all, so the caller can stop paginating that location.
       */
      const processSearchPage = async (
        searchPageUrl: string,
        searchRole: string,
        searchLabel: string,
      ): Promise<boolean> => {
        let jobCards: Array<{ jobId: string; title: string; company: string; url: string }> = [];
        let readAttempts = 0;
        while (readAttempts < 3 && jobCards.length === 0) {
          readAttempts++;
          if (!this.isRunning) break;
          this.notifyStatus(
            portToSend,
            `🔍 Scanning LinkedIn job search results ${searchLabel} (attempt ${readAttempts}/3)...`,
            'info',
          );
          jobCards = await currentPage.readJobListFromSearchPane(Math.max(readAttempts + 2, 4));
          if (jobCards.length === 0 && readAttempts < 3) {
            const sleepAborted = await this.interruptibleSleep(2500);
            if (sleepAborted || !this.isRunning) break;
          }
        }

        totalLinkedInScanned += jobCards.length;
        if (jobCards.length === 0) return false;

        this.notifyStatus(
          portToSend,
          `📋 Found ${jobCards.length} job cards ${searchLabel}. Applying one by one (${stats.applied}/${BATCH_CAP} done so far)...`,
          'info',
        );

        for (const card of jobCards) {
          if (!this.isRunning || halted || stats.applied >= BATCH_CAP) return true;
          if (seenJobIds.has(card.jobId)) continue;
          seenJobIds.add(card.jobId);

          const proc = await processedJobsStore.isJobProcessed(card.jobId);
          if (proc.isProcessed && proc.status === 'applied') {
            recordSkip(stats, 'already applied previously');
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: card.jobId,
              url: card.url,
              title: card.title,
              company: card.company,
              status: 'skipped',
              reason: 'Already applied previously',
              creditsUsed: 0,
            });
            continue;
          }

          // 1-day negative cache: jobs that FAILED recently are skipped without
          // re-burning credits on the same deterministic failure. They become
          // eligible again automatically after the TTL (24h).
          const recentFail = await processedJobsStore.isJobRecentlyFailed(card.jobId);
          if (recentFail.recentlyFailed) {
            recordSkip(stats, 'negative cache (failed within 24h)');
            this.notifyStatus(
              portToSend,
              `⏳ Skipped "${card.title}": failed recently (${recentFail.reason || 'application error'}). Retry available tomorrow.`,
              'info',
            );
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: card.jobId,
              url: card.url,
              title: card.title,
              company: card.company,
              status: 'skipped',
              reason: 'Failed recently (retry available tomorrow)',
              creditsUsed: 0,
            });
            continue;
          }

          candidateCount++;
          const res = await this.applySingleLinkedInJobInSplitPane(
            currentPage,
            { jobId: card.jobId, title: card.title, company: card.company, url: card.url },
            searchPageUrl,
            searchRole,
            candidateNameSources,
            config,
            careerBrain,
            runId,
            portToSend,
            onLiveActivity,
            stats,
            candidateCount,
            BATCH_CAP,
          );

          if (res.status === 'halt') {
            halted = true;
            return true;
          }

          // If the job had to be opened by direct URL, restore the search page so the next
          // card can be picked from the split-pane list again.
          if (res.usedDirectFallback && this.isRunning && stats.applied < BATCH_CAP) {
            logger.info(`[DedicatedJobRunner] Restoring search page ${searchPageUrl} for next job...`);
            await navigateLinkedInTab(searchPageUrl);
            await currentPage.waitForDomSettlement?.(
              '.jobs-search-results-list, .scaffold-layout__list, [data-view-name="job-card"]',
              { maxWaitMs: 3500, quietPeriodMs: 200 },
            );
          }

          // Inter-job pacing & anti-bot safety jitter after every completed attempt.
          if (this.isRunning && stats.applied < BATCH_CAP) {
            // Strict sequential completion: ensure the previous application modal is fully
            // closed before picking the next job (prevents overlap between jobs).
            const isModalStillOpen = await currentPage.isEasyApplyModalOpen();
            if (isModalStillOpen) {
              logger.info(
                '[DedicatedJobRunner] Waiting for previous job application to fully conclude before next candidate...',
              );
              await currentPage.dismissEasyApplyModal(5000).catch(() => {});
              await new Promise(r => setTimeout(r, 1000));
            }

            const jitterMs = 1500 + Math.floor(Math.random() * 1000); // 1.5s - 2.5s natural human cadence
            this.notifyStatus(
              portToSend,
              `⏳ Pacing safety delay (${Math.round(jitterMs / 100) / 10}s) before next candidate job...`,
              'info',
            );
            const jitterAborted = await this.interruptibleSleep(jitterMs);
            if (jitterAborted || !this.isRunning) return true;
          }
        }

        return true;
      };

      for (let locIdx = 0; locIdx < prioritizedLocations.length; locIdx++) {
        if (halted || !this.isRunning || stats.applied >= BATCH_CAP) break;

        const currentLoc = prioritizedLocations[locIdx];
        const locRank = locIdx + 1;

        // Scan up to 3 pages per location, applying to each eligible job as soon as it is found.
        for (let pageIdx = 0; pageIdx < 3; pageIdx++) {
          if (halted || !this.isRunning || stats.applied >= BATCH_CAP) break;

          const pageOffset = pageIdx * 25;
          const searchPageUrl = linkedinAdapter.buildSearchUrl(role, currentLoc, candidateNameSources, pageOffset);
          if (locIdx > 0 || pageIdx > 0) {
            if (pageIdx > 0) {
              this.notifyStatus(
                portToSend,
                `📄 [LinkedIn] [${currentLoc}] Checking page ${pageIdx + 1} (${stats.applied}/${BATCH_CAP} applied so far)...`,
                'info',
              );
            } else {
              this.notifyStatus(
                portToSend,
                `📍 [LinkedIn] Location #${locRank - 1} done (${stats.applied}/${BATCH_CAP} applied). Checking Location #${locRank}: "${currentLoc}"...`,
                'info',
              );
            }
            await navigateLinkedInTab(searchPageUrl);
            const sleepAborted = await this.interruptibleSleep(3000);
            if (sleepAborted || !this.isRunning) break;
            if (typeof currentPage.waitForDomSettlement === 'function') {
              await currentPage.waitForDomSettlement(
                '.jobs-search-results-list, .scaffold-layout__list, [data-view-name="job-card"]',
                { maxWaitMs: 4000, quietPeriodMs: 200 },
              );
            }
          }

          const hadCards = await processSearchPage(
            searchPageUrl,
            role,
            `[${currentLoc}]${pageIdx > 0 ? ` page ${pageIdx + 1}` : ''}`,
          );
          if (!hadCards) break; // no cards at all -> stop paginating this location
        }
      }

      // Fallback search trigger: If fewer than 3 genuine Easy Apply jobs were found,
      // fallback to candidate's other predefined target roles from profile
      const candidateAlternateRoles = (careerBrain.predefinedRoles || [])
        .map(r => (r || '').trim())
        .filter(r => r && r.toLowerCase() !== role.toLowerCase());

      for (const altRole of candidateAlternateRoles) {
        if (halted || !this.isRunning || stats.applied >= BATCH_CAP) break;
        const cleanAltRole = sanitizeRoleSearchQuery(altRole, candidateNameSources, 'Software Engineer');
        if (!cleanAltRole || cleanAltRole.toLowerCase() === role.toLowerCase()) continue;

        this.notifyStatus(
          portToSend,
          `🔍 Checking alternate role from profile: "${cleanAltRole}" (${stats.applied}/${BATCH_CAP} applied so far)...`,
          'info',
        );

        for (let locIdx = 0; locIdx < prioritizedLocations.length; locIdx++) {
          if (halted || !this.isRunning || stats.applied >= BATCH_CAP) break;
          const currentLoc = prioritizedLocations[locIdx];
          const altSearchUrl = linkedinAdapter.buildSearchUrl(cleanAltRole, currentLoc, candidateNameSources);
          await navigateLinkedInTab(altSearchUrl);
          const sleepAborted = await this.interruptibleSleep(3000);
          if (sleepAborted || !this.isRunning) break;
          if (typeof currentPage.waitForDomSettlement === 'function') {
            await currentPage.waitForDomSettlement(
              '.jobs-search-results-list, .scaffold-layout__list, [data-view-name="job-card"]',
              { maxWaitMs: 4000, quietPeriodMs: 200 },
            );
          }

          await processSearchPage(altSearchUrl, cleanAltRole, `[${currentLoc}]`);
        }
      }

      stats.totalFound = totalLinkedInScanned;

      if (totalLinkedInScanned === 0) {
        const noJobsMsg =
          'No jobs found across target locations. Please check your role/location criteria or search filters.';
        this.notifyStatus(portToSend, `⚠️ ${noJobsMsg}`, 'fail');
        this.cleanupRun(noJobsMsg, stats);
        return { status: 'error', message: noJobsMsg, stats };
      }

      if (stats.applied >= BATCH_CAP) {
        this.notifyStatus(
          portToSend,
          `🎯 Target reached: ${stats.applied}/${BATCH_CAP} applications submitted. Stopping job search.`,
          'ok',
        );
      }

      // 6. Final Summary
      const summaryMsg = `🏁 Auto Apply finished! Submitted ${stats.applied} application${stats.applied === 1 ? '' : 's'} (${stats.skipped} skipped).`;
      this.notifyStatus(portToSend, summaryMsg, 'ok');
      const skipBreakdown = formatSkipBreakdown(stats.skipReasons);
      if (skipBreakdown) {
        this.notifyStatus(portToSend, skipBreakdown, 'info');
      }

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
    const BATCH_CAP = Math.min(options.maxJobs || 40, 40);

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

    // Scan jobs with retry & progressive auto-scroll to ensure DOM hydration for up to 40 jobs
    let jobs: IJobQueueItem[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      this.notifyStatus(
        portToSend,
        `🔍 [Naukri.com] Scanning search results for "${role}" (attempt ${attempt}/4)...`,
        'info',
      );
      // Progressively scroll to trigger lazy loading of search cards
      for (let s = 1; s <= 3; s++) {
        await currentPage.puppeteerPage
          ?.evaluate((step: number) => {
            window.scrollBy(0, step * 600);
          }, s)
          .catch(() => {});
        await this.interruptibleSleep(500);
      }
      jobs = await naukriAdapter.extractJobCards(currentPage);
      if (jobs.length >= BATCH_CAP) break;
      const retryWait = await this.interruptibleSleep(1500);
      if (retryWait || !this.isRunning) break;
    }
    stats.totalFound = jobs.length;

    if (jobs.length === 0) {
      const noJobsMsg = `No job listings found on Naukri for role "${role}".`;
      this.notifyStatus(portToSend, `ℹ️ ${noJobsMsg}`, 'info');
      this.cleanupRun();
      return { status: 'success', message: noJobsMsg, stats };
    }

    // Deduplicate against processedJobsStore
    const eligibleJobs: typeof jobs = [];
    for (const job of jobs) {
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
      eligibleJobs.push(job);
    }

    // Prioritize direct Quick Apply jobs first
    const sortedJobs = [...eligibleJobs].sort((a, b) => (b.isQuickApply ? 1 : 0) - (a.isQuickApply ? 1 : 0));
    const queue = sortedJobs.slice(0, BATCH_CAP);
    this.notifyStatus(
      portToSend,
      `🎯 Queued ${queue.length} eligible Naukri jobs for this run (capped at max ${BATCH_CAP}).`,
      'info',
    );

    // Execution loop
    const config = await linkedInConfigStore.getConfig();
    for (let i = 0; i < queue.length; i++) {
      if (!this.isRunning) break;

      const job = queue[i];
      const jobRunId = `${runId}_${job.jobId}`;
      this.activeJobId = job.jobId;

      // Daily quota: hold a server slot for this job (released if it is skipped or fails)
      const quota = await DailyQuotaManager.reserveApplication(applicationKey(job.jobId, job.url), 'runner');
      if (!quota.allowed) {
        let allowFallback = false;
        if (quota.reason === 'error') {
          const localQuota = await DailyQuotaManager.getQuotaData().catch(() => null);
          const applied = localQuota?.appliedCount ?? 0;
          const maxQ = localQuota?.maxDailyQuota || 10;
          const remaining = maxQ - applied;
          if (remaining > 0 && !localQuota?.isPausedDueToQuota) {
            logger.warning(
              `[DedicatedJobRunner] Server quota verification slow/unavailable for ${job.jobId}; proceeding with local quota fallback (${applied}/${maxQ}).`,
            );
            this.notifyStatus(
              portToSend,
              `⚠️ Server quota check was slow/unavailable. Continuing with local quota (${applied}/${maxQ} used).`,
              'info',
            );
            allowFallback = true;
          }
        }
        if (!allowFallback) {
          const quotaMsg = `🛑 ${quotaStopMessage(quota)} Stopping run.`;
          this.notifyStatus(portToSend, quotaMsg, 'fail');
          break;
        }
      }

      // Hard credit budget check (not applied to verified JobForm Automator Premium)
      const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
      if (
        !balanceRes?.data?.premiumCovered &&
        balanceRes?.data?.remainingCredits !== undefined &&
        balanceRes.data.remainingCredits < 1
      ) {
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
        continue;
      }

      // Relevance check
      const relevance = checkJobSkillRelevance(job.title, job.descriptionSnippet, careerBrain, role);
      logger.info(
        `[Naukri Match Audit] "${job.title}": Score=${relevance.score}% (Threshold=${relevance.threshold}%, Relevant=${relevance.relevant}). Matched: [${relevance.matchedSkills.join(', ')}]. Candidate skills count: ${relevance.totalCandidateSkills}. Target role: "${role}"`,
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
          reason: 'Low skill match',
          creditsUsed: 0,
        });
        continue;
      }

      this.notifyStatus(
        portToSend,
        `💼 [Naukri] Applying to job ${i + 1} of ${queue.length}: "${job.title}" (${job.company})`,
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

      if (applyResult.status === 'applied') {
        stats.applied++;
        await DailyQuotaManager.commitApplication(applicationKey(job.jobId, job.url));
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

      // Anti-bot pacing delay (5-8s) between Naukri jobs only when applied!
      if (i < queue.length - 1 && this.isRunning) {
        if (applyResult.status === 'applied') {
          const delayMs = 5000 + Math.floor(Math.random() * 3000);
          this.notifyStatus(
            portToSend,
            `⏳ Pacing delay: waiting ${(delayMs / 1000).toFixed(0)}s before next job...`,
            'info',
          );
          const aborted = await this.interruptibleSleep(delayMs);
          if (aborted) break;
        } else {
          // If skipped, quick 1.5s delay to avoid hammer without 20s freeze
          await this.interruptibleSleep(1500);
        }
      }
    }

    const summaryMsg = `Naukri Apply complete: ${stats.applied} applied, ${stats.skipped} skipped, ${stats.failed} failed.`;
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
    const BATCH_CAP = Math.min(options.maxJobs || 20, 25);

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
      `🎯 [Indeed] Search Criteria: Role="${cleanRole}" | Location(s): ${locationsDisplay} | Easily Apply=true`,
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

    // Ensure Indeed "Easily apply" filter is activated on search results
    const initialFilter = await indeedAdapter.ensureEasilyApplyFilterActive(currentPage);
    if (initialFilter.clicked) {
      this.notifyStatus(
        portToSend,
        '✨ Activated "Easily apply" filter on Indeed! Refreshing search results...',
        'info',
      );
      await this.interruptibleSleep(3500 + Math.floor(Math.random() * 1000));
      await this.markRunnerTabVisually(currentPage);
    }

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

        const locFilter = await indeedAdapter.ensureEasilyApplyFilterActive(currentPage);
        if (locFilter.clicked) {
          await this.interruptibleSleep(2000 + Math.floor(Math.random() * 1000));
        }
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

          const pageFilter = await indeedAdapter.ensureEasilyApplyFilterActive(currentPage);
          if (pageFilter.clicked) {
            await this.interruptibleSleep(2000 + Math.floor(Math.random() * 1000));
          }
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

        const fbFilter = await indeedAdapter.ensureEasilyApplyFilterActive(currentPage);
        if (fbFilter.clicked) {
          await this.interruptibleSleep(2000 + Math.floor(Math.random() * 1000));
        }

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

            const fbPageFilter = await indeedAdapter.ensureEasilyApplyFilterActive(currentPage);
            if (fbPageFilter.clicked) {
              await this.interruptibleSleep(2000 + Math.floor(Math.random() * 1000));
            }
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

      // Daily quota: hold a server slot for this job (released if it is skipped or fails)
      const quota = await DailyQuotaManager.reserveApplication(applicationKey(job.jobId, job.url), 'runner');
      if (!quota.allowed) {
        let allowFallback = false;
        if (quota.reason === 'error') {
          const localQuota = await DailyQuotaManager.getQuotaData().catch(() => null);
          const applied = localQuota?.appliedCount ?? 0;
          const maxQ = localQuota?.maxDailyQuota || 10;
          const remaining = maxQ - applied;
          if (remaining > 0 && !localQuota?.isPausedDueToQuota) {
            logger.warning(
              `[DedicatedJobRunner] Server quota verification slow/unavailable for ${job.jobId}; proceeding with local quota fallback (${applied}/${maxQ}).`,
            );
            this.notifyStatus(
              portToSend,
              `⚠️ Server quota check was slow/unavailable. Continuing with local quota (${applied}/${maxQ} used).`,
              'info',
            );
            allowFallback = true;
          }
        }
        if (!allowFallback) {
          const quotaMsg = `🛑 ${quotaStopMessage(quota)} Stopping run.`;
          this.notifyStatus(portToSend, quotaMsg, 'fail');
          break;
        }
      }

      // Hard credit budget check (not applied to verified JobForm Automator Premium)
      const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
      if (
        !balanceRes?.data?.premiumCovered &&
        balanceRes?.data?.remainingCredits !== undefined &&
        balanceRes.data.remainingCredits < 1
      ) {
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
        await DailyQuotaManager.commitApplication(applicationKey(job.jobId, job.url));
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

      if (!this.isRunning) {
        logger.info('[DedicatedJobRunner] Application flow stopped by user.');
        break;
      }
    }

    const summaryMsg = `Indeed Apply complete: ${stats.applied} applied, ${stats.skipped} skipped, ${stats.failed} failed.`;
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

  /**
   * Checkpoint Guardian: Passively pauses automation when an Arkose challenge,
   * CAPTCHA, or Phone/SMS OTP verification appears, notifying the user and auto-resuming.
   */
  private async waitForManualCheckpointResolution(
    page: any,
    portToSend?: chrome.runtime.Port | null,
    onLiveActivity?: (activity: any) => void,
    timeoutMs = 90000,
  ): Promise<{ solved: boolean; aborted: boolean }> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    const alertMsg =
      '🛡️ Security checkpoint / OTP detected. Please complete it in the runner tab — automation will resume automatically once solved.';
    this.notifyStatus(portToSend, alertMsg, 'info');
    this.notifyActivity(portToSend, onLiveActivity, {
      jobId: this.activeJobId || 'checkpoint',
      url: '',
      title: 'Security Verification Detected',
      company: 'Runner Tab',
      status: 'needs_verification',
      reason: alertMsg,
      creditsUsed: 0,
    });

    while (Date.now() - startTime < timeoutMs) {
      if (!this.isRunning) {
        return { solved: false, aborted: true };
      }

      const aborted = await this.interruptibleSleep(pollIntervalMs);
      if (aborted || !this.isRunning) {
        return { solved: false, aborted: true };
      }

      if (typeof page.detectSecurityCheckpoint === 'function') {
        const check = await page.detectSecurityCheckpoint().catch(() => ({ isCheckpoint: false }));
        if (!check.isCheckpoint) {
          this.notifyStatus(portToSend, '✅ Security verification completed! Resuming application...', 'ok');
          await this.interruptibleSleep(1500);
          return { solved: true, aborted: false };
        }
      }
    }

    this.notifyStatus(portToSend, '⏳ Security verification window (90s) expired. Skipping job cleanly...', 'info');
    return { solved: false, aborted: false };
  }

  /**
   * Checkpoint Guardian for New Accounts:
   * When an account is new and has 0 resumes uploaded to the LinkedIn server,
   * pauses automation, guides the user via Live Activity to click 'Upload resume',
   * and auto-resumes as soon as the file is attached and recognized.
   */
  private async waitForManualResumeUpload(
    page: any,
    portToSend?: chrome.runtime.Port | null,
    onLiveActivity?: (activity: any) => void,
    jobTitle = 'LinkedIn Job',
    companyName = 'Company',
    primaryTarget?: string,
    altTargets: string[] = [],
    tags: string[] = [],
    timeoutMs = 90000,
  ): Promise<{ selected: boolean; label?: string }> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    const alertMsg =
      '📄 New LinkedIn Account: Please click "Upload resume" in the modal to upload your resume once — JobPilot will auto-resume immediately!';
    this.notifyStatus(portToSend, alertMsg, 'info');
    this.notifyActivity(portToSend, onLiveActivity, {
      jobId: this.activeJobId || 'resume_upload',
      url: '',
      title: jobTitle,
      company: companyName,
      status: 'needs_verification',
      reason: alertMsg,
      creditsUsed: 0,
    });

    while (Date.now() - startTime < timeoutMs) {
      if (!this.isRunning) {
        return { selected: false };
      }

      const aborted = await this.interruptibleSleep(pollIntervalMs);
      if (aborted || !this.isRunning) {
        return { selected: false };
      }

      if (typeof page.selectResumeInModal === 'function') {
        try {
          const res = await page.selectResumeInModal(primaryTarget, altTargets, tags);
          if (res.selected) {
            this.notifyStatus(
              portToSend,
              `✅ Resume uploaded & detected (${res.label || 'Resume'})! Resuming application automatically...`,
              'ok',
            );
            await this.interruptibleSleep(1000);
            return res;
          }
        } catch {}
      }
    }

    this.notifyStatus(
      portToSend,
      '⏳ Resume upload window (90s) expired. Proceeding to discover any form fields...',
      'info',
    );
    return { selected: false };
  }

  /**
   * Tier 2 Fallback: Enriches missing CareerBrain fields from platform page DOM
   * strictly if not already populated in extension (Tier 1 Priority).
   */
  private async enrichMissingCareerBrainFromPlatform(page: any, careerBrain: ICareerBrain): Promise<ICareerBrain> {
    try {
      if (!careerBrain.fullName || !careerBrain.currentTitle) {
        const platformMeta = await page
          .evaluate(() => {
            const meImg = document.querySelector(
              '.global-nav__me-photo, img.feed-identity-module__member-photo',
            ) as HTMLImageElement;
            const nameFromImg = meImg?.alt?.trim() || '';
            const nameEl = document.querySelector(
              '.feed-identity-module__actor-meta a, .identity-headline, .feed-identity-module a',
            ) as HTMLElement;
            const headlineEl = document.querySelector(
              '.identity-headline, .feed-identity-module__headline',
            ) as HTMLElement;
            return {
              name: nameFromImg || nameEl?.innerText?.trim() || '',
              headline: headlineEl?.innerText?.trim() || '',
            };
          })
          .catch(() => null);

        if (platformMeta) {
          if (!careerBrain.fullName && platformMeta.name) {
            careerBrain.fullName = platformMeta.name;
            logger.info(`[DedicatedJobRunner] Tier 2: Enriched missing fullName from platform: "${platformMeta.name}"`);
          }
          if (!careerBrain.currentTitle && platformMeta.headline) {
            careerBrain.currentTitle = platformMeta.headline;
            logger.info(
              `[DedicatedJobRunner] Tier 2: Enriched missing currentTitle from platform: "${platformMeta.headline}"`,
            );
          }
        }
      }
    } catch (enrichErr) {
      logger.warning('[DedicatedJobRunner] Platform enrichment skipped:', enrichErr);
    }
    return careerBrain;
  }

  /**
   * Applies to a single LinkedIn job card in the Split-Pane view,
   * with automatic fallback to direct URL navigation if split-view click is occluded.
   */
  private async applySingleLinkedInJobInSplitPane(
    currentPage: any,
    job: { jobId: string; title: string; company: string; url: string },
    searchPageUrl: string,
    role: string,
    candidateNameSources: string[],
    config: any,
    careerBrain: any,
    runId: string,
    portToSend?: chrome.runtime.Port | null,
    onLiveActivity?: (activity: any) => void,
    stats?: {
      totalFound: number;
      applied: number;
      modalOpened: number;
      skipped: number;
      failed: number;
      skipReasons?: Record<string, number>;
    },
    candidateIndex?: number,
    batchCap?: number,
  ): Promise<{ status: 'applied' | 'skipped' | 'failed' | 'halt'; usedDirectFallback?: boolean }> {
    const jobRunId = `${runId}_${job.jobId}`;
    this.activeJobId = job.jobId;

    // Daily quota: hold a server slot for this job (released if it is skipped or fails)
    const quota = await DailyQuotaManager.reserveApplication(applicationKey(job.jobId, job.url), 'runner');
    if (!quota.allowed) {
      let allowFallback = false;
      if (quota.reason === 'error') {
        const localQuota = await DailyQuotaManager.getQuotaData().catch(() => null);
        const applied = localQuota?.appliedCount ?? 0;
        const maxQ = localQuota?.maxDailyQuota || 10;
        const remaining = maxQ - applied;
        if (remaining > 0 && !localQuota?.isPausedDueToQuota) {
          logger.warning(
            `[DedicatedJobRunner] Server quota verification slow/unavailable for ${job.jobId}; proceeding with local quota fallback (${applied}/${maxQ}).`,
          );
          this.notifyStatus(
            portToSend,
            `⚠️ Server quota check was slow/unavailable. Continuing with local quota (${applied}/${maxQ} used).`,
            'info',
          );
          allowFallback = true;
        }
      }
      if (!allowFallback) {
        const quotaMsg = `🛑 ${quotaStopMessage(quota)} Stopping run.`;
        this.notifyStatus(portToSend, quotaMsg, 'fail');
        return { status: 'halt' };
      }
    }

    // Hard credit budget check (minimum 5 credits to ensure balance for form-filling LLM calls).
    const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
    if (
      !balanceRes?.data?.premiumCovered &&
      balanceRes?.data?.remainingCredits !== undefined &&
      balanceRes.data.remainingCredits < 5
    ) {
      const creditMsg = `🛑 Insufficient credit budget (${balanceRes.data.remainingCredits} remaining, minimum 5 required). Halting run.`;
      this.notifyStatus(portToSend, creditMsg, 'fail');
      return { status: 'halt' };
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
      recordSkip(stats, 'blacklisted (keyword/company)');
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
      return { status: 'skipped' };
    }

    const candidateNumber = candidateIndex || 1;
    const maxGoal = batchCap || 10;
    this.notifyStatus(
      portToSend,
      `💼 Checking candidate job #${candidateNumber} (${stats?.applied || 0}/${maxGoal} applied): "${safeTitle}" (${safeCompany})`,
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

    // 4a. Click Job in Left Pane to Load Details in Right Pane (Split-View)
    let usedDirectFallback = false;
    let clicked = await currentPage.clickJobInSearchList(job.jobId);
    if (!clicked) {
      logger.info(
        `[DedicatedJobRunner] Could not select job card for ${job.jobId} in current search list view. Navigating directly to ${job.url}...`,
      );
      usedDirectFallback = true;
      try {
        if (currentPage.puppeteerPage) {
          await currentPage.puppeteerPage.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        } else if ((currentPage as any).navigateTo) {
          await (currentPage as any).navigateTo(job.url);
        }
      } catch (navErr) {
        logger.warning(`[DedicatedJobRunner] Direct navigation to job URL failed:`, navErr);
      }
      await currentPage.waitForDomSettlement?.(
        '.jobs-unified-top-card, [data-view-name="job-details-top-card"], .jobs-details__main-content',
        { maxWaitMs: 6000 },
      );
    } else {
      if (typeof currentPage.waitForDomSettlement === 'function') {
        await currentPage.waitForDomSettlement(
          '.jobs-search__job-details--container, .jobs-details__main-content, .jobs-unified-top-card, [data-view-name="job-details-top-card"]',
          { maxWaitMs: 5000, quietPeriodMs: 150 },
        );
      } else {
        const waitAborted = await this.interruptibleSleep(1200);
        if (waitAborted || !this.isRunning) return { status: 'halt' };
      }
    }

    // 4b. Pure DOM Top-Card Extraction + Max-3 Retry Guard
    // (generous budget: slow networks / heavy LinkedIn JS often need >10s to render
    // the job details pane; premature failure here caused false "details unavailable" skips)
    let topCard = await currentPage.extractJobTopCardContext(8000);
    let retryCount = 0;
    while (
      (!topCard.title || !topCard.company) &&
      !topCard.isClosed &&
      !topCard.isAlreadyApplied &&
      !topCard.isLoginWall &&
      retryCount < 3
    ) {
      retryCount++;
      this.notifyStatus(portToSend, `Checking job details for ${job.jobId} (attempt ${retryCount}/3)...`, 'info');
      const retrySleepAborted = await this.interruptibleSleep(900);
      if (retrySleepAborted || !this.isRunning) return { status: 'halt' };
      topCard = await currentPage.extractJobTopCardContext(4500);
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
      this.notifyStatus(portToSend, `ℹ️ Skipped "${displayTitle}": Could not load job details from LinkedIn.`, 'info');
      recordSkip(stats, 'job details unavailable');
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
      return { status: 'skipped', usedDirectFallback };
    }

    // 4a-1. Checkpoint Guardian: Inspect for security verification or OTP challenge
    if (typeof currentPage.detectSecurityCheckpoint === 'function') {
      const checkpointCheck = await currentPage.detectSecurityCheckpoint().catch(() => ({ isCheckpoint: false }));
      if (checkpointCheck.isCheckpoint) {
        const chkRes = await this.waitForManualCheckpointResolution(currentPage, portToSend, onLiveActivity);
        if (chkRes.aborted || !this.isRunning) return { status: 'halt' };
        if (!chkRes.solved) {
          recordSkip(stats, 'security checkpoint unresolved');
          return { status: 'skipped', usedDirectFallback };
        }
      }
    }

    // 4b. Pure DOM 0-Credit Skip Checks
    if (topCard.isClosed) {
      this.notifyStatus(
        portToSend,
        `ℹ️ Skipped "${displayTitle}": This job is closed and no longer accepting applications.`,
        'info',
      );
      recordSkip(stats, 'job closed');
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
      return { status: 'skipped', usedDirectFallback };
    }

    if (topCard.isAlreadyApplied) {
      this.notifyStatus(
        portToSend,
        `ℹ️ Skipped "${displayTitle}": You already applied to this job earlier on LinkedIn.`,
        'info',
      );
      recordSkip(stats, 'already applied on LinkedIn');
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
      return { status: 'skipped', usedDirectFallback };
    }

    if (!topCard.hasEasyApply) {
      this.notifyStatus(
        portToSend,
        `ℹ️ Skipped "${displayTitle}": Requires applying directly on company website (not Easy Apply).`,
        'info',
      );
      recordSkip(stats, 'no Easy Apply (external site)');
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
      return { status: 'skipped', usedDirectFallback };
    }

    // 4b-1. Post-Load Blacklist & Negative Keyword Check
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
      recordSkip(stats, 'blacklisted (post-load)');
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
      return { status: 'skipped', usedDirectFallback };
    }

    // 4c. Pre-Apply Skill Relevance Check (0 LLM credits)
    const relevance = checkJobSkillRelevance(displayTitle, topCard.descriptionSnippet, careerBrain, role);
    if (!relevance.relevant) {
      this.notifyStatus(
        portToSend,
        `ℹ️ Skipped "${displayTitle}": Required skills do not closely match your profile.`,
        'info',
      );
      recordSkip(stats, 'low skill match');
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
      return { status: 'skipped', usedDirectFallback };
    }

    // Tier-2 Deep JD Relevance & Match Score Threshold Check
    const minScoreThreshold =
      typeof config.minFitScore === 'number' && config.minFitScore > 0 ? config.minFitScore : 50;
    const maxExpGap = config.maxExperienceGapYears ?? 3;
    let deepMatch = evaluateDeepRelevance(
      topCard.descriptionSnippet || '',
      careerBrain,
      role,
      minScoreThreshold,
      maxExpGap,
      displayTitle,
    );

    // Borderline arbitration: scores in the 40-60 band are often false negatives of the
    // deterministic keyword ratio. A single scoped-LLM judgement call re-decides before
    // we burn the job opportunity on a wrong skip.
    let arbitrationUsed = false;
    if (deepMatch.recommendation === 'skip' && deepMatch.score >= 40 && deepMatch.score <= 60) {
      const arbitrationLLM = await getJobScopedLLM(jobRunId).catch(() => undefined);
      if (arbitrationLLM) {
        const arbitrated = await arbitrateBorderlineRelevance(
          arbitrationLLM,
          displayTitle,
          topCard.descriptionSnippet || '',
          careerBrain,
        ).catch(() => null);
        if (arbitrated) {
          arbitrationUsed = true;
          logger.info(
            `[DedicatedJobRunner] Borderline arbitration for "${displayTitle}" (deterministic score ${deepMatch.score}): ${
              arbitrated.recommendation === 'apply' ? 'OVERRIDDEN -> apply' : 'CONFIRMED skip'
            }`,
          );
          deepMatch = { ...deepMatch, ...arbitrated };
        }
      }
    }

    if (deepMatch.recommendation === 'skip') {
      if (arbitrationUsed) {
        // The arbitration call was billed against this jobRunId; refund it like any
        // other skipped job so a borderline judgement never costs the user credits.
        await backendApiClient.refundCredits(jobRunId).catch(err => {
          const errMsg = String(err?.message || err);
          if (/no billable usage|run_not_found|already_refunded/i.test(errMsg)) {
            logger.debug(`[DedicatedJobRunner] No billable usage to refund for ${jobRunId}.`);
          } else {
            logger.info(`[DedicatedJobRunner] Refund note for ${jobRunId}: ${errMsg}`);
          }
        });
      }
      logger.info(`[DedicatedJobRunner] Deep JD evaluation skipped "${displayTitle}": ${deepMatch.reason}`);
      this.notifyStatus(portToSend, `ℹ️ Skipped "${displayTitle}": ${deepMatch.reason}`, 'info');
      recordSkip(stats, 'fit score below threshold');
      await processedJobsStore.recordJob({
        jobId: job.jobId,
        url: job.url,
        title: displayTitle,
        company: displayCompany,
        location: topCard.location,
        platform: 'linkedin',
        fitScore: deepMatch.score,
        status: 'skipped',
        reason: deepMatch.reason,
        creditsUsed: 0,
      });
      this.notifyActivity(portToSend, onLiveActivity, {
        jobId: job.jobId,
        url: job.url,
        title: displayTitle,
        company: displayCompany,
        status: 'skipped',
        reason: deepMatch.reason.length > 40 ? `Match ${deepMatch.score}% < ${minScoreThreshold}%` : deepMatch.reason,
        creditsUsed: 0,
      });
      return { status: 'skipped', usedDirectFallback };
    }

    // 4d. Click Easy Apply & Verify Modal Opens
    this.notifyStatus(portToSend, `🚀 Opening Easy Apply for "${displayTitle}"...`, 'info');
    let clickRes = await currentPage.clickEasyApplyButton();
    logger.info(`[DedicatedJobRunner] clickEasyApplyButton attempt 1:`, clickRes);
    if (!clickRes.success) {
      logger.warning(`[DedicatedJobRunner] Easy Apply click attempt 1 failed (${clickRes.error}). Retrying...`);
      const clickSleepAborted = await this.interruptibleSleep(1200);
      if (clickSleepAborted || !this.isRunning) return { status: 'halt' };
      clickRes = await currentPage.clickEasyApplyButton();
      logger.info(`[DedicatedJobRunner] clickEasyApplyButton attempt 2:`, clickRes);
    }

    // Check immediately for LinkedIn rate limit
    if (typeof currentPage.detectPlatformRateLimit === 'function') {
      const rateCheck = await currentPage
        .detectPlatformRateLimit()
        .catch(() => ({ isLimited: false as const, reason: undefined }));
      if (rateCheck.isLimited) {
        const limitMsg = `🛑 LinkedIn Application Limit Reached: ${rateCheck.reason || 'Maximum Easy Apply limit reached for today/week'}. Pausing auto-apply run cleanly.`;
        logger.error(`[DedicatedJobRunner] ${limitMsg}`);
        this.notifyStatus(portToSend, limitMsg, 'fail');
        this.notifyActivity(portToSend, onLiveActivity, {
          jobId: job.jobId,
          url: job.url,
          title: displayTitle,
          company: displayCompany,
          status: 'skipped',
          reason: limitMsg,
          creditsUsed: 0,
        });
        this.isRunning = false;
        return { status: 'halt' };
      }
    }

    // Poll for modal with generous timeout. The 2025 native-<dialog> UI can paint its
    // shell (and accept the click) well before the first step's controls exist.
    let modalRes = await currentPage.waitForEasyApplyModal(15000, 300);
    logger.info(`[DedicatedJobRunner] waitForEasyApplyModal result:`, modalRes);
    let retryClickRes: { success: boolean; error?: string; diagnostics?: string } | null = null;
    if (!modalRes.opened) {
      // Re-check rate limit dialog
      if (typeof currentPage.detectPlatformRateLimit === 'function') {
        const rateCheck = await currentPage
          .detectPlatformRateLimit()
          .catch(() => ({ isLimited: false as const, reason: undefined }));
        if (rateCheck.isLimited) {
          const limitMsg = `🛑 LinkedIn Application Limit Reached: ${rateCheck.reason || 'Maximum Easy Apply limit reached for today/week'}. Pausing auto-apply run cleanly.`;
          logger.error(`[DedicatedJobRunner] ${limitMsg}`);
          this.notifyStatus(portToSend, limitMsg, 'fail');
          this.notifyActivity(portToSend, onLiveActivity, {
            jobId: job.jobId,
            url: job.url,
            title: displayTitle,
            company: displayCompany,
            status: 'skipped',
            reason: limitMsg,
            creditsUsed: 0,
          });
          this.isRunning = false;
          return { status: 'halt' };
        }
      }

      // Retry click once
      logger.warning(`[DedicatedJobRunner] Modal did not open on first attempt. Retrying click...`);
      const modalSleepAborted = await this.interruptibleSleep(1200);
      if (modalSleepAborted || !this.isRunning) return { status: 'halt' };
      retryClickRes = await currentPage.clickEasyApplyButton();
      logger.info(`[DedicatedJobRunner] clickEasyApplyButton retry (after modal miss):`, retryClickRes);
      modalRes = await currentPage.waitForEasyApplyModal(15000, 300);
    }

    // 4d. Handle Modal Form-Filling & Verified Submission
    if (modalRes.opened) {
      if (stats) stats.modalOpened++;
      this.notifyStatus(portToSend, `📝 Application form opened: Filling your details...`, 'info');
      const fillRes = await this.fillAndSubmitModal(
        currentPage,
        { ...job, title: displayTitle, company: displayCompany },
        jobRunId,
        portToSend,
        onLiveActivity,
      );

      if (fillRes.success) {
        if (stats) stats.applied++;
        await DailyQuotaManager.commitApplication(applicationKey(job.jobId, job.url));
        await queueSafetyStore.setSingleApplyVerified(true);
        const successMsg = `Applied to "${displayTitle}" at ${displayCompany || 'company'} successfully! 🎉`;
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
        return { status: 'applied', usedDirectFallback };
      } else {
        const skipReason = fillRes.reason || 'Form filling could not be completed';
        recordSkip(stats, bucketFillFailureReason(skipReason));
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
        return { status: 'skipped', usedDirectFallback };
      }
    } else {
      if (stats) stats.failed++;
      const lastClickDiag = retryClickRes?.diagnostics || clickRes?.diagnostics;
      // Capture what the page actually showed at timeout so the next report is not guesswork.
      const failSnap = await currentPage.captureModalSnapshot().catch(() => null);
      const failDom = failSnap
        ? `dom=${failSnap.modalTag || 'none'} inputs=${failSnap.inputsCount} selects=${failSnap.selectsCount} buttons=${(
            failSnap.buttonTexts || []
          )
            .slice(0, 4)
            .join('/')}`
        : 'dom=unavailable';
      logger.warning(`[DedicatedJobRunner] Modal-open diagnostics for "${displayTitle}": ${failDom}`);
      const failReason = [
        modalRes.error || clickRes.error || 'Easy Apply modal failed to open within timeout',
        lastClickDiag,
        failDom,
      ]
        .filter(Boolean)
        .join(' | ');
      logger.error(
        `[DedicatedJobRunner] Easy Apply modal failed for "${displayTitle}". Click diagnostics: ${lastClickDiag || 'none collected'}`,
      );
      this.notifyStatus(
        portToSend,
        `⚠️ Could not open Easy Apply for "${displayTitle}".${lastClickDiag ? ' ' + lastClickDiag.slice(0, 240) : ''}`,
        'fail',
      );

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
      return { status: 'failed', usedDirectFallback };
    }
  }

  private async fillAndSubmitModal(
    page: any,
    job: { jobId: string; title: string; company: string; url: string },
    jobRunId: string,
    portToSend?: chrome.runtime.Port | null,
    onLiveActivity?: (activity: any) => void,
  ): Promise<{ success: boolean; reason?: string }> {
    let careerBrain = await careerBrainStore.getCareerBrain();
    careerBrain = await this.enrichMissingCareerBrainFromPlatform(page, careerBrain);
    const scopedLLM = await getJobScopedLLM(jobRunId);

    // Central answer-format adapter: LLM/rule answers must be normalized to the field's
    // expected format (digits for numeric/salary questions, exact options for radios)
    // before they reach the DOM — LinkedIn rejects formatted strings with "Invalid input".
    const fillAnswerWithFormat = async (field: FormFieldDescriptor, answer: string): Promise<boolean> => {
      const adapted = adaptAnswerToFieldFormat(answer, field);
      return page.fillModalFieldDirect(field, adapted.valid ? adapted.value : answer);
    };

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

    // Shared eligibility flags used by the draft-resume auto-upload logic below
    const hasNoStoredResume = candidateResumes.length === 0 && !careerBrain.resumeFileName;
    const hasProfileData =
      Boolean(careerBrain.fullName?.trim()) &&
      ((careerBrain.resumeText || '').trim().length >= 50 ||
        (Array.isArray(careerBrain.workExperience) && careerBrain.workExperience.length > 0) ||
        (Array.isArray(careerBrain.skills) && careerBrain.skills.length > 0));

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
    const maxSteps = 15;
    let submitted = false;

    // Stuck-step guards: detect when LinkedIn silently rejects Next/Review clicks
    // (modal neither advances nor exposes fields/buttons) and fail fast with a
    // diagnostic snapshot instead of burning all 15 steps on a treadmill.
    let stuckStreak = 0;
    let lastIterationSignature: string | null = null;
    let uploadAttempted = false;
    let fieldsZeroStreak = 0;

    // Loop-prevention guards: limit repeat attempts on individual fields and modal steps
    const fieldAttemptCounts = new Map<string, number>();
    const MAX_FIELD_ATTEMPTS = 6;
    const stepRetryCounts = new Map<number, number>();
    const MAX_STEP_RETRIES = 4;

    // A document/resume step blocks on an <input type="file"> that the field extractor
    // ignores and an LLM answer can never satisfy. Generate the draft resume PDF and
    // upload it once per job. Returns true only when a file was actually attached.
    const tryUploadDraftResume = async (liveMessage: string): Promise<boolean> => {
      if (uploadAttempted || !hasNoStoredResume || !hasProfileData) return false;
      try {
        const draftFileName = buildDraftResumeFileName(careerBrain);
        const draftPdf = buildDraftResumePdf(careerBrain);
        const draftB64 = bytesToBase64(draftPdf);
        this.notifyStatus(portToSend, liveMessage, 'info');
        const uploaded = await page.uploadResumeDraftFile(draftFileName, draftB64);
        if (!uploaded) return false;
        uploadAttempted = true;
        await new Promise(r => setTimeout(r, 1500));
        return true;
      } catch (uploadErr: any) {
        logger.warning(`[DedicatedJobRunner] Draft resume upload failed: ${uploadErr?.message || uploadErr}`);
        return false;
      }
    };

    const checkFieldRepeat = (fieldDesc: FormFieldDescriptor): boolean => {
      const key = `${(fieldDesc.label || '').trim().toLowerCase()}:::${fieldDesc.fieldType || 'text'}`;
      const current = (fieldAttemptCounts.get(key) || 0) + 1;
      fieldAttemptCounts.set(key, current);
      if (current > MAX_FIELD_ATTEMPTS) {
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

      // 0. Check for security checkpoint or OTP challenge during modal filling
      if (typeof page.detectSecurityCheckpoint === 'function') {
        const stepCheckpoint = await page.detectSecurityCheckpoint().catch(() => ({ isCheckpoint: false }));
        if (stepCheckpoint.isCheckpoint) {
          const chkRes = await this.waitForManualCheckpointResolution(page, portToSend, onLiveActivity);
          if (chkRes.aborted || !this.isRunning) {
            return { success: false, reason: 'Application stopped during security verification' };
          }
          if (!chkRes.solved) {
            return { success: false, reason: 'Security checkpoint encountered and not resolved within window' };
          }
        }
      }

      // 1. Check if application was already confirmed sent
      const preCheck = await page.verifyApplicationConfirmation();
      if (preCheck.confirmed) {
        submitted = true;
        break;
      }

      // 1b. Smart Resume Auto-Select on resume selection screen (Multi-Tier Ground Truth Match)
      if (typeof page.selectResumeInModal === 'function') {
        try {
          const primaryTarget =
            careerBrain.resumes?.find(r => r.isDefault)?.fileName || careerBrain.resumeFileName || bestResume?.fileName;
          const altTargets = (candidateResumes || []).map(r => r.fileName);
          const resSel = await page.selectResumeInModal(
            primaryTarget,
            altTargets,
            bestResume?.focusTags || careerBrain.skills || [],
          );
          if (resSel.selected) {
            onAuditLog('MATCHED', 'Resume Selected in Form', primaryTarget || 'Resume', resSel.label);
          } else if (resSel.needsFileUpload) {
            logger.info(
              '[DedicatedJobRunner] New account detected (0 resumes on LinkedIn server). Waiting for manual resume upload...',
            );
            const uploadRes = await this.waitForManualResumeUpload(
              page,
              portToSend,
              onLiveActivity,
              job.title,
              job.company,
              primaryTarget,
              altTargets,
              bestResume?.focusTags || careerBrain.skills || [],
            );
            if (uploadRes.selected) {
              onAuditLog('MATCHED', 'Resume Uploaded & Selected', primaryTarget || 'Resume', uploadRes.label);
            }
          }
        } catch (selErr) {
          logger.warning('[DedicatedJobRunner] selectResumeInModal non-blocking warning:', selErr);
        }
      }

      // Progressive scroll down and top to force dynamic rendering of all form inputs in the modal
      if (typeof page.scrollModalContent === 'function') {
        await page.scrollModalContent('down');
        await new Promise(r => setTimeout(r, 200));
        await page.scrollModalContent('top');
        await new Promise(r => setTimeout(r, 200));
      }

      // 2. Discover interactive form fields on current step
      let fields = await page.discoverModalFormFields();
      if (fields.length === 0) {
        // LinkedIn re-renders the step body just after the Next/Review transition.
        // Re-scan once so a transient mid-render DOM isn't mistaken for an empty step.
        await new Promise(r => setTimeout(r, 450));
        fields = await page.discoverModalFormFields();
        if (fields.length > 0) {
          logger.info(`[DedicatedJobRunner] Step ${step}: form fields appeared on re-scan (${fields.length} found).`);
        }
      }
      if (fields.length > 0) {
        fieldsZeroStreak = 0;
        this.notifyStatus(
          portToSend,
          `✨ Step ${step}: Answering ${fields.length} question${fields.length > 1 ? 's' : ''} (preserving pre-filled fields)...`,
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

          // Rule: If field is already filled and has no validation error, preserve its value and do not overwrite!
          const hasCurrentValue =
            Boolean(field.currentValue && String(field.currentValue).trim().length > 0) &&
            field.currentValue !== 'Select an option' &&
            field.currentValue !== '--' &&
            field.currentValue !== 'Select';

          if (hasCurrentValue && !field.errorText) {
            logger.info(
              `[DedicatedJobRunner] Preserving already-filled field "${field.label}": "${field.currentValue}"`,
            );
            continue;
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
          await new Promise(r => setTimeout(r, 500));
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
                  await fillAnswerWithFormat(singleField, autoSol.answer);
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
                  await fillAnswerWithFormat(singleField, autoSol.answer);
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
                      const fillSuccess = await fillAnswerWithFormat(f, autoSol.answer);
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

      // Scroll modal content to bottom so lower fields and checkboxes are visible & reachable
      if (typeof page.scrollModalContent === 'function') {
        await page.scrollModalContent('bottom');
        await new Promise(r => setTimeout(r, 250));
      }

      // 3. Pre-advance validation check (checks required empty fields & aria-invalid)
      let validation = await page.validateModalFormState();

      // Guard against unfulfillable mandatory file uploads (Resume, Cover Letter, Portfolio, Custom Certificate)
      if (validation.unfulfilledMandatoryFileUpload) {
        const docType = validation.unfulfilledMandatoryFileUpload.documentType;
        const docLabel = validation.unfulfilledMandatoryFileUpload.label;

        // Draft Resume v2: employer mandates a Resume upload but the candidate has no stored
        // resume file configured. Auto-generate a truthful PDF from careerBrain data and upload
        // it in-memory so the application can proceed instead of skipping.
        if (docType === 'Resume' && hasNoStoredResume && hasProfileData) {
          try {
            const draftFileName = buildDraftResumeFileName(careerBrain);
            const draftPdf = buildDraftResumePdf(careerBrain);
            const draftB64 = bytesToBase64(draftPdf);
            logger.info(
              `[DedicatedJobRunner] Mandatory Resume upload required ("${docLabel}"). No stored resume file - auto-generating draft "${draftFileName}" (${draftPdf.length} bytes)...`,
            );
            this.notifyStatus(
              portToSend,
              `📄 No resume file on file - auto-generating "${draftFileName}" from your profile for this application...`,
              'info',
            );
            const uploaded = await page.uploadResumeDraftFile(draftFileName, draftB64);
            if (uploaded) {
              this.notifyStatus(portToSend, `✅ Draft resume uploaded successfully. Re-checking form...`, 'info');
              // Re-validate; a successful upload clears the mandatory-upload gap
              validation = await page.validateModalFormState();
              if (!validation.unfulfilledMandatoryFileUpload) {
                logger.info(
                  `[DedicatedJobRunner] Draft resume upload satisfied the mandatory Resume requirement. Continuing application flow.`,
                );
              }
              // Fall through to the normal fill flow below
            } else {
              logger.warning(
                `[DedicatedJobRunner] Draft resume upload failed for job ${job.jobId}. Skipping cleanly to preserve credits.`,
              );
              this.notifyStatus(
                portToSend,
                `⚠️ Auto-generated resume upload failed for "${docLabel}". Skipping this job to preserve credits...`,
                'info',
              );
              this.notifyActivity(portToSend, onLiveActivity, {
                jobId: job.jobId,
                url: job.url,
                title: job.title,
                company: job.company,
                status: 'skipped',
                reason: 'Auto-generated resume upload failed',
                creditsUsed: 0,
              });
              await page.dismissEasyApplyModal(4000);
              return { success: false, reason: 'Auto-generated resume upload failed' };
            }
          } catch (err: any) {
            logger.warning(
              `[DedicatedJobRunner] Draft resume auto-upload error for job ${job.jobId}: ${err?.message || err}`,
            );
            this.notifyStatus(
              portToSend,
              `⚠️ Auto-generated resume upload failed for "${docLabel}". Skipping this job to preserve credits...`,
              'info',
            );
            this.notifyActivity(portToSend, onLiveActivity, {
              jobId: job.jobId,
              url: job.url,
              title: job.title,
              company: job.company,
              status: 'skipped',
              reason: 'Auto-generated resume upload failed',
              creditsUsed: 0,
            });
            await page.dismissEasyApplyModal(4000);
            return { success: false, reason: 'Auto-generated resume upload failed' };
          }
        }

        // If the upload didn't resolve it (or docType !== 'Resume'), clean-skip
        if (validation.unfulfilledMandatoryFileUpload) {
          logger.warning(
            `[DedicatedJobRunner] Unfulfilled mandatory file upload detected: ${docType} ("${docLabel}"). Candidate has no matching file configured.`,
          );
          this.notifyStatus(
            portToSend,
            `⚠️ Mandatory ${docType} required by employer ("${docLabel}"), but no document is configured. Skipping cleanly to preserve credits...`,
            'info',
          );
          this.notifyActivity(portToSend, onLiveActivity, {
            jobId: job.jobId,
            url: job.url,
            title: job.title,
            company: job.company,
            status: 'skipped',
            reason: `Mandatory ${docType} required by employer`,
            creditsUsed: 0,
          });
          await page.dismissEasyApplyModal(4000);
          return {
            success: false,
            reason: `Mandatory ${docType} required by recruiter`,
          };
        }
      }

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
            await new Promise(r => setTimeout(r, 500));
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
                    await fillAnswerWithFormat(singleReq, autoSol.answer);
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
                        const fillSuccess = await fillAnswerWithFormat(f, autoSol.answer);
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
          // If there are explicit red alert errors or invalid fields with errors, heal them with LLM immediately!
          const invalidFieldsToHeal = recheck.invalidFieldsWithErrors || [];
          if (invalidFieldsToHeal.length > 0) {
            logger.info(
              `[DedicatedJobRunner] Detected ${invalidFieldsToHeal.length} fields with red alert validation errors. Healing with LLM...`,
            );
            for (const invF of invalidFieldsToHeal) {
              if (!checkFieldRepeat(invF as any)) {
                return {
                  success: false,
                  reason: `Validation auto-heal field "${invF.label}" repeated ${MAX_FIELD_ATTEMPTS} times (validation loop detected)`,
                };
              }
              try {
                this.notifyStatus(
                  portToSend,
                  `🤖 Fixing validation error for "${invF.label}": "${invF.errorText}" (was "${invF.currentValue}")...`,
                  'info',
                );
                const healed = await solveValidationErrorWithLLM(invF, careerBrain, scopedLLM);
                if (healed.success && healed.answer !== undefined) {
                  const adapted = adaptAnswerToFieldFormat(healed.answer, invF as any);
                  const fillVal = adapted.valid ? adapted.value : healed.answer;
                  const fillSuccess = await page.fillModalFieldDirect(invF, fillVal);
                  onAuditLog(
                    'GENERATED',
                    invF.label,
                    fillVal,
                    `Red alert validation heal | Prev: "${invF.currentValue}" | Error: "${invF.errorText}" | Fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                  );
                }
              } catch (healErr) {
                logger.warning(`[DedicatedJobRunner] Failed to heal field "${invF.label}":`, healErr);
              }
            }
          }

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
                // If it has an active red alert error, prioritize solveValidationErrorWithLLM
                if (reqF.errorText) {
                  const healed = await solveValidationErrorWithLLM(reqF, careerBrain, scopedLLM);
                  if (healed.success && healed.answer !== undefined) {
                    const adapted = adaptAnswerToFieldFormat(healed.answer, reqF);
                    const fillVal = adapted.valid ? adapted.value : healed.answer;
                    const fillSuccess = await page.fillModalFieldDirect(reqF, fillVal);
                    onAuditLog(
                      'GENERATED',
                      reqF.label,
                      fillVal,
                      `Red alert validation heal | Fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                    );
                    continue;
                  }
                }

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
          if (typeof page.scrollModalContent === 'function') {
            await page.scrollModalContent('bottom');
            await new Promise(r => setTimeout(r, 200));
          }
          const testActions = await page.getModalActionButtons();
          if (testActions.hasNext || testActions.hasReview) {
            logger.info(
              `[DedicatedJobRunner] Attempting forward click to see if modal advances despite validation warnings...`,
            );
            const testAdvance = await page.clickModalForwardButton();
            if (testAdvance.clicked) {
              if (typeof page.waitForDomSettlement === 'function') {
                await page.waitForDomSettlement();
              } else {
                await new Promise(r => setTimeout(r, 1200));
              }
              const postAdvanceCheck = await page.validateModalFormState();
              if (!postAdvanceCheck.hasErrors || postAdvanceCheck.emptyRequiredFields.length === 0) {
                continue; // Modal advanced successfully!
              }
              // Self-heal form validation errors via DOM heuristics
              const healing = await inspectAndHealFormErrors(page, '.jobs-easy-apply-modal');
              if (healing.correctedCount > 0) {
                logger.info(
                  `[DedicatedJobRunner] Self-healed ${healing.correctedCount} validation errors in modal. Re-clicking forward...`,
                );
                await page.clickModalForwardButton();
                if (typeof page.waitForDomSettlement === 'function') {
                  await page.waitForDomSettlement();
                } else {
                  await new Promise(r => setTimeout(r, 1200));
                }
                continue;
              }

              // Also try LLM-based healing on remaining invalid fields
              if (postAdvanceCheck.invalidFieldsWithErrors && postAdvanceCheck.invalidFieldsWithErrors.length > 0) {
                for (const invF of postAdvanceCheck.invalidFieldsWithErrors) {
                  const healed = await solveValidationErrorWithLLM(invF, careerBrain, scopedLLM);
                  if (healed.success && healed.answer) {
                    const adapted = adaptAnswerToFieldFormat(healed.answer, invF as any);
                    const fillVal = adapted.valid ? adapted.value : healed.answer;
                    await page.fillModalFieldDirect(invF, fillVal);
                  }
                }
                await page.clickModalForwardButton();
                if (typeof page.waitForDomSettlement === 'function') {
                  await page.waitForDomSettlement();
                } else {
                  await new Promise(r => setTimeout(r, 1200));
                }
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
      } else {
        // No interactive inputs found on this step - modal may be on a non-question
        // page (resume selection/upload, review, etc.) which is handled via action buttons below.
        fieldsZeroStreak++;
        const zeroSnap = await page.captureModalSnapshot().catch(() => null);
        logger.warning(
          `[DedicatedJobRunner] Step ${step}: No form fields discovered (fields-zero streak ${fieldsZeroStreak}). Modal inventory: ${JSON.stringify(zeroSnap)}`,
        );
        if (zeroSnap) {
          const compact = [
            `modal=${zeroSnap.modalTag || '?'}`,
            `inputs=${zeroSnap.inputsCount} selects=${zeroSnap.selectsCount} fieldsets=${zeroSnap.fieldsetsCount}`,
            `iframes=${zeroSnap.iframesCount} spinners=${zeroSnap.spinnersCount} shadowHosts=${zeroSnap.shadowHosts} shadowInputs=${zeroSnap.shadowInputs}`,
          ].join(' | ');
          this.notifyStatus(portToSend, `🧐 Step ${step}: zero form fields found. ${compact}`, 'info');
        } else if (fieldsZeroStreak === 1) {
          // The modal was reported open by waitForEasyApplyModal but every helper
          // (discovery/snapshot/action buttons) failed to locate its container.
          logger.error(
            `[DedicatedJobRunner] Step ${step}: Easy Apply modal is open but its container was not found in the DOM.`,
          );
          this.notifyStatus(
            portToSend,
            `⚠️ Step ${step}: Easy Apply modal is open but its form container was not found in the DOM. Retrying...`,
            'info',
          );
        }

        // Zero descriptors does NOT mean an empty step. discoverModalFormFields() skips
        // controls that already carry a value, so a fully pre-filled contact step reports
        // 0 fields while the modal is healthy and only needs Next/Review. It can also be a
        // transient React re-render where the body is momentarily detached.
        const zeroControls = zeroSnap
          ? zeroSnap.inputsCount + zeroSnap.selectsCount + zeroSnap.contenteditableCount
          : 0;
        const zeroButtons = (zeroSnap?.buttonTexts || []).join(' | ');
        const zeroHasForward = /next|review|submit|continue/i.test(zeroButtons);

        // A resume-upload step hides its requirement in an <input type="file">, which the
        // field extractor ignores by design and which an LLM "FILL" action can never
        // satisfy. Run the existing draft-resume upload immediately instead of waiting
        // for the stuck-step guard to reach its third failure.
        if (zeroSnap?.hasFileInput) {
          const uploaded = await tryUploadDraftResume('📄 Uploading a draft resume to satisfy this document step...');
          if (uploaded) {
            fieldsZeroStreak = 0;
            stuckStreak = 0;
            lastIterationSignature = null;
            continue;
          }
        }

        // Healthy form with every visible control already answered, or an advanced step
        // whose footer is present: skip the LLM entirely and let the action-button flow
        // below advance. Only a modal with no controls AND no forward button is a true
        // dead end worth asking the LLM about.
        if (zeroControls > 0 || zeroHasForward) {
          logger.info(
            `[DedicatedJobRunner] Step ${step}: zero unanswered fields but ${zeroControls} control(s) / forward=${
              zeroHasForward ? 'yes' : 'no'
            } present — skipping LLM step analysis and advancing.`,
          );
          if (zeroControls > 0) fieldsZeroStreak = 0;
        } else if (zeroSnap) {
          // Give a slow first render a chance before spending LLM tokens. New LinkedIn UI
          // paints the native <dialog> shell before its fields exist.
          await new Promise(r => setTimeout(r, 900));
          const retrySnap = await page.captureModalSnapshot().catch(() => null);
          const retryControls = retrySnap
            ? retrySnap.inputsCount + retrySnap.selectsCount + retrySnap.contenteditableCount
            : 0;
          const retryHasForward = /next|review|submit|continue/i.test((retrySnap?.buttonTexts || []).join(' | '));
          if (retryControls > 0 || retryHasForward || retrySnap?.hasFileInput) {
            logger.info(
              `[DedicatedJobRunner] Step ${step}: modal content appeared after ${900}ms re-check (controls=${retryControls}, forward=${retryHasForward}) — retrying step.`,
            );
            fieldsZeroStreak = Math.max(0, fieldsZeroStreak - 1);
            lastIterationSignature = null;
            continue;
          }
        }

        // LLM modal-step brain: only reached when the modal genuinely has no controls and
        // no Next/Review/Submit control, so SKIP cannot discard a healthy prefilled step.
        // Limited to the first 2 zero-field steps to keep token cost bounded.
        if (zeroSnap && fieldsZeroStreak <= 2 && zeroControls === 0 && !zeroHasForward) {
          try {
            const analysis = await analyzeModalStepWithLLM(
              {
                title: zeroSnap.title,
                textSnippet: zeroSnap.textSnippet,
                buttonTexts: zeroSnap.buttonTexts,
                inputsCount: zeroSnap.inputsCount,
                selectsCount: zeroSnap.selectsCount,
                fieldsetsCount: zeroSnap.fieldsetsCount,
                contenteditableCount: zeroSnap.contenteditableCount,
                iframesCount: zeroSnap.iframesCount,
                spinnersCount: zeroSnap.spinnersCount,
                shadowHosts: zeroSnap.shadowHosts,
                shadowInputs: zeroSnap.shadowInputs,
                outerHtmlSnippet: zeroSnap.outerHtmlSnippet,
              },
              careerBrain,
              scopedLLM,
            );
            if (analysis) {
              this.notifyStatus(
                portToSend,
                `🤖 LLM step analysis: ${analysis.action}${analysis.reason ? ' — ' + analysis.reason : ''}`,
                'info',
              );
              if (analysis.action === 'FILL' && analysis.fields && analysis.fields.length > 0) {
                for (const f of analysis.fields) {
                  const fillOk = await page.fillModalFieldDirect({ label: f.label }, f.answer);
                  logger.info(
                    `[DedicatedJobRunner] LLM-guided fill "${f.label}" = "${f.answer}": ${fillOk ? 'OK' : 'FAILED'}`,
                  );
                }
                await new Promise(r => setTimeout(r, 400));
              } else if (analysis.action === 'SUBMIT') {
                const subRes = await page.submitApplication();
                if (subRes.clicked) {
                  const confirmRes = await page.verifySubmissionConfirmation(8000);
                  if (confirmRes.confirmed) {
                    submitted = true;
                    break;
                  }
                }
              } else if (analysis.action === 'SKIP') {
                // Never let a skip verdict win over a live form: the step may have rendered
                // between the snapshot and the LLM response (the exact false-skip that used
                // to report "modal with no input fields" on a filled contact step).
                if (zeroControls > 0 || zeroHasForward) {
                  logger.warning(
                    `[DedicatedJobRunner] Ignoring LLM SKIP on step ${step}: snapshot still shows ${zeroControls} control(s) / forward=${zeroHasForward}. Advancing instead.`,
                  );
                } else {
                  return {
                    success: false,
                    reason: analysis.reason || 'LLM determined this step cannot be handled',
                  };
                }
              }
              // ADVANCE: fall through to the normal action-button flow below
            }
          } catch (llmErr) {
            logger.warning(`[DedicatedJobRunner] LLM modal-step analysis error:`, llmErr);
          }
        }
      }

      // Step par information bharne / verify karne ke baad, container ko scroll karke
      // bilkul bottom par le jayein taaki footer action buttons (Next/Review/Submit)
      // fully in-view aur clickable ho sakein.
      if (typeof page.scrollModalContent === 'function') {
        await page.scrollModalContent('bottom');
        await new Promise(r => setTimeout(r, 250));
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
        if (typeof page.scrollModalContent === 'function') {
          await page.scrollModalContent('bottom');
          await new Promise(r => setTimeout(r, 200));
        }

        // Capture the step signature BEFORE clicking so we can verify the modal actually advanced.
        // LinkedIn may silently swallow clicks on React-state-disabled Next/Review buttons, so a
        // "clicked" result alone is not proof that the step changed.
        const sigBefore =
          typeof page.getModalStepSignature === 'function'
            ? await page.getModalStepSignature().catch(() => null)
            : null;

        let fwdRes = await page.clickModalForwardButton();
        if (!fwdRes.clicked) {
          logger.warning(
            '[DedicatedJobRunner] Forward button click was not accepted (may be disabled). Inspecting and healing form errors...',
          );
          await inspectAndHealFormErrors(page, '.jobs-easy-apply-modal');
          if (typeof page.scrollModalContent === 'function') {
            await page.scrollModalContent('bottom');
          }
          await new Promise(r => setTimeout(r, 400));
          fwdRes = await page.clickModalForwardButton();
        }

        if (!fwdRes.clicked) {
          const preRetryValidation = await page.validateModalFormState();
          if (preRetryValidation.hasErrors && scopedLLM) {
            for (const reqF of preRetryValidation.emptyRequiredFields) {
              const autoSol = await solveQuestionAutonomousWithLLM(reqF, careerBrain, scopedLLM);
              if (autoSol.success && autoSol.answer) {
                const adapted = adaptAnswerToFieldFormat(autoSol.answer, reqF);
                const fillVal = adapted.valid ? adapted.value : autoSol.answer;
                await page.fillModalFieldDirect(reqF, fillVal);
              }
            }
            if (typeof page.scrollModalContent === 'function') {
              await page.scrollModalContent('bottom');
            }
            fwdRes = await page.clickModalForwardButton();
          }
        }

        if (!fwdRes.clicked) {
          return {
            success: false,
            reason: 'Failed to advance to next modal step',
          };
        }
        if (typeof page.waitForDomSettlement === 'function') {
          await page.waitForDomSettlement();
        } else {
          await new Promise(r => setTimeout(r, 1200));
        }

        // Verify the modal ACTUALLY advanced. If the step content is unchanged, LinkedIn rejected
        // the click (Next/Review disabled via React state). Heal the real validation errors it just
        // surfaced, retry once; if still blocked, fail fast and preserve the draft instead of
        // burning all 15 steps on a treadmill and then discarding the filled application.
        if (sigBefore !== null && typeof page.getModalStepSignature === 'function') {
          const sigAfter = await page.getModalStepSignature().catch(() => null);
          if (sigAfter !== null && sigAfter === sigBefore) {
            logger.warning(
              '[DedicatedJobRunner] Forward click was silently rejected by LinkedIn (step content unchanged). Healing surfaced validation errors and retrying once...',
            );
            const blockedValidation = await page.validateModalFormState();
            // A blocked resume/document step cannot be healed with text answers —
            // attach the draft resume once, then let the retry click below proceed.
            if (!uploadAttempted) {
              const blockedSnap = await page.captureModalSnapshot().catch(() => null);
              if (blockedSnap?.hasFileInput || blockedValidation.unfulfilledMandatoryFileUpload) {
                const uploaded = await tryUploadDraftResume('📄 Uploading a draft resume to unblock this form step...');
                if (uploaded) {
                  stuckStreak = 0;
                  lastIterationSignature = null;
                }
              }
            }
            if (blockedValidation.hasErrors && scopedLLM) {
              for (const invF of blockedValidation.invalidFieldsWithErrors) {
                try {
                  const healed = await solveValidationErrorWithLLM(invF, careerBrain, scopedLLM);
                  if (healed.success && healed.answer !== undefined) {
                    const adapted = adaptAnswerToFieldFormat(healed.answer, invF as any);
                    const fillVal = adapted.valid ? adapted.value : healed.answer;
                    const fillSuccess = await page.fillModalFieldDirect(invF, fillVal);
                    onAuditLog(
                      'GENERATED',
                      invF.label,
                      fillVal,
                      `Blocked-forward validation heal | Prev: "${invF.currentValue}" | Error: "${invF.errorText}" | Fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                    );
                  }
                } catch (healErr) {
                  logger.warning(`[DedicatedJobRunner] Failed to heal blocked field "${invF.label}":`, healErr);
                }
              }
              for (const reqF of blockedValidation.emptyRequiredFields) {
                try {
                  const autoSol = await solveQuestionAutonomousWithLLM(reqF, careerBrain, scopedLLM);
                  if (autoSol.success && autoSol.answer) {
                    const adapted = adaptAnswerToFieldFormat(autoSol.answer, reqF);
                    const fillVal = adapted.valid ? adapted.value : autoSol.answer;
                    const fillSuccess = await page.fillModalFieldDirect(reqF, fillVal);
                    onAuditLog(
                      'GENERATED',
                      reqF.label,
                      fillVal,
                      `Blocked-forward empty-field fill | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                    );
                  }
                } catch (healErr) {
                  logger.warning(`[DedicatedJobRunner] Failed to fill blocked field "${reqF.label}":`, healErr);
                }
              }
            }
            if (typeof page.scrollModalContent === 'function') {
              await page.scrollModalContent('bottom');
              await new Promise(r => setTimeout(r, 300));
            }
            const retrySigBefore = await page.getModalStepSignature().catch(() => null);
            await page.clickModalForwardButton();
            if (typeof page.waitForDomSettlement === 'function') {
              await page.waitForDomSettlement();
            } else {
              await new Promise(r => setTimeout(r, 1200));
            }
            const retrySigAfter = await page.getModalStepSignature().catch(() => null);
            if (retrySigAfter !== null && retrySigBefore !== null && retrySigAfter !== retrySigBefore) {
              // Retry advanced the modal successfully
              step = Math.max(0, step - 1);
              continue;
            }
            logger.error(
              '[DedicatedJobRunner] Forward button rejected twice by LinkedIn (Next/Review disabled). Aborting this application cleanly; the draft is preserved on LinkedIn for manual review.',
            );
            return {
              success: false,
              reason:
                'Next/Review button rejected by LinkedIn (validation blocked). Draft preserved for manual review.',
            };
          }
        }

        // Post-advance validation check: Check if forward navigation was rejected by red alert errors!
        const postFwdValidation = await page.validateModalFormState();
        if (postFwdValidation.hasErrors) {
          if (postFwdValidation.invalidFieldsWithErrors.length > 0) {
            logger.warning(
              `[DedicatedJobRunner] Forward navigation was rejected by ${postFwdValidation.invalidFieldsWithErrors.length} red alert validation errors. Auto-healing with LLM...`,
            );
            for (const invF of postFwdValidation.invalidFieldsWithErrors) {
              const healed = await solveValidationErrorWithLLM(invF, careerBrain, scopedLLM);
              if (healed.success && healed.answer) {
                const adapted = adaptAnswerToFieldFormat(healed.answer, invF as any);
                const fillVal = adapted.valid ? adapted.value : healed.answer;
                const fillSuccess = await page.fillModalFieldDirect(invF, fillVal);
                onAuditLog(
                  'GENERATED',
                  invF.label,
                  fillVal,
                  `Post-forward validation heal | Prev: "${invF.currentValue}" | Error: "${invF.errorText}" | Fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
                );
              }
            }
          }
          if (postFwdValidation.emptyRequiredFields.length > 0 && scopedLLM) {
            for (const reqF of postFwdValidation.emptyRequiredFields) {
              const autoSol = await solveQuestionAutonomousWithLLM(reqF, careerBrain, scopedLLM);
              if (autoSol.success && autoSol.answer) {
                const adapted = adaptAnswerToFieldFormat(autoSol.answer, reqF);
                const fillVal = adapted.valid ? adapted.value : autoSol.answer;
                await page.fillModalFieldDirect(reqF, fillVal);
              }
            }
          }
          if (typeof page.scrollModalContent === 'function') {
            await page.scrollModalContent('bottom');
          }
          await page.clickModalForwardButton();
          // Do not waste a step iteration when blocked on current step
          step = Math.max(0, step - 1);
        }
      } else {
        // Neither submit nor forward button found immediately - scroll to bottom and retry polling with patience (up to 6 attempts)
        let retryActions = actions;
        for (let btnRetry = 1; btnRetry <= 6; btnRetry++) {
          if (typeof page.scrollModalContent === 'function') {
            await page.scrollModalContent('bottom');
          }
          await new Promise(r => setTimeout(r, 600 * btnRetry));
          retryActions = await page.getModalActionButtons();
          if (retryActions.hasSubmit || retryActions.hasNext || retryActions.hasReview) {
            break;
          }
        }

        // If buttons are still not visible, check if blocking form validation errors exist and heal them
        if (!retryActions.hasSubmit && !retryActions.hasNext && !retryActions.hasReview) {
          logger.info('[DedicatedJobRunner] Action buttons delayed: Checking for blocking validation errors...');
          await inspectAndHealFormErrors(page, '.jobs-easy-apply-modal');
          const validationCheck = await page.validateModalFormState();
          if (validationCheck.hasErrors && scopedLLM) {
            for (const invF of validationCheck.invalidFieldsWithErrors || []) {
              const healed = await solveValidationErrorWithLLM(invF, careerBrain, scopedLLM);
              if (healed.success && healed.answer) {
                const adapted = adaptAnswerToFieldFormat(healed.answer, invF as any);
                const fillVal = adapted.valid ? adapted.value : healed.answer;
                await page.fillModalFieldDirect(invF, fillVal);
              }
            }
            for (const reqF of validationCheck.emptyRequiredFields || []) {
              const autoSol = await solveQuestionAutonomousWithLLM(reqF, careerBrain, scopedLLM);
              if (autoSol.success && autoSol.answer) {
                const adapted = adaptAnswerToFieldFormat(autoSol.answer, reqF);
                const fillVal = adapted.valid ? adapted.value : autoSol.answer;
                await page.fillModalFieldDirect(reqF, fillVal);
              }
            }
          }
          if (typeof page.scrollModalContent === 'function') {
            await page.scrollModalContent('bottom');
            await new Promise(r => setTimeout(r, 400));
          }
          retryActions = await page.getModalActionButtons();
        }

        if (retryActions.hasSubmit) {
          this.notifyStatus(portToSend, `🎉 All steps completed! Submitting your application now...`, 'info');
          const submitRes = await page.submitApplication();
          if (submitRes.clicked) {
            const confirmRes = await page.verifySubmissionConfirmation(8000);
            if (confirmRes.confirmed) {
              submitted = true;
              break;
            }
          }
        } else if (retryActions.hasNext || retryActions.hasReview) {
          let fwdRes = await page.clickModalForwardButton();
          if (!fwdRes.clicked) {
            await inspectAndHealFormErrors(page, '.jobs-easy-apply-modal');
            if (typeof page.scrollModalContent === 'function') {
              await page.scrollModalContent('bottom');
            }
            await new Promise(r => setTimeout(r, 400));
            fwdRes = await page.clickModalForwardButton();
          }
          if (fwdRes.clicked) {
            if (typeof page.waitForDomSettlement === 'function') {
              await page.waitForDomSettlement();
            } else {
              await new Promise(r => setTimeout(r, 1200));
            }
            continue;
          }
        }

        // Direct fallback: Attempt clicking primary button in case getModalActionButtons missed atypical labels
        const directFwd = await page.clickModalForwardButton();
        if (directFwd.clicked) {
          if (typeof page.waitForDomSettlement === 'function') {
            await page.waitForDomSettlement();
          } else {
            await new Promise(r => setTimeout(r, 1200));
          }
          continue;
        }
        const directSubmit = await page.submitApplication();
        if (directSubmit.clicked) {
          const confirmRes = await page.verifySubmissionConfirmation(8000);
          if (confirmRes.confirmed) {
            submitted = true;
            break;
          }
        }

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

      // Stuck-step guard (end of iteration): reachable only when the forward path did
      // not continue/break - i.e. LinkedIn may have silently swallowed the Next/Review
      // click while the step signature stayed identical.
      if (typeof page.getModalStepSignature === 'function') {
        const endSig = await page.getModalStepSignature().catch(() => null);
        if (endSig !== null && lastIterationSignature !== null && endSig === lastIterationSignature) {
          stuckStreak++;
        } else {
          stuckStreak = 0;
        }
        lastIterationSignature = endSig;
      }

      // If stuck on a page that has a file input (resume upload step with a disabled
      // Next button), auto-upload the draft resume PDF once to unlock the form.
      if (stuckStreak >= 1 && !uploadAttempted) {
        const snap = await page.captureModalSnapshot().catch(() => null);
        if (snap?.hasFileInput) {
          const uploaded = await tryUploadDraftResume('📄 Auto-uploading a draft resume to unlock this form step...');
          if (uploaded) {
            stuckStreak = 0;
            lastIterationSignature = null;
            this.notifyStatus(portToSend, `✅ Draft resume uploaded. Re-checking form buttons...`, 'info');
          }
        }
      }

      // Fail fast with diagnostics instead of burning all 15 steps on a treadmill
      if (stuckStreak >= 3 || fieldsZeroStreak >= 8) {
        const snap = await page.captureModalSnapshot().catch(() => null);
        const stuckTitle = snap?.title || 'unknown page';
        logger.warning(
          `[DedicatedJobRunner] Form stuck (stuckStreak=${stuckStreak}, fieldsZeroStreak=${fieldsZeroStreak}). Snapshot: ${JSON.stringify(
            {
              title: snap?.title,
              modalTag: snap?.modalTag,
              buttons: snap?.buttonTexts,
              hasFileInput: snap?.hasFileInput,
              hasRadios: snap?.hasRadios,
              inputsCount: snap?.inputsCount,
              selectsCount: snap?.selectsCount,
              iframesCount: snap?.iframesCount,
              spinnersCount: snap?.spinnersCount,
              shadowHosts: snap?.shadowHosts,
              shadowInputs: snap?.shadowInputs,
              snippet: snap?.textSnippet,
              html: snap?.outerHtmlSnippet,
            },
          )}`,
        );
        this.notifyStatus(
          portToSend,
          `⚠️ LinkedIn form stuck on "${stuckTitle}" - Next/Review not advancing. Skipping to preserve credits...`,
          'info',
        );
        return {
          success: false,
          reason: `Form stuck on "${stuckTitle}" (Next/Review not advancing)`,
        };
      }
    }

    if (submitted) {
      // Dismiss any lingering thank-you confirmation overlay
      if (typeof page.dismissPostSubmitModal === 'function') {
        await page.dismissPostSubmitModal().catch(() => {});
      }
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
            <span style="color:#e2e8f0;font-weight:600;font-size:11px;font-family:system-ui,-apple-system,sans-serif;letter-spacing:0.3px;">JobForm Automator Runner Active</span>
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

  private cleanupRun(summaryMsg?: string, stats?: any): void {
    void DailyQuotaManager.releaseOwner('runner');
    if (this.activePort) {
      try {
        this.activePort.postMessage({
          type: 'LINKEDIN_RUN_FINISHED',
          summary: summaryMsg || 'Auto Apply session ended',
          stats: stats || { totalFound: 0, applied: 0, skipped: 0, failed: 0 },
        });
      } catch {}
    }
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
        await DailyQuotaManager.commitApplication(applicationKey(activeRun.jobId, activeRun.canonicalUrl));
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
