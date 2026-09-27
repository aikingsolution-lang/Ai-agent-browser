// chrome-extension/src/background/agent/linkedin/dedicatedJobRunner.ts
import { createLogger } from '@src/background/log';
import type BrowserContext from '@src/background/browser/context';
import type { Executor } from '@src/background/agent/executor';
import { backendApiClient } from '@extension/shared';
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
  type ProcessedJobRecord,
  type ICareerBrain,
} from '@extension/storage';
import { DailyQuotaManager } from './rateLimiter';
import { normalizeLinkedInJobUrl } from './urlUtils';
import { dedicatedWindowManager } from './dedicatedWindow';
import { buildLinkedInApplyTaskDetails } from './taskBuilder';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';
import { indeedAdapter } from '../platforms/indeed/indeedAdapter';
import type { SupportedPlatform } from '../platforms/types';
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

/**
 * Evaluates job relevance against candidate's profile skills and target roles at 0 LLM cost.
 * Scans job title and split-pane description snippet using DOM/regex token matching.
 * Accounts for skill variants (React <-> React.js, Node <-> Node.js) and title domain overlap.
 */
export function checkJobSkillRelevance(
  jobTitle: string,
  descriptionSnippet: string | undefined,
  careerBrain: ICareerBrain,
): { relevant: boolean; reason?: string; matchedSkills: string[] } {
  const rawSkills = Array.from(
    new Set([...(careerBrain.skills || []), ...Object.keys(careerBrain.skillExperience || {})]),
  )
    .map(s => s.trim())
    .filter(s => s.length > 1);

  // If candidate has no skills configured, fallback to open matching
  if (rawSkills.length === 0) {
    return { relevant: true, matchedSkills: [] };
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
    return { relevant: true, matchedSkills };
  }

  // 3. Domain Title Matching Fallback:
  // If candidate target role is e.g. "Full Stack Developer", "Frontend Developer", etc.,
  // check if job title shares core software engineering domain keywords
  const targetTitles = [careerBrain.currentTitle || '', ...(careerBrain.predefinedRoles || [])]
    .map(t => t.toLowerCase().trim())
    .filter(t => t.length > 0);

  const domainKeywords = [
    'full stack',
    'fullstack',
    'frontend',
    'front-end',
    'backend',
    'back-end',
    'software engineer',
    'software developer',
    'web developer',
    'mern',
    'mean stack',
  ];

  for (const target of targetTitles) {
    for (const kw of domainKeywords) {
      if (target.includes(kw) && lowerTitle.includes(kw)) {
        return {
          relevant: true,
          matchedSkills: [`Title domain match: "${kw}"`],
        };
      }
    }
  }

  // 4. If description snippet was empty or unmounted (<60 chars), give benefit of doubt
  const hasSubstantialDescription = (descriptionSnippet || '').trim().length > 60;
  if (!hasSubstantialDescription) {
    const titleTokens = (careerBrain.currentTitle || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !['senior', 'junior', 'lead', 'staff'].includes(w));
    if (titleTokens.some(token => lowerTitle.includes(token))) {
      return { relevant: true, matchedSkills: [] };
    }
  }

  return {
    relevant: false,
    reason: `Low relevance: 0 matching skills found in job posting for candidate profile (${rawSkills.slice(0, 5).join(', ')}${rawSkills.length > 5 ? '...' : ''})`,
    matchedSkills: [],
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
          baseURL: 'http://localhost:5000/api/v1/llm',
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

export type JobActivityStatus = 'applied' | 'skipped' | 'failed' | 'running' | 'modal_opened' | 'modal_failed';

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
  private abortController: AbortController | null = null;

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
      if (!this.abortController || this.abortController.signal.aborted) {
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
      this.notify(portToSend, `🌐 Opening dedicated runner window for Job ID ${jobId}...`);

      // 4. Open / Reuse Dedicated Window
      const { windowId, tabId } = await dedicatedWindowManager.getOrCreateRunnerWindow(canonicalUrl);
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

      // Register window close abort listener
      this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async () => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(`Dedicated runner window closed while run ${runId} was active. Cancelling and refunding...`);
          if (this.currentExecutor) {
            this.currentExecutor.cancel();
          }
          await backendApiClient.refundCredits(runId).catch(() => {});
          await runnerStateStore.updateRunStatus('failed', { errorReason: 'Runner window closed by user' });
          await processedJobsStore.recordJob({
            jobId,
            url: canonicalUrl,
            title: 'Closed Window',
            company: '',
            status: 'failed',
            reason: 'Runner window closed by user',
            creditsUsed: 0,
          });
          this.notify(portToSend, '🛑 Application cancelled: Runner window was closed.', true, runId);
          if (onLiveActivity) {
            onLiveActivity({
              jobId,
              url: canonicalUrl,
              title: 'Closed Window',
              company: '',
              status: 'failed',
              reason: 'Runner window closed by user',
              creditsUsed: 0,
            });
          }
          this.cleanupRun();
        }
      });

      // Wait a moment for page navigation
      await new Promise(resolve => setTimeout(resolve, 4000));

      const currentPage = await this.browserContext.getCurrentPage();
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
      let role = (careerBrain.currentTitle || '').trim();
      let location = (careerBrain.currentLocation || careerBrain.preferredLocation || '').trim();

      if (!role) {
        this.notifyStatus(portToSend, '❓ Target role/title missing in profile. Asking user...', 'info');
        try {
          role = await userQuestionManager.askQuestion({
            questionText:
              'What job title or role are you targeting for this search? (e.g. Full Stack Developer, Frontend Engineer)',
            fieldType: 'text',
          });
          role = (role || '').trim();
          if (role) {
            await careerBrainStore.updateCareerBrain({ currentTitle: role });
          }
        } catch (askErr: any) {
          const timeoutErr = `Failed to obtain target role: ${askErr.message || askErr}`;
          this.notifyStatus(portToSend, `🛑 ${timeoutErr}`, 'fail');
          this.cleanupRun();
          return { status: 'error', message: timeoutErr, stats };
        }
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

      if (!role) {
        role = 'Software Engineer';
      }

      if (options.platform === 'naukri') {
        return await this.startNaukriJobLoop(options, careerBrain, role, location, runId, stats);
      }

      if (options.platform === 'indeed') {
        return await this.startIndeedJobLoop(options, careerBrain, role, location, runId, stats);
      }

      this.notifyStatus(
        portToSend,
        `🎯 Search Criteria: Role="${role}" | Location="${location}" | Easy Apply=true`,
        'info',
      );

      // 3. Search URL Navigation with f_AL=true & sortBy=R
      // Sanitize role for LinkedIn search keywords (e.g. "Full Stack / MERN Developer" -> "Full Stack OR MERN Developer")
      const sanitizedRole = role
        .replace(/[/\\|]+/g, ' OR ')
        .replace(/[,+;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const searchParams = new URLSearchParams({
        keywords: sanitizedRole,
        f_AL: 'true', // Easy Apply filter
        sortBy: 'R', // Most relevant
      });
      if (location) {
        searchParams.set('location', location);
      }
      const searchUrl = `https://www.linkedin.com/jobs/search/?${searchParams.toString()}`;

      this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for search...`, 'info');
      const { windowId, tabId } = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl);
      this.browserContext.updateCurrentTabId(tabId);

      // Register window close abort listener
      this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async () => {
        if (this.isRunning && this.activeRunId === runId) {
          logger.warning(`Dedicated runner window closed while auto loop ${runId} was active.`);
          this.notifyStatus(portToSend, '🛑 Auto Apply stopped: Runner window was closed.', 'fail');
          this.stop();
        }
      });

      // Wait 4s for initial page load & navigation
      await new Promise(r => setTimeout(r, 4000));
      if (!this.isRunning) {
        return { status: 'stopped', message: 'Stopped by user', stats };
      }

      const currentPage = await this.browserContext.getCurrentPage();
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
          await new Promise(r => setTimeout(r, 3000));
          if (!this.isRunning) break;

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

      // 5. Read Left-Hand Job List Pane (Max 3 retries)
      let jobCards: Array<{ jobId: string; title: string; company: string; url: string }> = [];
      let readAttempts = 0;
      while (readAttempts < 3 && jobCards.length === 0) {
        readAttempts++;
        if (!this.isRunning) break;
        this.notifyStatus(portToSend, `🔍 Scanning LinkedIn job search results (attempt ${readAttempts}/3)...`, 'info');
        jobCards = await currentPage.readJobListFromSearchPane(readAttempts);
        if (jobCards.length === 0 && readAttempts < 3) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (jobCards.length === 0) {
        const noJobsMsg = 'No jobs found for this search. Please check your role/location criteria or search filters.';
        this.notifyStatus(portToSend, `⚠️ ${noJobsMsg}`, 'fail');
        this.cleanupRun();
        return { status: 'error', message: noJobsMsg, stats };
      }

      stats.totalFound = jobCards.length;
      this.notifyStatus(
        portToSend,
        `📋 Discovered ${jobCards.length} job cards in search results. Evaluating queue eligibility...`,
        'ok',
      );

      // Deduplicate & check against processedJobsStore
      const eligibleJobs: Array<{ jobId: string; title: string; company: string; url: string }> = [];
      for (const card of jobCards) {
        const proc = await processedJobsStore.isJobProcessed(card.jobId);
        if (proc.isProcessed && proc.status === 'applied') {
          stats.skipped++;
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
        eligibleJobs.push(card);
      }

      // Apply batch cap (default 10)
      const queue = eligibleJobs.slice(0, BATCH_CAP);
      this.notifyStatus(
        portToSend,
        `🎯 Queued ${queue.length} eligible jobs for this run (capped at max ${BATCH_CAP}).`,
        'info',
      );

      // 6. Loop Through Each Job in Queue
      for (let i = 0; i < queue.length; i++) {
        if (!this.isRunning) {
          logger.info('[DedicatedJobRunner] Autonomous loop halted (user stopped).');
          break;
        }

        const job = queue[i];
        const jobRunId = `${runId}_${job.jobId}`;
        this.activeJobId = job.jobId;

        // Daily Quota check
        const quota = await DailyQuotaManager.canApplyToday();
        if (!quota.allowed) {
          const quotaMsg = `🛑 Daily application quota reached (${quota.currentCount} today). Stopping run.`;
          this.notifyStatus(portToSend, quotaMsg, 'fail');
          break;
        }

        // Hard credit budget check (minimum 5 credits to ensure balance for form-filling LLM calls)
        const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
        if (balanceRes?.data?.remainingCredits !== undefined && balanceRes.data.remainingCredits < 5) {
          const creditMsg = `🛑 Insufficient credit budget (${balanceRes.data.remainingCredits} remaining, minimum 5 required). Halting run.`;
          this.notifyStatus(portToSend, creditMsg, 'fail');
          break;
        }

        const safeTitle = cleanLinkedInJobTitle(job.title) || 'Loading title...';
        const safeCompany = job.company || 'Unknown Company';

        this.notifyStatus(
          portToSend,
          `💼 Checking job ${i + 1} of ${queue.length}: "${safeTitle}" (${safeCompany})`,
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
        await new Promise(r => setTimeout(r, 2500));
        if (!this.isRunning) break;

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
          this.notifyStatus(portToSend, `Checking job details for ${job.jobId} (attempt ${retryCount}/2)...`, 'info');
          await new Promise(r => setTimeout(r, 1500));
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
          continue;
        }

        // 4c. Pre-Apply Skill Relevance Check (0 LLM credits)
        const relevance = checkJobSkillRelevance(displayTitle, topCard.descriptionSnippet, careerBrain);
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
          continue;
        }

        if (relevance.matchedSkills.length > 0) {
          logger.info(
            `[DedicatedJobRunner] Job "${displayTitle}" matched skills: ${relevance.matchedSkills.slice(0, 5).join(', ')}`,
          );
        }

        // 4d. Click Easy Apply & Verify Modal Opens
        this.notifyStatus(portToSend, `🚀 Opening Easy Apply for "${displayTitle}"...`, 'info');
        let clickRes = await currentPage.clickEasyApplyButton();
        if (!clickRes.success) {
          // Retry click once
          await new Promise(r => setTimeout(r, 1200));
          clickRes = await currentPage.clickEasyApplyButton();
        }

        // Poll for modal
        let modalRes = await currentPage.waitForEasyApplyModal(6000, 300);
        if (!modalRes.opened) {
          // Retry clicking one more time
          logger.warning(`[DedicatedJobRunner] Modal did not open on first attempt. Retrying click...`);
          await new Promise(r => setTimeout(r, 1000));
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
            const successMsg = `Applied to "${displayTitle}" at ${displayCompany || 'company'} successfully! 🎉`;
            this.notifyStatus(portToSend, `✅ ${successMsg}`, 'ok');

            await processedJobsStore.recordJob({
              jobId: job.jobId,
              url: job.url,
              title: displayTitle,
              company: displayCompany,
              status: 'applied',
              reason: 'Application submitted and verified',
              creditsUsed: 0,
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
            // Verified applied: legitimate LLM variable deductions are retained. 0 flat fee charged.
          } else {
            stats.skipped++;
            const skipReason = fillRes.reason || 'Form filling could not be completed';
            const friendlySkip = formatFriendlySkipReason(skipReason);
            this.notifyStatus(portToSend, `ℹ️ Skipped "${displayTitle}": ${friendlySkip}`, 'info');

            // Automatically refund any credits deducted for this job's LLM calls
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
        }

        // 4e. Anti-Ban Pacing Delay (5s - 10s) between jobs
        if (i < queue.length - 1 && this.isRunning) {
          const minDelay = 5_000;
          const maxDelay = 10_000;
          const delayTime = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
          const delaySec = Math.round(delayTime / 1000);

          this.notifyStatus(
            portToSend,
            `☕ Quick safety pause: Waiting ${delaySec}s before opening the next job...`,
            'info',
          );
          const aborted = await this.interruptibleSleep(delayTime);
          if (aborted || !this.isRunning) {
            logger.info('[DedicatedJobRunner] Pacing delay aborted by user.');
            break;
          }
        }
      }

      // 6. Final Summary
      const summaryMsg = `🏁 Auto Apply finished! Submitted ${stats.applied} application${stats.applied === 1 ? '' : 's'} (${stats.skipped} skipped).`;
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
    location: string,
    runId: string,
    stats: { totalFound: number; applied: number; modalOpened: number; skipped: number; failed: number },
  ): Promise<{
    status: 'success' | 'stopped' | 'error';
    message: string;
    stats: typeof stats;
  }> {
    const { portToSend, onLiveActivity } = options;
    const BATCH_CAP = Math.min(options.maxJobs || 10, 10);

    const searchUrl = naukriAdapter.buildSearchUrl(role, location);
    this.notifyStatus(
      portToSend,
      `🎯 [Naukri.com] Search Criteria: Role="${role}" | Location="${location || 'All India'}"`,
      'info',
    );

    this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for Naukri...`, 'info');
    const { windowId, tabId } = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl);
    this.browserContext!.updateCurrentTabId(tabId);

    this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async () => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(`Dedicated runner window closed while Naukri auto loop ${runId} was active.`);
        this.notifyStatus(portToSend, '🛑 Auto Apply stopped: Runner window was closed.', 'fail');
        this.stop();
      }
    });

    // Wait 4s for navigation
    await new Promise(r => setTimeout(r, 4000));
    if (!this.isRunning) {
      return { status: 'stopped', message: 'Stopped by user', stats };
    }

    const currentPage = await this.browserContext!.getCurrentPage();

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
        await new Promise(r => setTimeout(r, 3000));
        if (!this.isRunning) break;

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

    // Scan jobs
    this.notifyStatus(portToSend, '🔍 Scanning Naukri job search results...', 'info');
    const jobs = await naukriAdapter.extractJobCards(currentPage);
    stats.totalFound = jobs.length;

    if (jobs.length === 0) {
      const noJobsMsg = 'No job listings found on Naukri for these criteria.';
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
    for (let i = 0; i < queue.length; i++) {
      if (!this.isRunning) break;

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

      // Relevance check
      const relevance = checkJobSkillRelevance(job.title, undefined, careerBrain);
      if (!relevance.relevant) {
        this.notifyStatus(portToSend, `ℹ️ Skipped "${job.title}": Skills do not match profile.`, 'info');
        stats.skipped++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: 'Skills do not closely match profile',
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
        await DailyQuotaManager.incrementAppliedCount();
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'applied',
          creditsUsed: 1,
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
    location: string,
    runId: string,
    stats: { totalFound: number; applied: number; modalOpened: number; skipped: number; failed: number },
  ): Promise<{
    status: 'success' | 'stopped' | 'error';
    message: string;
    stats: typeof stats;
  }> {
    const { portToSend, onLiveActivity } = options;
    const BATCH_CAP = Math.min(options.maxJobs || 10, 10);

    const searchUrl = indeedAdapter.buildSearchUrl(role, location);
    this.notifyStatus(
      portToSend,
      `🎯 [Indeed] Search Criteria: Role="${role}" | Location="${location || 'Remote'}"`,
      'info',
    );

    this.notifyStatus(portToSend, `🌐 Opening dedicated runner window for Indeed...`, 'info');
    const { windowId, tabId } = await dedicatedWindowManager.getOrCreateRunnerWindow(searchUrl);
    this.browserContext!.updateCurrentTabId(tabId);

    this.unregisterWindowCloseListener = dedicatedWindowManager.onWindowClosed(async () => {
      if (this.isRunning && this.activeRunId === runId) {
        logger.warning(`Dedicated runner window closed while Indeed auto loop ${runId} was active.`);
        this.notifyStatus(portToSend, '🛑 Auto Apply stopped: Runner window was closed.', 'fail');
        this.stop();
      }
    });

    // Wait 4s for navigation
    await new Promise(r => setTimeout(r, 4000));
    if (!this.isRunning) {
      return { status: 'stopped', message: 'Stopped by user', stats };
    }

    const currentPage = await this.browserContext!.getCurrentPage();

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
        await new Promise(r => setTimeout(r, 3000));
        if (!this.isRunning) break;

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

    // Scan jobs
    this.notifyStatus(portToSend, '🔍 Scanning Indeed job search results...', 'info');
    const jobs = await indeedAdapter.extractJobCards(currentPage);
    stats.totalFound = jobs.length;

    if (jobs.length === 0) {
      const noJobsMsg = 'No job listings found on Indeed for these criteria.';
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

    const queue = eligibleJobs.slice(0, BATCH_CAP);
    this.notifyStatus(
      portToSend,
      `🎯 Queued ${queue.length} eligible Indeed jobs for this run (capped at max ${BATCH_CAP}).`,
      'info',
    );

    // Execution loop
    for (let i = 0; i < queue.length; i++) {
      if (!this.isRunning) break;

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

      // Relevance check
      const relevance = checkJobSkillRelevance(job.title, undefined, careerBrain);
      if (!relevance.relevant) {
        this.notifyStatus(portToSend, `ℹ️ Skipped "${job.title}": Skills do not match profile.`, 'info');
        stats.skipped++;
        await processedJobsStore.recordJob({
          jobId: job.jobId,
          url: job.url,
          title: job.title,
          company: job.company,
          status: 'skipped',
          reason: 'Skills do not closely match profile',
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

      // Anti-bot pacing delay (5-8s) between Indeed jobs only when applied!
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
          await this.interruptibleSleep(1500);
        }
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
   * Stops active runner cleanly and refunds credits.
   */
  public async stop(): Promise<void> {
    logger.info('[DedicatedJobRunner] User triggered stop.');
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentExecutor) {
      this.currentExecutor.cancel();
      this.currentExecutor = null;
    }

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

    await dedicatedWindowManager.closeRunnerWindow();
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

  private cleanupRun(): void {
    if (this.abortController) {
      this.abortController.abort();
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
