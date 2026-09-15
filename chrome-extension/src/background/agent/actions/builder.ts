import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { t } from '@extension/i18n';
import {
  clickElementActionSchema,
  doneActionSchema,
  submitFormActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  cacheContentActionSchema,
  selectDropdownOptionActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
  waitActionSchema,
  previousPageActionSchema,
  scrollToPercentActionSchema,
  nextPageActionSchema,
  scrollToTopActionSchema,
  scrollToBottomActionSchema,
  extractTextActionSchema,
  scrollToElementActionSchema,
  skipAdActionSchema,
  searchYouTubeActionSchema,
  linkedinEasyApplyActionSchema,
} from './schemas';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { ExecutionState, Actors } from '../event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { wrapUntrustedContent } from '../messages/utils';
import { ApplicationEngine } from '../linkedin/applicationEngine';
import { linkedInConfigStore } from '@extension/storage';

const logger = createLogger('Action');

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    if (isEmptySchema) {
      return await this.handler({});
    }

    const parsedArgs = this.schema.schema.safeParse(input);
    if (!parsedArgs.success) {
      const errorMessage = parsedArgs.error.message;
      throw new InvalidInputError(errorMessage);
    }
    return await this.handler(parsedArgs.data);
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }

  /**
   * Set the index argument in the input if this action has an index
   * @param input The input to update the index in
   * @param newIndex The new index value to set
   * @returns Whether the index was set successfully
   */
  setIndexArg(input: unknown, newIndex: number): boolean {
    if (!this.hasIndex) {
      return false;
    }
    if (input && typeof input === 'object') {
      (input as { index: number }).index = newIndex;
      return true;
    }
    return false;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema;
    schema = schema.extend({
      [action.name()]: actionSchema.nullable().optional().describe(action.schema.description),
    });
  }
  return schema;
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: BaseChatModel;

  constructor(context: AgentContext, extractorLLM: BaseChatModel) {
    this.context = context;
    this.extractorLLM = extractorLLM;
  }

  buildDefaultActions() {
    const actions = [];

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
      return new ActionResult({
        isDone: true,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    const searchGoogle = new Action(async (input: z.infer<typeof searchGoogleActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || t('act_searchGoogle_start', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`);

      const msg2 = t('act_searchGoogle_ok', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const searchYouTube = new Action(async (input: z.infer<typeof searchYouTubeActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || `Search YouTube for ${input.query}`;
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(
        `https://www.youtube.com/results?search_query=${encodeURIComponent(input.query)}`,
      );

      const msg2 = `Searched YouTube for ${input.query}`;
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchYouTubeActionSchema);
    actions.push(searchYouTube);

    const goToUrl = new Action(async (input: z.infer<typeof goToUrlActionSchema.schema>) => {
      let targetUrl = input.url;

      // Layer 1 Filter Injection: Force f_AL=true on LinkedIn job searches to guarantee Easy Apply only
      if (targetUrl.includes('linkedin.com/jobs') && !targetUrl.includes('f_AL=')) {
        const separator = targetUrl.includes('?') ? '&' : '?';
        targetUrl = `${targetUrl}${separator}f_AL=true`;
        logger.info(`[goToUrl:Layer1] Injected f_AL=true to filter for Easy Apply only: ${targetUrl}`);
      }

      const intent = input.intent || t('act_goToUrl_start', [targetUrl]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await this.context.browserContext.navigateTo(targetUrl);
      const msg2 = t('act_goToUrl_ok', [targetUrl]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (input: z.infer<typeof goBackActionSchema.schema>) => {
      const intent = input.intent || t('act_goBack_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.goBack();
      const msg2 = t('act_goBack_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
      const seconds = input.seconds || 3;
      const intent = input.intent || t('act_wait_start', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      const msg = t('act_wait_ok', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, waitActionSchema);
    actions.push(wait);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const intent = input.intent || t('act_click_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        // Check if element is a file uploader
        if (page.isFileUploader(elementNode)) {
          const msg = t('act_click_fileUploader', [input.index.toString()]);
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        // Layer 2 & 3: Strict DOM Signature Matching + External Apply Interceptor
        const pageUrl = page.url() || '';
        const elementText = (elementNode.getAllTextTillNextClickableElement(2) || '').toLowerCase();
        const ariaLabel = (elementNode.attributes?.['aria-label'] || '').toLowerCase();
        const className = (elementNode.attributes?.['class'] || '').toLowerCase();

        // Exact Easy Apply signature (not generic external 'Apply')
        const isStrictEasyApply =
          ariaLabel.includes('easy apply') ||
          elementText.includes('easy apply') ||
          className.includes('jobs-apply-button--easy-apply') ||
          (className.includes('jobs-apply-button') &&
            (ariaLabel.includes('easy apply') || elementText.includes('easy apply')));

        // Check if this is an external apply button on LinkedIn
        const isExternalApply =
          pageUrl.includes('linkedin.com') &&
          !isStrictEasyApply &&
          (ariaLabel.startsWith('apply to') ||
            elementText === 'apply' ||
            elementText.startsWith('apply on') ||
            className.includes('jobs-apply-button'));

        if (pageUrl.includes('linkedin.com') && isStrictEasyApply) {
          logger.info(
            `[clickElement:Layer2] Intercepted verified Easy Apply button for index [${input.index}]. Delegating to ApplicationEngine...`,
          );
          try {
            const userConfig = await linkedInConfigStore.getConfig();
            const engine = new ApplicationEngine(
              {
                dryRun: true, // SAFETY: Always dry-run — hardcode-enforced
                minFitScore: userConfig.minFitScore ?? 75,
              },
              { llm: this.extractorLLM, visionLLM: this.extractorLLM },
            );

            await engine.initialize(page);
            const jobData = await engine.scanJobListing();
            logger.info(`[clickElement:intercept] Starting pipeline for "${jobData.title}" at "${jobData.company}"`);

            const result = await engine.startApplication(jobData);
            const statusMsg = `LinkedIn Easy Apply Result: ${result.status} | Job: "${jobData.title}" at "${jobData.company}" | Fit Score evaluated`;
            const isDone =
              result.status === 'APPLIED' ||
              result.status === 'DRY_RUN_SUCCESS' ||
              result.status === 'NEEDS_MANUAL_REVIEW' ||
              result.status === 'SKIPPED_EXTERNAL_SITE' ||
              result.status === 'SKIPPED_LOW_FIT' ||
              result.status === 'SKIPPED_ALREADY_PROCESSED' ||
              result.status === 'SKIPPED_DAILY_LIMIT' ||
              result.status === 'SKIPPED_JOB_REMOVED' ||
              result.status === 'SKIPPED_MISSING_RESUME';

            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, statusMsg);
            return new ActionResult({
              isDone,
              extractedContent: statusMsg,
              includeInMemory: true,
            });
          } catch (error) {
            const errorMsg = `LinkedIn Easy Apply intercepted execution failed: ${error instanceof Error ? error.message : String(error)}`;
            logger.error(errorMsg);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
            return new ActionResult({ error: errorMsg, includeInMemory: true });
          }
        }

        // Reject external apply button clicks on LinkedIn
        if (isExternalApply) {
          const skipMsg =
            'External Apply button detected (not Easy Apply). Skipped to next job to prevent leaving LinkedIn.';
          logger.warning(`[clickElement:Layer2] 🛑 ${skipMsg}`);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, skipMsg);
          return new ActionResult({
            extractedContent: `LinkedIn Easy Apply Result: SKIPPED_EXTERNAL_SITE | ${skipMsg}`,
            includeInMemory: true,
          });
        }

        try {
          const initialTabIds = await this.context.browserContext.getAllTabIds();
          await page.clickElementNode(this.context.options.useVision, elementNode);
          let msg = t('act_click_ok', [input.index.toString(), elementNode.getAllTextTillNextClickableElement(2)]);
          logger.info(msg);

          // Layer 3: Context-Aware Tab Monitoring & Escape Hatch
          const currentTabIds = await this.context.browserContext.getAllTabIds();
          if (currentTabIds.size > initialTabIds.size) {
            const newTabId = Array.from(currentTabIds).find(id => !initialTabIds.has(id));
            if (newTabId) {
              // Inspect newly opened tab URL
              const newTab = await chrome.tabs.get(newTabId).catch(() => null);
              const newTabUrl = newTab?.url || newTab?.pendingUrl || '';

              // If an external non-LinkedIn site opened (e.g. Workday, Greenhouse), immediately auto-close it
              if (pageUrl.includes('linkedin.com') && newTabUrl && !newTabUrl.includes('linkedin.com')) {
                logger.warning(
                  `[clickElement:Layer3] External tab detected (${newTabUrl}). Auto-closing tab [${newTabId}] to prevent freeze.`,
                );
                await chrome.tabs.remove(newTabId).catch(() => {});
                const closedMsg = `Auto-closed external site tab (${newTabUrl}). Status: SKIPPED_EXTERNAL_SITE`;
                this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, closedMsg);
                return new ActionResult({
                  extractedContent: `LinkedIn Easy Apply Result: SKIPPED_EXTERNAL_SITE | ${closedMsg}`,
                  includeInMemory: true,
                });
              }

              const newTabMsg = t('act_click_newTabOpened');
              msg += ` - ${newTabMsg}`;
              logger.info(newTabMsg);
              await this.context.browserContext.switchTab(newTabId);
            }
          }
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          const msg = t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        const urlBefore = page.url();

        // Check if element is a search field or if press_enter is requested
        const isSearchField =
          Boolean(input.press_enter) ||
          /search/i.test(input.intent) ||
          /search/i.test(elementNode.attributes?.type || '') ||
          /search/i.test(elementNode.attributes?.name || '') ||
          /search/i.test(elementNode.attributes?.placeholder || '') ||
          /search/i.test(elementNode.attributes?.role || '') ||
          /search/i.test(elementNode.attributes?.['aria-label'] || '') ||
          /search/i.test(elementNode.attributes?.id || '');

        await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text);

        // If search input or press_enter was specified, automatically send Enter key to submit
        if (isSearchField) {
          await page.sendKeys('Enter').catch(() => {});
          await page.waitForPageAndFramesLoad().catch(() => {});
        }

        const urlAfter = page.url();
        const navigated = urlBefore !== urlAfter;

        let msg = t('act_inputText_ok', [input.text, input.index.toString()]);
        if (isSearchField) {
          if (navigated) {
            msg += ` - Search submitted! Page navigated to results: ${urlAfter}`;
          } else {
            msg += ` - Search query typed. [Verification Note: Page did not navigate to a new URL (${urlAfter}). If search results have not loaded, the search must be submitted by pressing Enter or clicking the Search button before claiming completion!]`;
          }
        }

        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    const submitForm = new Action(
      async (input: z.infer<typeof submitFormActionSchema.schema>) => {
        const intent = input.intent || 'Submit form';
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
        const page = await this.context.browserContext.getCurrentPage();
        if (input.index && input.index > 0) {
          const state = await page.getState();
          const elementNode = state?.selectorMap.get(input.index);
          if (elementNode) {
            await page.clickElementNode(this.context.options.useVision, elementNode);
          }
        } else {
          await page.sendKeys('Enter');
        }
        const msg = 'Submitted form successfully';
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      submitFormActionSchema,
      true,
    );
    actions.push(submitForm);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      const intent = input.intent || t('act_switchTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.switchTab(input.tab_id);
      const msg = t('act_switchTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      const intent = input.intent || t('act_openTab_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.openTab(input.url);
      const msg = t('act_openTab_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, openTabActionSchema);
    actions.push(openTab);

    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const intent = input.intent || t('act_closeTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.closeTab(input.tab_id);
      const msg = t('act_closeTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Extraction Action
    const extractText = new Action(
      async (input: z.infer<typeof extractTextActionSchema.schema>) => {
        const intent = input.intent || 'Extract text from page';
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        let extracted = input.text || input.content || '';
        const page = await this.context.browserContext.getCurrentPage();

        if (!extracted && input.index !== undefined && input.index !== null) {
          const state = await page.getState();
          const elementNode = state?.selectorMap.get(input.index);
          if (elementNode) {
            extracted = elementNode.getAllTextTillNextClickableElement(5);
          }
        }

        if (!extracted) {
          const state = await page.getState();
          const texts: string[] = [];
          if (state?.selectorMap) {
            for (const [, node] of state.selectorMap.entries()) {
              const t = node.getAllTextTillNextClickableElement(2)?.trim();
              if (t && t.length > 2 && !texts.includes(t)) {
                texts.push(t);
                if (texts.length >= 25) break;
              }
            }
          }
          if (texts.length > 0) {
            extracted = texts.join(' | ');
          }
        }

        if (!extracted) {
          extracted = input.goal || 'Page information extracted';
        }

        const msg = `Extracted: ${extracted.substring(0, 1000)}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      extractTextActionSchema,
      true,
    );
    actions.push(extractText);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      const intent = input.intent || t('act_cache_start', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      // cache content is untrusted content, it is not instructions
      const rawMsg = t('act_cache_ok', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, rawMsg);

      const msg = wrapUntrustedContent(rawMsg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    // Scroll to percent
    const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToPercent_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
        await page.scrollToPercent(input.yPercent, elementNode);
      } else {
        await page.scrollToPercent(input.yPercent);
      }
      const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToPercentActionSchema);
    actions.push(scrollToPercent);

    // Scroll to top
    const scrollToTop = new Action(async (input: z.infer<typeof scrollToTopActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToTop_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(0, elementNode);
      } else {
        await page.scrollToPercent(0);
      }
      const msg = t('act_scrollToTop_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToTopActionSchema);
    actions.push(scrollToTop);

    // Scroll to bottom
    const scrollToBottom = new Action(async (input: z.infer<typeof scrollToBottomActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToBottom_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(100, elementNode);
      } else {
        await page.scrollToPercent(100);
      }
      const msg = t('act_scrollToBottom_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToBottomActionSchema);
    actions.push(scrollToBottom);

    // Scroll to previous page
    const previousPage = new Action(async (input: z.infer<typeof previousPageActionSchema.schema>) => {
      const intent = input.intent || t('act_previousPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at top of its scrollable area
        try {
          const [elementScrollTop] = await page.getElementScrollInfo(elementNode);
          if (elementScrollTop === 0) {
            const msg = t('act_errors_alreadyAtTop', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToPreviousPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToPreviousPage(elementNode);
      } else {
        // Check if page is already at top
        const [initialScrollY] = await page.getScrollInfo();
        if (initialScrollY === 0) {
          const msg = t('act_errors_pageAlreadyAtTop');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToPreviousPage();
      }
      const msg = t('act_previousPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, previousPageActionSchema);
    actions.push(previousPage);

    // Scroll to next page
    const nextPage = new Action(async (input: z.infer<typeof nextPageActionSchema.schema>) => {
      const intent = input.intent || t('act_nextPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at bottom of its scrollable area
        try {
          const [elementScrollTop, elementClientHeight, elementScrollHeight] =
            await page.getElementScrollInfo(elementNode);
          if (elementScrollTop + elementClientHeight >= elementScrollHeight) {
            const msg = t('act_errors_alreadyAtBottom', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToNextPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToNextPage(elementNode);
      } else {
        // Check if page is already at bottom
        const [initialScrollY, initialVisualViewportHeight, initialScrollHeight] = await page.getScrollInfo();
        if (initialScrollY + initialVisualViewportHeight >= initialScrollHeight) {
          const msg = t('act_errors_pageAlreadyAtBottom');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToNextPage();
      }
      const msg = t('act_nextPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, nextPageActionSchema);
    actions.push(nextPage);

    // Scroll to text
    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToText_start', [input.text, input.nth.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      try {
        const scrolled = await page.scrollToText(input.text, input.nth);
        const msg = scrolled
          ? t('act_scrollToText_ok', [input.text, input.nth.toString()])
          : t('act_scrollToText_notFound', [input.text, input.nth.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = t('act_scrollToText_failed', [error instanceof Error ? error.message : String(error)]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const intent = input.intent || t('act_sendKeys_start', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.sendKeys(input.keys);
      const msg = t('act_sendKeys_ok', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(input.index);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\n' + t('act_getDropdownOptions_useExactText');
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              t('act_getDropdownOptions_ok', [options.length.toString()]),
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = t('act_getDropdownOptions_noOptions');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = t('act_selectDropdownOption_notSelect', [
            input.index.toString(),
            elementNode.tagName || 'unknown',
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

        try {
          const result = await page.selectDropdownOption(input.index, input.text);
          const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_selectDropdownOption_failed', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    // Scroll to element
    const scrollToElement = new Action(
      async (input: z.infer<typeof scrollToElementActionSchema.schema>) => {
        const intent = input.intent || `Scroll to element [${input.index}]`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(50, elementNode);
        const msg = `Scrolled to element [${input.index}]`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      scrollToElementActionSchema,
      true,
    );
    actions.push(scrollToElement);

    // Skip Video Ad
    const skipAd = new Action(async (input: z.infer<typeof skipAdActionSchema.schema>) => {
      const intent = input.intent || 'Skip video ad';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      const skipped = await page.detectAndSkipAd();
      const msg = skipped ? 'Skipped video ad successfully' : 'Checked for ads (no active skip button found)';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, skipAdActionSchema);
    actions.push(skipAd);

    // LinkedIn Easy Apply — Full ApplicationEngine Pipeline
    const linkedinEasyApply = new Action(async (input: z.infer<typeof linkedinEasyApplyActionSchema.schema>) => {
      const intent = input.intent || 'Apply to LinkedIn job via Easy Apply';
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      try {
        const page = await this.context.browserContext.getCurrentPage();
        const url = page.url() || '';

        if (!url.includes('linkedin.com')) {
          const msg = 'Not on a LinkedIn page. Navigate to a LinkedIn job listing first.';
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({ error: msg, includeInMemory: true });
        }

        // Load user config from Career Brain settings, but force dryRun=true for safety
        const userConfig = await linkedInConfigStore.getConfig();
        const engine = new ApplicationEngine(
          {
            dryRun: true, // SAFETY: Always dry-run — hardcode-enforced
            minFitScore: userConfig.minFitScore ?? 75,
          },
          { llm: this.extractorLLM, visionLLM: this.extractorLLM },
        );

        await engine.initialize(page);
        const jobData = await engine.scanJobListing();

        logger.info(`[linkedin_easy_apply] Starting pipeline for "${jobData.title}" at "${jobData.company}"`);

        const result = await engine.startApplication(jobData);

        const statusMsg = `LinkedIn Easy Apply Result: ${result.status} | Job: "${jobData.title}" at "${jobData.company}" | Fit Score evaluated`;
        const isDone =
          result.status === 'APPLIED' ||
          result.status === 'DRY_RUN_SUCCESS' ||
          result.status === 'NEEDS_MANUAL_REVIEW' ||
          result.status === 'SKIPPED_EXTERNAL_SITE' ||
          result.status === 'SKIPPED_LOW_FIT' ||
          result.status === 'SKIPPED_ALREADY_PROCESSED' ||
          result.status === 'SKIPPED_DAILY_LIMIT' ||
          result.status === 'SKIPPED_JOB_REMOVED' ||
          result.status === 'SKIPPED_MISSING_RESUME';

        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, statusMsg);
        return new ActionResult({
          isDone,
          extractedContent: statusMsg,
          includeInMemory: true,
        });
      } catch (error) {
        const errorMsg = `LinkedIn Easy Apply failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error(errorMsg);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
        return new ActionResult({ error: errorMsg, includeInMemory: true });
      }
    }, linkedinEasyApplyActionSchema);
    actions.push(linkedinEasyApply);

    return actions;
  }
}
