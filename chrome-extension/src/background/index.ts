import 'webextension-polyfill';
import {
  agentModelStore,
  AgentNameEnum,
  firewallStore,
  generalSettingsStore,
  llmProviderStore,
  analyticsSettingsStore,
  cloudApiSettingsStore,
  ProviderTypeEnum,
  authStorage,
  careerBrainStore,
  validateProfileCompleteness,
  queueSafetyStore,
  processedJobsStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import {
  backendApiClient,
  isValidSkillName,
  cleanSkillName,
  validateAndSanitizeSkillExperience,
  cleanLocationForCityField,
  BACKEND_LLM_URL,
} from '@extension/shared';
import BrowserContext from './browser/context';
import { Executor } from './agent/executor';
import { createLogger } from './log';
import { Actors, ExecutionState } from './agent/event/types';
import { createChatModel } from './agent/helper';
import { cloudApiClient } from './services/cloud-api-client';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { DEFAULT_AGENT_OPTIONS, type AgentOptions } from './agent/types';
import { SpeechToTextService } from './services/speechToText';
import { injectBuildDomTreeScripts } from './browser/dom/service';
import { analytics } from './services/analytics';
import { queueManager } from './agent/linkedin/queueManager';
import { ApplicationEngine } from './agent/linkedin/applicationEngine';
import { DailyQuotaManager } from './agent/linkedin/rateLimiter';
import { solveQuestions } from './agent/linkedin/questionSolver';
import { buildLinkedInApplyTask, buildLinkedInApplyTaskDetails } from './agent/linkedin/taskBuilder';
import { buildExternalApplyTaskDetails } from './agent/taskBuilderExternal';
import { userQuestionManager } from './agent/linkedin/userQuestionManager';
import { dedicatedJobRunner } from './agent/linkedin/dedicatedJobRunner';
import { normalizeLinkedInJobUrl } from './agent/linkedin/urlUtils';
import type { IJobData } from './agent/linkedin/types';
import { careerCopilotEngine, auditCareerBrain } from './agent/copilot/careerCopilotEngine';

const logger = createLogger('background');

const browserContext = new BrowserContext({});
queueManager.setBrowserContext(browserContext);
queueManager.setAgentApplyRunner(async () => {
  return applyToCurrentActiveJob(currentPort);
});

dedicatedJobRunner.setBrowserContext(browserContext);
dedicatedJobRunner.setExecutorFactory(setupExecutor);
dedicatedJobRunner.setExecutorSubscriber(subscribeToExecutorEvents);
dedicatedJobRunner.onStop(() => {
  logger.info('[Background] DedicatedJobRunner stopped: resetting isJobApplyInProgress');
  isJobApplyInProgress = false;
});

// Recover any interrupted job run from previous worker lifecycle
dedicatedJobRunner.recoverInterruptedRunOnStartup().catch(err => {
  logger.error('Failed to run startup recovery for interrupted jobs:', err);
});

// Alarm listener for service worker keep-alive during job runs
if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'job_runner_keep_alive') {
      logger.debug('job_runner_keep_alive alarm tick');
    }
  });
}

let currentExecutor: Executor | null = null;
let currentPort: chrome.runtime.Port | null = null;
let isJobApplyInProgress = false;
let activeJobTaskId: string | null = null;
const SIDE_PANEL_URL = chrome.runtime.getURL('side-panel/index.html');

/**
 * Resolves active LLM (Backend Bedrock Gateway or Local Provider)
 */
async function getActiveChatModel(): Promise<BaseChatModel | undefined> {
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
    logger.warning('Could not resolve active chat model for QueueManager:', err);
  }
  return undefined;
}

// Wire active LLM model to QueueManager on background startup
getActiveChatModel().then(llm => {
  if (llm) {
    queueManager.setModels({ llm });
    logger.info('QueueManager initialized with active LLM model');
  }
});

// Retry any pending credit refunds from previous sessions
backendApiClient.retryPendingRefunds().catch(e => {
  logger.warning('Pending refunds retry failed:', e);
});

// Stream live LinkedIn Queue progress events to Side Panel UI
queueManager.setProgressCallback((details, isError) => {
  if (currentPort) {
    try {
      currentPort.postMessage({
        actor: Actors.SYSTEM,
        state: isError ? ExecutionState.STEP_FAIL : ExecutionState.STEP_OK,
        data: {
          taskId: 'linkedin_queue',
          step: 1,
          maxSteps: 1,
          details,
        },
      });
    } catch {}
  }
});

/**
 * Applies to the active LinkedIn job using LLM Planner & Navigator (Option 2)
 */
async function applyToCurrentActiveJob(
  portToSend?: chrome.runtime.Port | null,
): Promise<{ status: string; message: string }> {
  if (isJobApplyInProgress) {
    const busyMsg = '⚠️ An application is already in progress. Please wait for it to complete.';
    logger.warning(`[applyToCurrentActiveJob] Rejected concurrent apply request: ${busyMsg}`);
    const port = portToSend || currentPort;
    if (port) {
      try {
        port.postMessage({
          actor: Actors.SYSTEM,
          state: ExecutionState.TASK_FAIL,
          data: {
            taskId: `busy_${Date.now()}`,
            step: 1,
            maxSteps: 1,
            details: busyMsg,
          },
        });
      } catch {}
    }
    return { status: 'error', message: busyMsg };
  }

  isJobApplyInProgress = true;

  const notify = (msg: string, isErr = false) => {
    logger.info(`[applyToCurrentActiveJob] ${msg}`);
    const port = portToSend || currentPort;
    if (port) {
      try {
        port.postMessage({
          actor: Actors.SYSTEM,
          state: isErr ? ExecutionState.TASK_FAIL : ExecutionState.STEP_OK,
          data: {
            taskId: activeJobTaskId || `current_job_${Date.now()}`,
            step: 1,
            maxSteps: 1,
            details: msg,
          },
        });
      } catch {}
    }
  };

  let initialCredits: number | null = null;
  let taskId = '';
  try {
    const balanceRes = await backendApiClient.getCreditsBalance().catch(() => null);
    if (balanceRes?.data?.remainingCredits !== undefined) {
      initialCredits = balanceRes.data.remainingCredits;
    }

    // 1. Quota check
    const quota = await DailyQuotaManager.canApplyToday();
    if (!quota.allowed) {
      notify(`🛑 Daily application quota reached (${quota.currentCount} applications today).`, true);
      return { status: 'error', message: 'Daily application quota reached' };
    }

    // 2. Profile completeness check
    const careerBrain = await careerBrainStore.getCareerBrain();
    const completeness = validateProfileCompleteness(careerBrain);
    if (!completeness.isValid) {
      const missingList = completeness.missingFields.join(', ');
      notify(
        `⚠️ Cannot apply: Incomplete profile. Missing required fields: ${missingList}. Please update your profile in the "Resume & Profile" tab.`,
        true,
      );
      return {
        status: 'error',
        message: `Incomplete profile: Missing ${missingList}. Please update the Resume & Profile tab.`,
      };
    }

    // 3. Find target LinkedIn tab
    let targetTab: chrome.tabs.Tab | undefined;
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (activeTabs.length > 0 && activeTabs[0].url && activeTabs[0].url.includes('linkedin.com')) {
      targetTab = activeTabs[0];
    } else {
      const anyJobTabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' });
      targetTab = anyJobTabs.find(t => t.active) || anyJobTabs[0];
    }

    if (!targetTab?.id || !targetTab.url) {
      const noTabMsg = '⚠️ Please open a LinkedIn job page in your browser first.';
      notify(noTabMsg, true);
      return { status: 'error', message: noTabMsg };
    }

    const hasJobId = /(?:\/jobs\/view\/|currentJobId=)(\d+)/.test(targetTab.url);
    if (!hasJobId && !targetTab.url.includes('/jobs/')) {
      const notJobMsg = 'Open a specific job listing first';
      notify(`⚠️ ${notJobMsg}`, true);
      return { status: 'error', message: notJobMsg };
    }

    await chrome.tabs.update(targetTab.id, { active: true }).catch(() => {});
    browserContext.updateCurrentTabId(targetTab.id);

    notify('🔍 Connecting to LinkedIn tab & inspecting job listing...');
    const currentPage = await browserContext.getCurrentPage();

    // Quickly inspect top-card for title/company (non-blocking fallback)
    const topCard = await currentPage.extractJobTopCardContext(2000).catch(() => null);

    if (topCard?.isLoginWall) {
      notify('⚠️ LinkedIn login required. Please log in to LinkedIn first.', true);
      return { status: 'error', message: 'Please log in to LinkedIn first' };
    }

    // Extract title, company, location or fallback cleanly to tab title
    const rawTabTitle = targetTab.title?.replace(/\s*\|\s*LinkedIn$/i, '').trim() || '';
    const jobTitle = topCard?.title || (hasJobId ? rawTabTitle : '') || '';
    const company = topCard?.company || '';
    const location = topCard?.location || '';

    if (!jobTitle || /^(?:feed|linkedin|notifications|messaging|home)$/i.test(jobTitle.trim())) {
      const notJobMsg = 'Open a specific job listing first';
      notify(`⚠️ ${notJobMsg}`, true);
      return { status: 'error', message: notJobMsg };
    }

    const jobTitleDisplay = company ? `${jobTitle} at ${company}` : jobTitle;
    const jobIdMatch = targetTab.url.match(/(?:\/jobs\/view\/|currentJobId=)(\d+)/);
    const jobId = jobIdMatch?.[1] || `${Date.now()}`;
    const canonicalUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;

    // Duplicate check in processed jobs store
    const processedCheck = await processedJobsStore.isJobProcessed(jobId);
    if (processedCheck.isProcessed && processedCheck.status === 'applied') {
      const msg = `Job "${jobTitleDisplay}" was already applied previously`;
      notify(`ℹ️ Skipping (0 credits): ${msg}`);
      return { status: 'skipped', message: msg };
    }

    // Already applied on page check
    if (topCard?.isAlreadyApplied) {
      const appliedMsg = `Job "${jobTitleDisplay}" already shows as Applied on LinkedIn.`;
      notify(`ℹ️ Skipping (0 credits): ${appliedMsg}`);
      await processedJobsStore.recordJob({
        jobId,
        url: canonicalUrl,
        title: jobTitle,
        company,
        status: 'applied',
        reason: 'Already applied on LinkedIn',
        creditsUsed: 0,
      });
      return { status: 'skipped', message: appliedMsg };
    }

    notify(`🎯 Target Job: "${jobTitleDisplay}". Launching Autonomous Planner & Navigator...`);

    const details = buildLinkedInApplyTaskDetails(careerBrain, jobTitle, company, location);
    const taskPrompt = details.taskPrompt;
    const notProvidedFields = details.notProvidedFields;

    console.debug('[JobApplyAgent] LinkedIn prompt builder | NOT PROVIDED fields:', notProvidedFields);
    logger.debug(`[JobApplyAgent] LinkedIn prompt builder | NOT PROVIDED fields: ${JSON.stringify(notProvidedFields)}`);

    taskId = `easy_apply_${jobId}_${Date.now()}`;
    activeJobTaskId = taskId;

    // Clean up previous executor if any
    if (currentExecutor) {
      await currentExecutor.cleanup().catch(() => {});
      currentExecutor = null;
    }

    notify('🚀 Launching LLM Planner & Navigator (1 action per step)...');

    const executor = await setupExecutor(
      taskId,
      taskPrompt,
      browserContext,
      {
        maxActionsPerStep: 1, // Single deliberate action per step - eliminates stale CDP indices
        planningInterval: 1, // Re-plan after every single action to check modal state
        maxSteps: 25, // Ample steps for complete modal progression
      },
      true, // isJobApplyRun = true (set ONLY by applyToCurrentActiveJob and queue-apply flow)
    );

    currentExecutor = executor;
    await subscribeToExecutorEvents(executor);

    const execResult = await executor.execute();

    if (!execResult || !execResult.success) {
      const failReason = execResult?.reason || 'Application failed or submission could not be verified.';
      logger.error(`❌ Application failed for "${jobTitleDisplay}": ${failReason}`);
      notify(`❌ Application failed: ${failReason}`, true);

      await processedJobsStore.recordJob({
        jobId,
        url: canonicalUrl,
        title: jobTitle,
        company,
        status: 'failed',
        reason: failReason,
        creditsUsed: 0,
      });

      // Refund credits via server computing amount from ledger for this taskId
      logger.info(`[Credits] Requesting server-computed refund for runId: ${taskId}`);
      await backendApiClient.refundCredits(taskId).catch(e => {
        logger.error('Failed to refund credits:', e);
      });
      return { status: 'error', message: failReason };
    }

    // Success! Record to processed jobs store
    await processedJobsStore.recordJob({
      jobId,
      url: canonicalUrl,
      title: jobTitle,
      company,
      status: 'applied',
      creditsUsed: 0,
    });

    // Only increment daily quota when run was a verified success!
    await DailyQuotaManager.incrementAppliedCount();
    // Unlock Gate: Record verified single application success!
    await queueSafetyStore.setSingleApplyVerified(true);
    logger.info('[QueueSafety] Recorded verified single application success! Queue mode unlocked.');
    notify(`🎉 Successfully completed application for "${jobTitleDisplay}"!`);
    return { status: 'success', message: `Applied to ${jobTitleDisplay}` };
  } catch (err: any) {
    const errorMsg = String(err?.message || err);
    notify(`⚠️ Application stopped: ${errorMsg}`, true);
    // Refund credits on unexpected exception
    if (taskId) {
      await backendApiClient.refundCredits(taskId).catch(e => {
        logger.error('Failed to refund credits on error:', e);
      });
    }
    return { status: 'error', message: errorMsg };
  } finally {
    isJobApplyInProgress = false;
    activeJobTaskId = null;
  }
}

/**
 * Validates active LinkedIn tab and dispatches START_HARVESTING to content script
 * Uses URL pattern matching across all windows to avoid side panel / devtools focus interception
 */
async function triggerLinkedInHarvesting(_targetTabId?: number, portToSend?: chrome.runtime.Port | null) {
  // Check unlock gate: Single verified application required before queue harvesting
  const isVerified = await queueSafetyStore.isSingleApplyVerified();
  if (!isVerified) {
    const lockMsg = '🛑 Queue locked: Complete one successful single application first to unlock the queue.';
    logger.warning(lockMsg);
    if (portToSend) {
      portToSend.postMessage({
        actor: Actors.SYSTEM,
        state: ExecutionState.TASK_FAIL,
        data: {
          taskId: `task_gate_${Date.now()}`,
          step: 1,
          maxSteps: 1,
          details: lockMsg,
        },
      });
    }
    return;
  }

  // 1. Active tab check karne ki jagah hum URL pattern match karenge (Window focus ka issue khatam)
  chrome.tabs.query({ url: '*://*.linkedin.com/jobs/*' }, tabs => {
    let linkedInTab = tabs && tabs.length > 0 ? tabs[0] : null;

    const proceedWithTab = (activeTab: chrome.tabs.Tab) => {
      if (!activeTab.id) return;

      console.log('🚀 Found LinkedIn tab:', activeTab.id, activeTab.url);
      logger.info(`Found LinkedIn jobs tab: ${activeTab.id} -> ${activeTab.url}`);

      // Bring tab to focus
      chrome.tabs.update(activeTab.id, { active: true }).catch(() => {});

      if (portToSend) {
        portToSend.postMessage({
          actor: Actors.SYSTEM,
          state: ExecutionState.TASK_START,
          data: {
            taskId: `task_${Date.now()}`,
            step: 1,
            maxSteps: 15,
            details: '🔍 Scanning LinkedIn page & scrolling to harvest Easy Apply jobs (approx 10-15s)...',
          },
        });
      }

      const targetTabId = activeTab.id;
      if (!targetTabId) return;

      const sendHarvestCmd = () => {
        chrome.tabs.sendMessage(targetTabId, { type: 'START_HARVESTING', targetCount: 15 }, res => {
          if (chrome.runtime.lastError) {
            logger.warning('Failed to contact jobHarvester script:', chrome.runtime.lastError.message);
            // Auto inject content script and retry once
            chrome.scripting.executeScript(
              {
                target: { tabId: targetTabId },
                files: ['content/index.iife.js'],
              },
              () => {
                if (chrome.runtime.lastError) {
                  if (portToSend) {
                    portToSend.postMessage({
                      actor: Actors.SYSTEM,
                      state: ExecutionState.TASK_FAIL,
                      data: {
                        taskId: `task_${Date.now()}`,
                        step: 1,
                        maxSteps: 1,
                        details: '⚠️ Please refresh the LinkedIn jobs page and click Auto-Apply again.',
                      },
                    });
                  }
                } else {
                  setTimeout(() => {
                    chrome.tabs.sendMessage(targetTabId, { type: 'START_HARVESTING', targetCount: 15 });
                  }, 500);
                }
              },
            );
          } else {
            console.log('🚀 Sent START_HARVESTING to LinkedIn tab:', targetTabId, res);
            logger.info('Sent START_HARVESTING to tab', targetTabId, res);
          }
        });
      };

      sendHarvestCmd();
    };

    if (linkedInTab) {
      proceedWithTab(linkedInTab);
    } else {
      const errorMsg =
        '[background] ⚠️ Please open a LinkedIn Job Search page (e.g. linkedin.com/jobs) before starting Auto-Apply.';
      console.error(errorMsg);
      logger.warning(errorMsg);
      if (portToSend) {
        portToSend.postMessage({
          actor: Actors.SYSTEM,
          state: ExecutionState.TASK_FAIL,
          data: {
            taskId: `task_${Date.now()}`,
            step: 1,
            maxSteps: 1,
            details: '⚠️ Please open a LinkedIn Job Search page before starting Auto-Apply.',
          },
        });
      }
    }
  });
}

// Setup side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => console.error(error));

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId && changeInfo.status === 'complete' && tab.url?.startsWith('http')) {
    await injectBuildDomTreeScripts(tabId);
  }
});

// Listen for debugger detached event (e.g. when DevTools is opened or tab is closed)
chrome.debugger.onDetach.addListener(async (source, reason) => {
  logger.warning('Debugger detached:', source, reason);
  const tabId = source.tabId;

  // Ignore detachment if no job application or executor run is active, or if target closed normally
  if (!isJobApplyInProgress && !dedicatedJobRunner.isJobRunning() && !activeJobTaskId) {
    logger.info('Debugger detached outside active run. Ignoring.');
    await browserContext.cleanup().catch(() => {});
    return;
  }

  // Only broadcast DevTools conflict when detachment is canceled by user (DevTools conflict)
  if (reason === 'canceled_by_user') {
    const detachMsg =
      '🛑 Lost control of the tab (DevTools opened on it?). Please close DevTools on the job tab and retry.';

    // Notify side panel UI immediately to halt and show clear message
    if (currentPort) {
      try {
        currentPort.postMessage({
          actor: Actors.SYSTEM,
          state: ExecutionState.TASK_FAIL,
          data: {
            taskId: activeJobTaskId || `detached_${Date.now()}`,
            step: 1,
            maxSteps: 1,
            details: detachMsg,
          },
        });
      } catch {}
    }
  }

  // Automatic credit refund if detachment occurred during an active job run
  if (activeJobTaskId) {
    const refundId = activeJobTaskId;
    activeJobTaskId = null;
    logger.info(`[Credits] Refunding credits due to debugger detachment for task: ${refundId}`);
    await backendApiClient.refundCredits(refundId).catch(err => {
      logger.error('Failed to refund credits on debugger detach:', err);
    });
  }

  // Handle dedicated runner if active
  await dedicatedJobRunner.handleDebuggerDetach(tabId).catch(() => {});

  if (currentExecutor) {
    currentExecutor.cancel();
    currentExecutor = null;
  }
  await browserContext.cleanup().catch(() => {});
});

// Cleanup when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
  browserContext.removeAttachedPage(tabId);
});

logger.info('background loaded');

// Initialize analytics
analytics.init().catch(error => {
  logger.error('Failed to initialize analytics:', error);
});

// Listen for analytics settings changes
analyticsSettingsStore.subscribe(() => {
  analytics.updateSettings().catch(error => {
    logger.error('Failed to update analytics settings:', error);
  });
});

// Listen for messages (e.g., from options page, content scripts, or chat triggers)
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // -1. Forward live progress steps from content script to Side Panel
  if (request.type === 'APPLY_STEP_UPDATE') {
    if (currentPort) {
      try {
        currentPort.postMessage({
          actor: Actors.SYSTEM,
          state: request.isError ? ExecutionState.STEP_FAIL : ExecutionState.STEP_OK,
          data: {
            taskId: `current_job_${Date.now()}`,
            step: 1,
            maxSteps: 1,
            details: request.details,
          },
        });
      } catch {}
    }
    return false;
  }

  // 0a. APPLY BY URL: Dedicated Window Job Runner (Milestone M0)
  if (request.type === 'START_JOB_BY_URL') {
    dedicatedJobRunner
      .runJobByUrl({
        inputUrl: request.url,
        portToSend: currentPort,
        onLiveActivity: activity => {
          if (currentPort) {
            try {
              currentPort.postMessage({
                type: 'LIVE_ACTIVITY_UPDATE',
                data: activity,
              });
            } catch {}
          }
        },
      })
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: 'error', message: String(err) }));
    return true;
  }

  // 0. DIRECT APPLY: Instant application on currently active LinkedIn tab
  if (request.type === 'APPLY_CURRENT_JOB') {
    applyToCurrentActiveJob(currentPort)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ status: 'error', message: String(err) }));
    return true;
  }

  // 0b. SOLVE SCREENING QUESTIONS: AI question solver using Resume & CareerBrain context
  if (request.type === 'SOLVE_SCREENING_QUESTIONS') {
    (async () => {
      try {
        const careerBrain = await careerBrainStore.getCareerBrain();
        const llm = await getActiveChatModel();
        const questions = request.questions || [];
        logger.info(`[background] Solving ${questions.length} screening questions with CareerBrain & LLM...`);
        const solutions = await solveQuestions(questions, careerBrain, llm);
        logger.info(`[background] Successfully solved ${solutions.length} questions.`);
        sendResponse({ success: true, solutions });
      } catch (err) {
        logger.error('Failed to solve screening questions:', err);
        sendResponse({ success: false, error: String(err), solutions: [] });
      }
    })();
    return true;
  }

  // 0c. ENRICH PROFILE FROM RESUME: One-time factual extraction of skills with years and screening fields
  if (request.type === 'ENRICH_PROFILE_FROM_RESUME') {
    (async () => {
      try {
        const resumeText = request.resumeText || '';
        if (!resumeText || resumeText.length < 30) {
          sendResponse({ success: false, error: 'Resume text is too short' });
          return;
        }

        const llm = await getActiveChatModel();
        if (!llm) {
          sendResponse({ success: false, error: 'No active LLM model available for enrichment' });
          return;
        }

        logger.info('[background] Enriching profile from resume text using active LLM...');
        const prompt = `You are a strict zero-hallucination resume intelligence auditor.
Your job is to extract factual attributes from the candidate's resume text.

CRITICAL RULES:
1. STRICT ZERO INVENTION & ZERO FABRICATION: Never invent, guess, or assume facts not explicitly stated. NEVER default to arbitrary numbers.
2. EXPERIENCE CALCULATION:
   - Calculate total integer years of professional software/work experience (e.g. 0, 1, 3, 5) strictly based on verifiable employment history dates.
   - DO NOT count college or university degree duration (e.g. a 2020–2024 B.Tech is education, NOT 4 years of work experience).
   - If the candidate is a fresher or intern with under 1 year of work history, yearsOfExperience MUST be 0 (or 1 if at least 1 full year).
3. SKILLS & SKILL EXPERIENCE (skillExperience):
   - For every primary skill identified in "skills", include it in "skillExperience" with its estimated or verified years of experience.
   - If the resume explicitly states a duration for that skill (e.g. "React (3 years)", "4+ yrs Python experience"), use that duration.
   - If the skill was used in a dated work experience role, compute the years from that role's date range.
   - For other skills listed on the resume without explicit duration, set years to candidate's verifiable yearsOfExperience (minimum 1 year, e.g. fresher/intern = 1 year of project/academic experience).
   - NEVER assign random inflated numbers (e.g. NEVER assign 5+ years for a 1-year junior). Cap all skills at verifiable yearsOfExperience (minimum 1).
   - CONCRETE TECHNICAL TOOLS ONLY: Extract specific technologies, frameworks, libraries, databases, and languages (e.g. TypeScript, React, Python, PostgreSQL, Docker, AWS).
   - REJECT GENERIC TERMS & STOPWORDS: Never extract generic buzzwords or grammatical words (e.g. "ai", "ml", "ui", "ux", "and", "the", "developer", "engineering", "programming", "software", "tech", "skills").
   - LENGTH RULE: Reject any skill name under 3 characters unless it is a standard short programming language ("Go", "R", "C#", "C").
4. SCREENING FIELDS:
   - workAuthorization: If mentioned (e.g. "Authorized to work in India", "US Citizen", "No visa sponsorship required"), extract it. Otherwise null.
   - noticePeriod: If mentioned (e.g. "Immediate", "30 days", "2 weeks"), extract it. Otherwise null.
   - college: University or college name if mentioned, otherwise null.
   - education: Degree name (e.g. "B.Tech in Computer Science"), otherwise null.
   - yearsOfExperience: Total integer years of professional experience calculated from employment history dates, or null if cannot be determined.
5. WORK EXPERIENCE (STRUCTURED):
   - Extract factual work history positions present in the resume.
   - For each role:
     {
       "company": "Company Name",
       "title": "Job Title",
       "startMonth": "Month or empty string",
       "startYear": "Year (e.g. 2023) or empty string",
       "endMonth": "Month or null if current",
       "endYear": "Year or null if current",
       "isCurrent": true/false (true if currently working here / present),
       "description": "Brief summary of responsibilities & accomplishments"
     }
   - hasWorkExperience: true if one or more legitimate work/internship positions are found, false if candidate is a fresher with no work experience.
6. CANDIDATE BACKGROUND NARRATIVE (backgroundNarrative):
   - Synthesize a comprehensive, high-impact 2-3 paragraph professional narrative grounded strictly in the resume.
   - Paragraph 1: Professional identity, core specialization (e.g. Full Stack, Python, Frontend, MERN), total verifiable experience, and primary tech stack.
   - Paragraph 2: Key real-world projects or systems engineered, architectural decisions, databases, APIs, performance optimizations, and business impact.
   - Paragraph 3: Problem solving philosophy, engineering best practices (testing, CI/CD, clean code), and collaboration strengths.
7. GOLDEN SCREENING ANSWERS (goldenAnswers):
   - Generate calibrated baseline gatekeeper screening answers based on the candidate's factual location, legal eligibility, work authorization, visa sponsorship, and age from the resume:
     [
       {
         "id": "work_auth",
         "question": "Are you legally authorized to work in India / your resident country?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "visa_sponsorship",
         "question": "Will you now or in the future require visa sponsorship?",
         "answer": "No",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "age_requirement",
         "question": "Are you at least 18 years of age or older?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       }
     ]

Return valid JSON ONLY matching this format:
{
  "skillExperience": { "SkillName": 3 },
  "workAuthorization": string or null,
  "noticePeriod": string or null,
  "college": string or null,
  "education": string or null,
  "yearsOfExperience": number or null,
  "hasWorkExperience": boolean,
  "backgroundNarrative": "A rich 2-3 paragraph narrative describing candidate background, projects, strengths...",
  "goldenAnswers": [
    {
      "id": "work_auth",
      "question": "Are you legally authorized to work in India / your resident country?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "visa_sponsorship",
      "question": "Will you now or in the future require visa sponsorship?",
      "answer": "No",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "age_requirement",
      "question": "Are you at least 18 years of age or older?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    }
  ],
  "workExperience": [
    {
      "company": "Company Name",
      "title": "Job Title",
      "startMonth": "Jan",
      "startYear": "2023",
      "endMonth": null,
      "endYear": null,
      "isCurrent": true,
      "description": "Responsibilities and accomplishments"
    }
  ]
}

=== CANDIDATE RESUME TEXT ===
${resumeText.slice(0, 12000)}
`;

        const res = await llm.invoke([
          new SystemMessage('You are a strict factual resume intelligence extractor. Output valid JSON only.'),
          new HumanMessage(prompt),
        ]);

        let raw = typeof res.content === 'string' ? res.content : String(res.content);
        raw = raw.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
        raw = raw
          .replace(/```(?:json)?/gi, '')
          .replace(/```/g, '')
          .trim();

        const firstBrace = raw.indexOf('{');
        const lastBrace = raw.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
          raw = raw.substring(firstBrace, lastBrace + 1);
        }

        const parsed = JSON.parse(raw);

        // 1. Sanitize extracted workExperience first
        if (Array.isArray(parsed.workExperience)) {
          parsed.workExperience = parsed.workExperience
            .filter((item: any) => item && (item.company || item.title))
            .map((item: any) => ({
              id: item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
              company: String(item.company || '').trim(),
              title: String(item.title || '').trim(),
              startMonth: String(item.startMonth || '').trim(),
              startYear: String(item.startYear || '').trim(),
              endMonth: item.isCurrent ? null : item.endMonth ? String(item.endMonth).trim() : null,
              endYear: item.isCurrent ? null : item.endYear ? String(item.endYear).trim() : null,
              isCurrent: Boolean(item.isCurrent),
              description: String(item.description || '').trim(),
              source: 'resume',
            }));
          if (parsed.workExperience.length > 0) {
            parsed.hasWorkExperience = true;
          }
        }

        // 2. Sanitize extracted skillExperience against verifiable work dates & resume text
        if (parsed.skillExperience && typeof parsed.skillExperience === 'object') {
          parsed.skillExperience = validateAndSanitizeSkillExperience(
            parsed.skillExperience,
            parsed.workExperience,
            resumeText,
            parsed.yearsOfExperience,
          );
        } else {
          parsed.skillExperience = {};
        }

        // 2b. Auto-seed ALL extracted Primary Skills into skillExperience
        const candidateTenure = Math.max(1, Math.min(parsed.yearsOfExperience || 1, 99));
        if (Array.isArray(parsed.skills)) {
          for (const skill of parsed.skills) {
            const clean = cleanSkillName(skill);
            if (isValidSkillName(clean) && (!parsed.skillExperience[clean] || parsed.skillExperience[clean] <= 0)) {
              parsed.skillExperience[clean] = candidateTenure;
            }
          }
        }

        // 3. Sanitize location fields
        if (parsed.preferredLocation) {
          parsed.preferredLocation = cleanLocationForCityField(parsed.preferredLocation) || parsed.preferredLocation;
        }
        if (parsed.currentLocation) {
          parsed.currentLocation = cleanLocationForCityField(parsed.currentLocation) || parsed.currentLocation;
        }

        // 4. Sanitize backgroundNarrative
        if (parsed.backgroundNarrative && typeof parsed.backgroundNarrative === 'string') {
          parsed.backgroundNarrative = parsed.backgroundNarrative.trim();
        }

        // 5. Sanitize goldenAnswers
        if (Array.isArray(parsed.goldenAnswers)) {
          parsed.goldenAnswers = parsed.goldenAnswers
            .filter((item: any) => item && item.question && item.answer)
            .map((item: any) => ({
              id: String(item.id || `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
              question: String(item.question).trim(),
              answer: String(item.answer).trim(),
              category: item.category || 'Eligibility / Legal',
              isDefault: Boolean(item.isDefault ?? true),
            }));
        }

        logger.info('[background] Successfully extracted enrichment data from resume:', parsed);
        sendResponse({ success: true, data: parsed });
      } catch (err) {
        logger.warning('[background] Resume enrichment failed:', err);
        sendResponse({ success: false, error: String(err) });
      }
    })();
    return true;
  }

  // 0d. CAREER COPILOT CHAT: Conversational Profile Q&A, Auto-Fill, Job Fit & Pitch Engine
  if (request.type === 'CAREER_COPILOT_CHAT') {
    (async () => {
      try {
        const { userMessage, chatHistory } = request;
        let activeTabInfo: { url?: string; title?: string; pageText?: string } | undefined = undefined;

        try {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id && activeTab?.url?.startsWith('http')) {
            const results = await chrome.scripting.executeScript({
              target: { tabId: activeTab.id },
              func: () => {
                const jobContainer = document.querySelector(
                  '.jobs-description, .job-details, [data-job-id], article, main',
                );
                return (jobContainer ? jobContainer.textContent : document.body.innerText) || '';
              },
            });
            activeTabInfo = {
              url: activeTab.url,
              title: activeTab.title,
              pageText: (results?.[0]?.result as string)?.slice(0, 10000) || '',
            };
          }
        } catch (tabErr) {
          logger.debug('[Copilot] Could not read active tab content:', tabErr);
        }

        const response = await careerCopilotEngine.processMessage({
          userMessage: userMessage || '',
          chatHistory: chatHistory || [],
          activeTab: activeTabInfo,
        });

        sendResponse({ success: true, response });
      } catch (err: any) {
        logger.error('[Copilot] Error in CAREER_COPILOT_CHAT:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // 0e. CAREER COPILOT AUDIT: Instant profile completeness scoring & missing field priority
  if (request.type === 'CAREER_COPILOT_AUDIT') {
    (async () => {
      try {
        const brain = await careerBrainStore.getCareerBrain();
        const audit = auditCareerBrain(brain);
        sendResponse({ success: true, audit });
      } catch (err: any) {
        logger.error('[Copilot] Error in CAREER_COPILOT_AUDIT:', err);
        sendResponse({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  // 1. NAYA ROUTE: Agar command "Start Auto-Apply" ya Queue start karne ka hai
  if (request.type === 'START_LINKEDIN_QUEUE') {
    console.log('🚀 Bypassing generic AI! Starting Deterministic Queue Manager...');

    (async () => {
      try {
        const isVerified = await queueSafetyStore.isSingleApplyVerified();
        if (!isVerified) {
          sendResponse({
            status: 'error',
            error: 'Complete one successful single application first to unlock the queue.',
          });
          return;
        }

        const queue = await queueManager.getQueueStatus();
        if (queue.pendingJobs && queue.pendingJobs.length > 0) {
          const llm = await getActiveChatModel();
          if (llm) queueManager.setModels({ llm });
          await queueManager.startQueueProcessing();
          sendResponse({ status: 'Queue Started' });
        } else {
          await triggerLinkedInHarvesting(undefined, currentPort);
          sendResponse({ status: 'Harvesting Initiated' });
        }
      } catch (err: any) {
        logger.error('Failed to start LinkedIn queue:', err);
        sendResponse({ status: 'error', error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // 2. PURANA ROUTE: General web browsing/chat commands ke liye
  if (request.type === 'START_AGENT_TASK') {
    const taskStr = request.task || '';
    const taskLower = taskStr.toLowerCase();

    // JOB APPLY INTERCEPTOR
    if (
      (taskLower.includes('apply') && taskLower.includes('job')) ||
      taskLower.includes('easy apply') ||
      taskLower.includes('auto apply') ||
      taskLower.includes('auto-apply')
    ) {
      console.log('🚀 Intercepted Job Task! Triggering Harvester first...');
      triggerLinkedInHarvesting(request.tabId, currentPort);
      sendResponse({ status: 'Harvesting Initiated' });
      return true; // Keep channel open
    }

    // Normal execution for other tasks
    if (request.tabId) {
      browserContext
        .switchTab(request.tabId)
        .then(() => setupExecutor(request.taskId || `task_${Date.now()}`, request.task, browserContext))
        .then(async executor => {
          currentExecutor = executor;
          subscribeToExecutorEvents(currentExecutor);
          const result = await executor.execute();
          sendResponse({ status: 'executed', result });
        })
        .catch(err => {
          logger.error('Failed to execute task:', err);
          sendResponse({ status: 'error', error: String(err) });
        });
      return true;
    }
  }

  // JAB HARVESTER APNA KAAM KHATAM KAR LEGA:
  if (request.type === 'HARVESTED_JOBS') {
    (async () => {
      const isVerified = await queueSafetyStore.isSingleApplyVerified();
      if (!isVerified) {
        logger.warning('[HARVESTED_JOBS] Cannot start queue: single apply is not verified.');
        sendResponse({
          status: 'error',
          error: 'Complete one successful single application first to unlock the queue.',
        });
        return;
      }

      const jobsCount = request.jobs?.length || 0;
      console.log(`✅ Harvester collected ${jobsCount} jobs! Injecting to Queue...`);

      const result = await queueManager.enqueueHarvestedJobs(request.jobs || []);
      if (currentPort) {
        currentPort.postMessage({
          actor: Actors.SYSTEM,
          state: ExecutionState.STEP_OK,
          data: {
            taskId: `task_harvest_${Date.now()}`,
            step: 1,
            maxSteps: Math.max(1, jobsCount),
            details: `✅ Harvester collected ${jobsCount} jobs! Added ${result.addedCount} new jobs to queue (Total pending: ${result.totalPending}). Starting application process...`,
          },
        });
      }

      if (jobsCount > 0 || result.totalPending > 0) {
        // 4. Ab asli apply process start karo!
        getActiveChatModel()
          .then(llm => {
            if (llm) queueManager.setModels({ llm });
            return queueManager.startQueueProcessing();
          })
          .catch(err => logger.error('Failed to start queue:', err));
        sendResponse({ status: 'Jobs queued and Processing Started', ...result });
      } else {
        if (currentPort) {
          currentPort.postMessage({
            actor: Actors.SYSTEM,
            state: ExecutionState.TASK_FAIL,
            data: {
              taskId: `task_harvest_${Date.now()}`,
              step: 1,
              maxSteps: 1,
              details:
                '⚠️ No new Easy Apply jobs found on this page. Try scrolling or checking if Easy Apply filter is active.',
            },
          });
        }
        sendResponse({ status: 'No jobs found' });
      }
    })();
    return true;
  }

  if (
    request.type === 'STOP_LINKEDIN_QUEUE' ||
    request.type === 'STOP_JOB_APPLY' ||
    request.type === 'STOP_AUTO_APPLY'
  ) {
    isJobApplyInProgress = false;
    if (currentExecutor) {
      currentExecutor.cancel();
    }
    dedicatedJobRunner.stop().catch(() => {});
    queueManager.stopQueue().then(() => {
      sendResponse({ status: 'stopped' });
    });
    return true;
  }

  if (request.type === 'GET_LINKEDIN_QUEUE_STATUS') {
    queueManager.getQueueStatus().then(queue => {
      sendResponse({ status: 'success', queue });
    });
    return true;
  }

  if (request.type === 'CLEAR_LINKEDIN_QUEUE') {
    queueManager.clearQueue().then(() => {
      sendResponse({ status: 'cleared' });
    });
    return true;
  }

  return false;
});

/**
 * Intercepts job-apply intents in AI Chat so they never run free-hand agents.
 * AI Chat replies directing the user to the unified "Start Auto Apply" button.
 */
async function handleJobApplyChatIntent(
  task: string,
  tabId: number | undefined,
  taskId: string | undefined,
  port: chrome.runtime.Port,
): Promise<boolean> {
  const urlMatch = task.match(/(https?:\/\/[^\s]*linkedin\.com\/jobs\/[^\s]+|linkedin\.com\/jobs\/[^\s]+)/i);
  const taskLower = task.toLowerCase().trim();

  const isJobApplyIntent = Boolean(
    urlMatch ||
      /^\s*(?:easy\s*)?apply(?:\s*(?:now|here|karo|please|kar do|krdo))?\s*$/i.test(taskLower) ||
      /\b(easy\s*apply|apply\s*karo|apply\s*job|job\s*apply|apply\s*to\s*this\s*job|apply\s*to\s*current\s*job|apply\s*for\s*this\s*job|apply\s*this\s*job|apply\s*here|apply\s*now|start\s*apply|please\s*apply)\b/i.test(
        taskLower,
      ) ||
      (/\bapply\b/i.test(taskLower) &&
        /\b(job|jobs|linkedin|position|opening|role|resume|profile|career)\b/i.test(taskLower)) ||
      (/\b(apply|applying|application)\b/i.test(taskLower) &&
        !/\b(css|style|styles|patch|filter|rule|formula|discount|promo|code)\b/i.test(taskLower)),
  );

  if (!isJobApplyIntent) {
    return false;
  }

  logger.info('[ChatIntent] Job-related intent detected in AI Chat. Directing user to Start Auto Apply button.');
  const replyText = "Please use the 'Start Auto Apply' button — this is being rebuilt.";
  port.postMessage({
    type: 'CHAT_DIRECT_REPLY',
    actor: Actors.SYSTEM,
    content: replyText,
    data: {
      taskId: taskId || `chat_apply_${Date.now()}`,
      step: 1,
      maxSteps: 1,
      details: replyText,
    },
  });
  return true;
}

// Setup connection listener for long-lived connections (e.g., side panel)
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'side-panel-connection') {
    const senderUrl = port.sender?.url;
    const senderId = port.sender?.id;

    if (!senderUrl || senderId !== chrome.runtime.id || senderUrl !== SIDE_PANEL_URL) {
      logger.warning('Blocked unauthorized side-panel-connection', senderId, senderUrl);
      port.disconnect();
      return;
    }

    currentPort = port;
    userQuestionManager.setPort(port);

    port.onMessage.addListener(async message => {
      try {
        switch (message.type) {
          case 'USER_QUESTION_ANSWER': {
            if (message.data?.questionId && message.data?.answer !== undefined) {
              await userQuestionManager.handleAnswer(message.data.questionId, String(message.data.answer));
            }
            break;
          }

          case 'USER_QUESTION_BATCH_ANSWER': {
            if (message.data?.batchId && message.data?.answers) {
              await userQuestionManager.handleBatchAnswer(message.data.batchId, message.data.answers);
            }
            break;
          }

          case 'apply_current_job': {
            applyToCurrentActiveJob(port).catch(err => {
              logger.error('Failed to apply to current job:', err);
            });
            break;
          }

          case 'start_linkedin_queue': {
            triggerLinkedInHarvesting(undefined, port);
            break;
          }

          case 'START_AUTO_APPLY': {
            if (isJobApplyInProgress || dedicatedJobRunner.isJobRunning()) {
              port.postMessage({
                type: 'LINKEDIN_STATUS_UPDATE',
                text: '⚠️ An Auto Apply run is already in progress.',
                status: 'fail',
              });
              break;
            }
            isJobApplyInProgress = true;
            dedicatedJobRunner
              .startAutonomousJobLoop({
                portToSend: port,
                maxJobs: message.maxJobs || 20,
                platform: message.platform || 'linkedin',
                runnerMode: message.runnerMode || 'tab',
              })
              .finally(() => {
                isJobApplyInProgress = false;
              })
              .catch(err => {
                logger.error('Failed in startAutonomousJobLoop:', err);
              });
            break;
          }

          case 'STOP_AUTO_APPLY':
          case 'STOP_JOB_APPLY':
          case 'stop_linkedin_queue': {
            isJobApplyInProgress = false;
            if (currentExecutor) {
              currentExecutor.cancel();
            }
            dedicatedJobRunner.stop().catch(err => {
              logger.error('Failed to stop dedicated runner:', err);
            });
            queueManager.stopQueue().catch(err => {
              logger.error('Failed to stop queue:', err);
            });
            break;
          }

          case 'heartbeat':
            // Acknowledge heartbeat
            port.postMessage({ type: 'heartbeat_ack' });
            break;

          case 'new_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_newTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            // Intercept job-apply intent so AI Chat NEVER uses the generic Planner/Navigator for job applications
            const handled = await handleJobApplyChatIntent(message.task, message.tabId, message.taskId, port);
            if (handled) {
              break;
            }

            await browserContext.switchTab(message.tabId).catch(err => {
              logger.warning('Failed to switch tab on new_task:', err);
            });
            currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
            subscribeToExecutorEvents(currentExecutor);

            const result = await currentExecutor.execute();
            logger.info('new_task execution result', message.tabId, result);
            break;
          }

          case 'follow_up_task': {
            if (!message.task) return port.postMessage({ type: 'error', error: t('bg_cmd_followUpTask_noTask') });
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });

            // Intercept job-apply intent in follow-up mode as well
            const handled = await handleJobApplyChatIntent(message.task, message.tabId, message.taskId, port);
            if (handled) {
              break;
            }

            logger.info('follow_up_task', message.tabId, message.task);

            // If executor exists, add follow-up task. Otherwise spawn fresh executor seamlessly.
            if (currentExecutor) {
              await browserContext.switchTab(message.tabId).catch(err => {
                logger.warning('Failed to switch tab on follow_up_task:', err);
              });
              currentExecutor.addFollowUpTask(message.task);
              // Re-subscribe to events in case the previous subscription was cleaned up
              subscribeToExecutorEvents(currentExecutor);
              const result = await currentExecutor.execute();
              logger.info('follow_up_task execution result', message.tabId, result);
            } else {
              logger.info(
                'follow_up_task: no active executor found, launching fresh executor for message',
                message.taskId,
              );
              await browserContext.switchTab(message.tabId).catch(err => {
                logger.warning('Failed to switch tab on follow_up_task:', err);
              });
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
              subscribeToExecutorEvents(currentExecutor);
              const result = await currentExecutor.execute();
              logger.info('follow_up_task execution result (fresh executor)', message.tabId, result);
            }
            break;
          }

          case 'cancel_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.cancel();
            break;
          }

          case 'resume_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_cmd_resumeTask_noTask') });
            await currentExecutor.resume();
            return port.postMessage({ type: 'success' });
          }

          case 'pause_task': {
            if (!currentExecutor) return port.postMessage({ type: 'error', error: t('bg_errors_noRunningTask') });
            await currentExecutor.pause();
            return port.postMessage({ type: 'success' });
          }

          case 'screenshot': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            const page = await browserContext.switchTab(message.tabId);
            const screenshot = await page.takeScreenshot();
            logger.info('screenshot', message.tabId, screenshot);
            return port.postMessage({ type: 'success', screenshot });
          }

          case 'state': {
            try {
              const browserState = await browserContext.getState(true);
              const elementsText = browserState.elementTree.clickableElementsToString(
                DEFAULT_AGENT_OPTIONS.includeAttributes,
              );

              logger.info('state', browserState);
              logger.info('interactive elements', elementsText);
              return port.postMessage({ type: 'success', msg: t('bg_cmd_state_printed') });
            } catch (error) {
              logger.error('Failed to get state:', error);
              return port.postMessage({ type: 'error', error: t('bg_cmd_state_failed') });
            }
          }

          case 'nohighlight': {
            const page = await browserContext.getCurrentPage();
            await page.removeHighlight();
            return port.postMessage({ type: 'success', msg: t('bg_cmd_nohighlight_ok') });
          }

          case 'speech_to_text': {
            try {
              if (!message.audio) {
                return port.postMessage({
                  type: 'speech_to_text_error',
                  error: t('bg_cmd_stt_noAudioData'),
                });
              }

              logger.info('Processing speech-to-text request...');

              // Get all providers for speech-to-text service
              const providers = await llmProviderStore.getAllProviders();

              // Create speech-to-text service with all providers
              const speechToTextService = await SpeechToTextService.create(providers);

              // Extract base64 audio data (remove data URL prefix if present)
              let base64Audio = message.audio;
              if (base64Audio.startsWith('data:')) {
                base64Audio = base64Audio.split(',')[1];
              }

              // Transcribe audio
              const transcribedText = await speechToTextService.transcribeAudio(base64Audio);

              logger.info('Speech-to-text completed successfully');
              return port.postMessage({
                type: 'speech_to_text_result',
                text: transcribedText,
              });
            } catch (error) {
              logger.error('Speech-to-text failed:', error);
              return port.postMessage({
                type: 'speech_to_text_error',
                error: error instanceof Error ? error.message : t('bg_cmd_stt_failed'),
              });
            }
          }

          case 'replay': {
            if (!message.tabId) return port.postMessage({ type: 'error', error: t('bg_errors_noTabId') });
            if (!message.taskId) return port.postMessage({ type: 'error', error: t('bg_errors_noTaskId') });
            if (!message.historySessionId)
              return port.postMessage({ type: 'error', error: t('bg_cmd_replay_noHistory') });
            logger.info('replay', message.tabId, message.taskId, message.historySessionId);

            try {
              // Switch to the specified tab
              await browserContext.switchTab(message.tabId);
              // Setup executor with the new taskId and a dummy task description
              currentExecutor = await setupExecutor(message.taskId, message.task, browserContext);
              subscribeToExecutorEvents(currentExecutor);

              // Run replayHistory with the history session ID
              const result = await currentExecutor.replayHistory(message.historySessionId);
              logger.debug('replay execution result', message.tabId, result);
            } catch (error) {
              logger.error('Replay failed:', error);
              return port.postMessage({
                type: 'error',
                error: error instanceof Error ? error.message : t('bg_cmd_replay_failed'),
              });
            }
            break;
          }

          default:
            return port.postMessage({ type: 'error', error: t('errors_cmd_unknown', [message.type]) });
        }
      } catch (error) {
        console.error('Error handling port message:', error);
        port.postMessage({
          type: 'error',
          error: error instanceof Error ? error.message : t('errors_unknown'),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      // this event is also triggered when the side panel is closed, so we need to cancel the task
      console.log('Side panel disconnected');
      userQuestionManager.cancelAll('Side panel closed');
      userQuestionManager.setPort(null);
      currentPort = null;
      currentExecutor?.cancel();
    });
  }
});

async function setupExecutor(
  taskId: string,
  task: string,
  browserContext: BrowserContext,
  customAgentOptions?: Partial<AgentOptions>,
  isJobApplyRun = false,
) {
  const providers = await llmProviderStore.getAllProviders();
  const session = await authStorage.getSession();

  const hasCloudAuth = Boolean(session?.token);
  const hasLocalProviders = Object.keys(providers).length > 0;

  if (!hasLocalProviders && !hasCloudAuth) {
    throw new Error(t('bg_setup_noApiKeys'));
  }

  let navigatorLLM: BaseChatModel;
  let plannerLLM: BaseChatModel | null = null;

  if (hasCloudAuth) {
    logger.info('Using Backend Managed LLM Gateway (/api/v1/llm/chat) for logged-in user');
    const backendBaseUrl = BACKEND_LLM_URL;
    const backendToken = session!.token;

    navigatorLLM = new ChatOpenAI({
      modelName: 'amazon.nova-lite-v1:0',
      apiKey: backendToken || undefined,
      configuration: {
        baseURL: backendBaseUrl,
        defaultHeaders: {
          Authorization: `Bearer ${backendToken}`,
          'x-run-id': taskId,
        },
      },
      temperature: 0.1,
      maxTokens: 4096,
    });
    plannerLLM = navigatorLLM;
  } else {
    // Clean up any legacy validator settings for backward compatibility
    await agentModelStore.cleanupLegacyValidatorSettings();

    const agentModels = await agentModelStore.getAllAgentModels();
    // verify if every provider used in the agent models exists in the providers
    for (const agentModel of Object.values(agentModels)) {
      if (!providers[agentModel.provider]) {
        throw new Error(t('bg_setup_noProvider', [agentModel.provider]));
      }
    }

    const navigatorModel = agentModels[AgentNameEnum.Navigator];
    if (!navigatorModel) {
      throw new Error(t('bg_setup_noNavigatorModel'));
    }
    // Log the provider config being used for the navigator
    const navigatorProviderConfig = providers[navigatorModel.provider];
    navigatorLLM = createChatModel(navigatorProviderConfig, navigatorModel);

    const plannerModel = agentModels[AgentNameEnum.Planner];
    if (plannerModel) {
      // Log the provider config being used for the planner
      const plannerProviderConfig = providers[plannerModel.provider];
      plannerLLM = createChatModel(plannerProviderConfig, plannerModel);
    }
  }

  // Apply firewall settings to browser context
  const firewall = await firewallStore.getFirewall();
  if (firewall.enabled) {
    browserContext.updateConfig({
      allowedUrls: firewall.allowList,
      deniedUrls: firewall.denyList,
    });
  } else {
    browserContext.updateConfig({
      allowedUrls: [],
      deniedUrls: [],
    });
  }

  const generalSettings = await generalSettingsStore.getSettings();
  browserContext.updateConfig({
    minimumWaitPageLoadTime: generalSettings.minWaitPageLoad / 1000.0,
    displayHighlights: generalSettings.displayHighlights,
  });

  const executor = new Executor(task, taskId, browserContext, navigatorLLM, {
    plannerLLM: plannerLLM ?? navigatorLLM,
    agentOptions: {
      maxSteps: customAgentOptions?.maxSteps ?? generalSettings.maxSteps,
      maxFailures: customAgentOptions?.maxFailures ?? generalSettings.maxFailures,
      maxActionsPerStep: customAgentOptions?.maxActionsPerStep ?? generalSettings.maxActionsPerStep,
      useVision: customAgentOptions?.useVision ?? generalSettings.useVision,
      useVisionForPlanner: true,
      planningInterval: customAgentOptions?.planningInterval ?? generalSettings.planningInterval,
    },
    generalSettings: generalSettings,
    isJobApplyRun,
  });

  return executor;
}

// Update subscribeToExecutorEvents to use port
async function subscribeToExecutorEvents(executor: Executor) {
  // Clear previous event listeners to prevent multiple subscriptions
  executor.clearExecutionEvents();

  // Subscribe to new events
  executor.subscribeExecutionEvents(async event => {
    try {
      if (currentPort) {
        currentPort.postMessage(event);
      }
    } catch (error) {
      logger.error('Failed to send message to side panel:', error);
    }

    if (
      event.state === ExecutionState.TASK_OK ||
      event.state === ExecutionState.TASK_FAIL ||
      event.state === ExecutionState.TASK_CANCEL
    ) {
      await currentExecutor?.cleanup();
    }
  });
}
