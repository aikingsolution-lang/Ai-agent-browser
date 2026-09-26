import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
  CircuitBreakerTrippedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore, type GeneralSettingsConfig } from '@extension/storage';
import type { AgentStepHistory } from './history';
import { analytics } from '../services/analytics';
import { verifyTaskResult } from './evaluation';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  generalSettings?: GeneralSettingsConfig;
  isJobApplyRun?: boolean;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private tasks: string[] = [];
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
      extraArgs?.isJobApplyRun ?? false,
    );

    this.generalSettings = extraArgs?.generalSettings;
    this.tasks.push(task);
    this.navigatorPrompt = new NavigatorPrompt(context.options.maxActionsPerStep);
    this.plannerPrompt = new PlannerPrompt();

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(actionBuilder.buildDefaultActions());

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  public get isJobApplyRun(): boolean {
    return this.context.isJobApplyRun;
  }

  public set isJobApplyRun(val: boolean) {
    this.context.isJobApplyRun = val;
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private async checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): Promise<boolean> {
    if (planOutput?.result?.done) {
      // Guardrail against unsubmitted search inputs or intent mismatch
      const page = await this.context.browserContext.getCurrentPage().catch(() => null);
      const url = page ? page.url() : '';
      const state = page ? await page.getState().catch(() => null) : null;
      const title = state?.title || '';
      const lastAction = this.context.actionResults[this.context.actionResults.length - 1];
      const currentTask = this.tasks[this.tasks.length - 1] || '';
      const finalAnswer = planOutput.result.final_answer || '';

      const verification = verifyTaskResult(currentTask, {
        url,
        title,
        lastActionExtractedContent: lastAction?.extractedContent || finalAnswer || undefined,
      });

      if (!verification.isComplete) {
        logger.warning(`⚠️ Premature completion blocked: ${verification.reason}`);
        planOutput.result.done = false;
        planOutput.result.challenges = verification.reason || 'Verification failed';
        planOutput.result.next_steps = verification.retryAction || 'Please verify the page state and retry.';
        return false;
      }

      logger.info('✅ Planner confirms task completion and verification passed');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<{ success: boolean; reason?: string; finalAnswer?: string }>}
   */
  async execute(): Promise<{ success: boolean; reason?: string; finalAnswer?: string }> {
    logger.info(`🚀 Executing task: ${this.tasks[this.tasks.length - 1]}`);
    // reset the step counter
    const context = this.context;
    context.nSteps = 0;
    const allowedMaxSteps = this.context.options.maxSteps;

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      // Track task start
      void analytics.trackTaskStart(this.context.taskId);

      let step = 0;
      let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
      let navigatorDone = false;

      // Circuit Breaker State Tracking
      let consecutiveStuckSteps = 0;
      let lastObservedUrl = '';
      let lastObservedTitle = '';
      let lastFailedActionSignature = '';
      let consecutiveFailedActionCount = 0;
      let circuitBreakerTripped = false;
      let circuitBreakerReason = '';

      for (step = 0; step < allowedMaxSteps; step++) {
        context.stepInfo = {
          stepNumber: context.nSteps,
          maxSteps: context.options.maxSteps,
        };

        logger.info(`🔄 Step ${step + 1} / ${allowedMaxSteps}`);
        if (await this.shouldStop()) {
          break;
        }

        // ─── Circuit Breaker Defense: Pre-Flight Dead Page / 404 Check ───
        try {
          const currentPage = await this.context.browserContext.getCurrentPage();
          const currentUrl = currentPage.url() || '';
          const currentState = await currentPage.getState().catch(() => null);
          const currentTitle = currentState?.title || '';

          // 0. Option A: The CAPTCHA & Security Shield (Anomaly Detector)
          const captchaCheck = await currentPage.detectCaptchaOrSecurityCheck();
          if (captchaCheck.isCaptcha) {
            const pauseMsg = `🛡️ Security Challenge Detected: ${captchaCheck.type}. Pausing agent for human verification...`;
            logger.warning(pauseMsg);
            this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, pauseMsg);

            // Play audible beep or alert if available and notify user
            this.context.pause();

            // Wait until the human solves the CAPTCHA and page clears it
            let solved = false;
            for (let waitSec = 0; waitSec < 180; waitSec++) {
              // Max 3 minutes wait
              await new Promise(resolve => setTimeout(resolve, 2000));
              const recheck = await currentPage.detectCaptchaOrSecurityCheck().catch(() => ({ isCaptcha: false }));
              if (!recheck.isCaptcha) {
                solved = true;
                break;
              }
              // If user cancelled/stopped while waiting
              if (this.context.stopped) {
                break;
              }
            }

            if (solved) {
              logger.info('✅ Security Challenge cleared by user. Resuming autonomous pipeline...');
              this.context.resume();
              this.context.emitEvent(
                Actors.SYSTEM,
                ExecutionState.TASK_RESUME,
                'Security verification passed. Agent resumed.',
              );
            } else if (!this.context.stopped) {
              const failMsg =
                'Security challenge was not resolved within timeout (3 minutes). Execution aborted safely.';
              logger.error(failMsg);
              circuitBreakerTripped = true;
              circuitBreakerReason = failMsg;
              break;
            }
          }

          // 0. Hard Credit Budget Enforcement (150 Credits max per run)
          if (this.context.isJobApplyRun) {
            this.context.estimatedCreditsUsed += 10;
            if (this.context.estimatedCreditsUsed >= this.context.creditBudget) {
              circuitBreakerTripped = true;
              circuitBreakerReason = `Hard credit budget (${this.context.creditBudget} credits) reached for this run. Halted automatically to protect credit balance.`;
              logger.warning(`🛑 Circuit Breaker: ${circuitBreakerReason}`);
              break;
            }
          }

          // 1. Check for dead / removed job page signatures
          const deadPage = await currentPage.detectDeadJobOrErrorPage();
          if (deadPage.isDeadJob) {
            circuitBreakerTripped = true;
            circuitBreakerReason = `Dead/removed page detected ("${deadPage.reason}"). Application cannot proceed.`;
            logger.warning(`🛑 Circuit Breaker: ${circuitBreakerReason}`);
            break;
          }

          // 2. Check for stagnant page state / repetitive failure loop
          const lastAction = this.context.actionResults[this.context.actionResults.length - 1];
          const hasActionError = Boolean(lastAction?.error);

          if (hasActionError && lastAction?.error) {
            const errorSig = `${lastAction.error.slice(0, 80)}`;
            if (errorSig === lastFailedActionSignature) {
              consecutiveFailedActionCount++;
              logger.warning(
                `⚠️ Consecutive identical action failure (${consecutiveFailedActionCount}/2): ${errorSig}`,
              );
              if (consecutiveFailedActionCount >= 2) {
                circuitBreakerTripped = true;
                circuitBreakerReason = `Bot encountered repeated failures on the same action. Last error: ${lastAction.error}`;
                logger.error(`🚨 Circuit Breaker Tripped: ${circuitBreakerReason}`);
                break;
              }
            } else {
              lastFailedActionSignature = errorSig;
              consecutiveFailedActionCount = 1;
            }
          } else {
            lastFailedActionSignature = '';
            consecutiveFailedActionCount = 0;
          }

          if (hasActionError && currentUrl && currentUrl === lastObservedUrl && currentTitle === lastObservedTitle) {
            consecutiveStuckSteps++;
            logger.warning(
              `⚠️ Circuit Breaker: Action failed on same page state (${consecutiveStuckSteps}/3): "${currentTitle}"`,
            );
            if (consecutiveStuckSteps >= 3) {
              circuitBreakerTripped = true;
              circuitBreakerReason = `Bot encountered repeated failures on the same page state. Last error: ${lastAction?.error || 'Unknown error'}`;
              logger.error(`🚨 Circuit Breaker Tripped: ${circuitBreakerReason}`);
              break;
            }
          } else {
            // Action succeeded or page changed - reset stuck counter
            consecutiveStuckSteps = 0;
            lastObservedUrl = currentUrl;
            lastObservedTitle = currentTitle;
          }
        } catch (circuitErr) {
          logger.debug(`Circuit breaker pre-flight inspection error: ${circuitErr}`);
        }

        // Live confirmation check ONLY for explicit job apply runs (in case dialog is dismissed before done action)
        if (this.context.isJobApplyRun && !this.context.applicationSubmissionConfirmed) {
          try {
            const currentPage = await this.context.browserContext.getCurrentPage();
            const liveConfirmation = await currentPage.verifyApplicationConfirmation();
            if (liveConfirmation.confirmed) {
              this.context.applicationSubmissionConfirmed = true;
              this.context.submissionConfirmationMessage = liveConfirmation.message || null;
              logger.info(`[Executor] Live application submission confirmed: "${liveConfirmation.message}"`);
            }
          } catch {}
        }

        // Run planner periodically for guidance
        if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
          navigatorDone = false;
          latestPlanOutput = await this.runPlanner();

          // Check if task is complete after planner run
          if (latestPlanOutput?.result?.done) {
            break;
          }
        }

        // Execute navigator
        navigatorDone = await this.navigate();

        // If navigator indicates completion, the next periodic planner run will validate it
        if (navigatorDone) {
          logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
        }
      }

      // If Circuit Breaker tripped, mark as FAILED (red) - never as OK
      if (circuitBreakerTripped) {
        const failMessage = `Circuit Breaker Tripped: ${circuitBreakerReason}`;
        logger.error(`❌ ${failMessage}`);
        this.context.finalAnswer = failMessage;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, failMessage);
        const circuitError = new Error(failMessage);
        const errorCategory = analytics.categorizeError(circuitError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
        return { success: false, reason: failMessage };
      }

      // Determine task completion status
      const isCompleted = latestPlanOutput?.result?.done === true;

      if (isCompleted) {
        // Success verification on page: ONLY enforced when this.context.isJobApplyRun is explicitly true.
        // Normal AI Chat tasks never set this flag and are never affected by confirmation verification.
        if (this.context.isJobApplyRun) {
          let confirmed = this.context.applicationSubmissionConfirmed;
          let confirmationMessage: string | null = this.context.submissionConfirmationMessage || null;

          // If not already recorded during the run, check one last time on the page
          if (!confirmed) {
            const page = await this.context.browserContext.getCurrentPage();
            const confirmation = await page.verifyApplicationConfirmation();
            if (confirmation.confirmed) {
              confirmed = true;
              confirmationMessage = confirmation.message || null;
              this.context.applicationSubmissionConfirmed = true;
              this.context.submissionConfirmationMessage = confirmation.message || null;
            }
          }

          if (!confirmed) {
            const unverifiedMsg =
              'Application submission could not be verified on page (no submission confirmation found).';
            logger.error(`❌ Task failed verification: ${unverifiedMsg}`);
            this.context.finalAnswer = unverifiedMsg;
            this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, unverifiedMsg);
            void analytics.trackTaskFailed(this.context.taskId, 'UNVERIFIED_SUBMISSION');
            return { success: false, reason: unverifiedMsg };
          }
          logger.info(`✅ Submission verified on page: "${confirmationMessage || 'Application submitted'}"`);
        }

        // Emit final answer if available, otherwise use task ID
        const finalMessage = this.context.finalAnswer || this.context.taskId;
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);

        // Track task completion
        void analytics.trackTaskComplete(this.context.taskId);
        return { success: true, finalAnswer: finalMessage };
      } else if (step >= allowedMaxSteps) {
        logger.error('❌ Task failed: Max steps reached');
        const maxMsg = t('exec_errors_maxStepsReached');
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, maxMsg);

        // Track task failure with specific error category
        const maxStepsError = new MaxStepsReachedError(maxMsg);
        const errorCategory = analytics.categorizeError(maxStepsError);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
        return { success: false, reason: maxMsg };
      } else if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
        return { success: false, reason: 'Task cancelled by user' };
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
        return { success: false, reason: 'Task paused' };
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));

        // Track task cancellation
        void analytics.trackTaskCancelled(this.context.taskId);
        return { success: false, reason: 'Request cancelled' };
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));

        // Track task failure with detailed error categorization
        const errorCategory = analytics.categorizeError(error instanceof Error ? error : errorMessage);
        void analytics.trackTaskFailed(this.context.taskId, errorCategory);
        return { success: false, reason: errorMessage };
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      logger.error(`Failed to execute step: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute step: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
