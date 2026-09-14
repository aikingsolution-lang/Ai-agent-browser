/**
 * LinkedIn Easy Apply — Form Filler
 *
 * Fills out form fields in the Easy Apply modal for contact information,
 * resumes, screening questions, and voluntary disclosures.
 * Uses native React prototype setters for reliable DOM input updates.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import type { ICareerBrain } from '@extension/storage';
import { solveScreeningQuestion, type QuestionSolution } from './questionSolver';
import type { IStepDetectionResult, IScreeningQuestion, ScreeningQuestionType } from './types';

const logger = createLogger('LinkedInFormFiller');

export interface FormFillResult {
  success: boolean;
  questionsAnswered: IScreeningQuestion[];
  needsManualReview: boolean;
  reason?: string;
}

export class LinkedInFormFiller {
  /**
   * Fills form inputs for the current step in the Easy Apply modal.
   */
  async fillCurrentStep(
    page: Page,
    stepResult: IStepDetectionResult,
    careerBrain: ICareerBrain,
    llm?: BaseChatModel,
  ): Promise<FormFillResult> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) {
      return {
        success: false,
        questionsAnswered: [],
        needsManualReview: true,
        reason: 'Puppeteer page not attached.',
      };
    }

    logger.info(`[FormFiller] Filling form fields for step: ${stepResult.stepType}...`);

    // 1. Special Handling for RESUME step
    if (stepResult.stepType === 'RESUME') {
      return this.handleResumeStep(page, careerBrain);
    }

    // 2. Discover form fields inside the modal
    const discoveredQuestions = await this.discoverStepQuestions(page);
    const answeredQuestions: IScreeningQuestion[] = [];

    for (const question of discoveredQuestions) {
      // Solve question using Career Brain context
      const solution: QuestionSolution = await solveScreeningQuestion(question, careerBrain, llm);

      if (question.required && !solution.isConfident) {
        logger.warning(
          `[FormFiller] ⚠️ Required question cannot be answered confidently: "${question.questionText}". Flagging NEEDS_MANUAL_REVIEW.`,
        );
        return {
          success: false,
          questionsAnswered: answeredQuestions,
          needsManualReview: true,
          reason: `Uncertain about required question "${question.questionText}". Manual review required.`,
        };
      }

      // Fill in DOM
      if (solution.answer) {
        const fillSuccess = await this.fillFormFieldInDOM(page, question, solution.answer);
        if (fillSuccess) {
          answeredQuestions.push({
            ...question,
            userAnswer: solution.answer,
          });
        }
      }
    }

    return {
      success: true,
      questionsAnswered: answeredQuestions,
      needsManualReview: false,
    };
  }

  /**
   * Handles the RESUME step.
   * If existing uploaded resumes are listed, selects the top/latest one.
   * If a file upload is required, prepares attachment.
   */
  private async handleResumeStep(page: Page, _careerBrain: ICareerBrain): Promise<FormFillResult> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) return { success: false, questionsAnswered: [], needsManualReview: true };

    try {
      const resumeSelected = await puppeteerPage.evaluate(() => {
        const modal = document.querySelector(
          'div[role="dialog"][aria-modal="true"], .jobs-easy-apply-modal, div[data-test-modal]',
        );
        if (!modal) return { success: false, reason: 'Modal not found' };

        // Check for existing uploaded resume cards / radio options
        const resumeRadios = Array.from(
          modal.querySelectorAll<HTMLInputElement>(
            'input[type="radio"][name*="resume" i], .jobs-document-upload__file-input, .ui-attachment',
          ),
        );

        if (resumeRadios.length > 0) {
          // Select the first (most recent) resume option
          const targetRadio = resumeRadios[0];
          targetRadio.click();
          targetRadio.checked = true;
          targetRadio.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, selectedExisting: true };
        }

        // Check if there are clickable resume cards/items
        const resumeCards = Array.from(
          modal.querySelectorAll<HTMLElement>(
            'li.jobs-resume-picker__resume-list-item, div[data-test-resume-item], [aria-label*="resume" i]',
          ),
        );

        if (resumeCards.length > 0) {
          resumeCards[0].click();
          return { success: true, selectedExisting: true };
        }

        // Check if file upload button is present
        const fileInput = modal.querySelector<HTMLInputElement>('input[type="file"]');
        if (fileInput) {
          return { success: true, needsUpload: true };
        }

        return { success: true, reason: 'Resume step has no selectable cards or already selected' };
      });

      logger.info('[FormFiller] Resume step evaluated:', resumeSelected);

      return {
        success: true,
        questionsAnswered: [
          {
            questionId: 'resume_selection',
            questionText: 'Select Resume',
            questionType: 'file_upload',
            required: true,
            options: [],
            userAnswer: 'Selected latest existing resume profile on file',
          },
        ],
        needsManualReview: false,
      };
    } catch (err) {
      logger.error('Error handling resume step:', err);
      return {
        success: false,
        questionsAnswered: [],
        needsManualReview: true,
        reason: 'Failed to process resume selection step.',
      };
    }
  }

  /**
   * Discovers all input fields, labels, selects, and radios inside the active modal.
   */
  private async discoverStepQuestions(page: Page): Promise<IScreeningQuestion[]> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) return [];

    try {
      return await puppeteerPage.evaluate(() => {
        const modal = document.querySelector(
          'div[role="dialog"][aria-modal="true"], .jobs-easy-apply-modal, div[data-test-modal]',
        );
        if (!modal) return [];

        const questions: Array<{
          questionId: string;
          questionText: string;
          questionType: ScreeningQuestionType;
          required: boolean;
          options: string[];
          userAnswer: null;
        }> = [];

        // 1. Text, Email, Tel, Numeric inputs and Textareas
        const textInputs = Array.from(
          modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
            'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], textarea',
          ),
        );

        textInputs.forEach((input, index) => {
          if (input.offsetParent === null) return; // invisible

          // Extract associated label text
          let labelText = '';
          if (input.id) {
            const labelEl = modal.querySelector(`label[for="${input.id}"]`);
            if (labelEl) labelText = (labelEl.textContent || '').trim();
          }

          if (!labelText) {
            const parentLabel = input.closest('label');
            if (parentLabel) labelText = (parentLabel.textContent || '').trim();
          }

          if (!labelText) {
            labelText =
              input.getAttribute('aria-label') || input.getAttribute('placeholder') || `Question ${index + 1}`;
          }

          const isRequired = input.required || input.getAttribute('aria-required') === 'true';
          const isNumeric = input.type === 'number' || labelText.toLowerCase().includes('how many years');

          questions.push({
            questionId: input.id || `input_${index}`,
            questionText: labelText,
            questionType: isNumeric ? 'numeric' : 'text',
            required: isRequired,
            options: [],
            userAnswer: null,
          });
        });

        // 2. Select Dropdowns
        const selects = Array.from(modal.querySelectorAll<HTMLSelectElement>('select'));
        selects.forEach((select, index) => {
          if (select.offsetParent === null) return;

          let labelText = '';
          if (select.id) {
            const labelEl = modal.querySelector(`label[for="${select.id}"]`);
            if (labelEl) labelText = (labelEl.textContent || '').trim();
          }
          if (!labelText) {
            labelText = select.getAttribute('aria-label') || `Dropdown ${index + 1}`;
          }

          const options = Array.from(select.options)
            .map(o => o.text.trim())
            .filter(t => t && !t.toLowerCase().includes('select an option'));

          questions.push({
            questionId: select.id || `select_${index}`,
            questionText: labelText,
            questionType: 'single_select',
            required: select.required || select.getAttribute('aria-required') === 'true',
            options,
            userAnswer: null,
          });
        });

        // 3. Fieldsets / Radio Button Groups
        const fieldsets = Array.from(modal.querySelectorAll<HTMLFieldSetElement>('fieldset'));
        fieldsets.forEach((fieldset, index) => {
          if (fieldset.offsetParent === null) return;

          const legend = fieldset.querySelector('legend');
          const questionText = legend ? (legend.textContent || '').trim() : `Group ${index + 1}`;

          const radioInputs = Array.from(fieldset.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
          if (radioInputs.length > 0) {
            const options: string[] = [];
            radioInputs.forEach(radio => {
              const label = fieldset.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
              if (label) {
                options.push((label.textContent || '').trim());
              }
            });

            questions.push({
              questionId: fieldset.id || `fieldset_${index}`,
              questionText,
              questionType:
                options.length === 2 && options.some(o => o.toLowerCase() === 'yes') ? 'boolean' : 'single_select',
              required: true,
              options,
              userAnswer: null,
            });
          }
        });

        return questions;
      });
    } catch (err) {
      logger.error('Error discovering form questions:', err);
      return [];
    }
  }

  /**
   * Sets value on a form element in the page DOM using React-compatible events.
   */
  private async fillFormFieldInDOM(page: Page, question: IScreeningQuestion, answer: string): Promise<boolean> {
    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) return false;

    try {
      return await puppeteerPage.evaluate(
        (qId: string, qText: string, ans: string, qType: ScreeningQuestionType) => {
          const modal = document.querySelector(
            'div[role="dialog"][aria-modal="true"], .jobs-easy-apply-modal, div[data-test-modal]',
          );
          if (!modal) return false;

          // Helper to trigger React state setter with full event cycle
          const setReactInputValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
            input.focus();
            input.dispatchEvent(new Event('focus', { bubbles: true }));

            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              input instanceof HTMLTextAreaElement
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype,
              'value',
            )?.set;

            input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));

            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(input, value);
            } else {
              input.value = value;
            }

            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
          };

          // 1. Try finding input by ID
          if (qId) {
            const el = modal.querySelector<HTMLElement>(`#${qId}`);
            if (el) {
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                setReactInputValue(el, ans);
                return true;
              }
              if (el instanceof HTMLSelectElement) {
                for (let i = 0; i < el.options.length; i++) {
                  if (el.options[i].text.toLowerCase().includes(ans.toLowerCase())) {
                    el.selectedIndex = i;
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                  }
                }
              }
            }
          }

          // 2. Try radio buttons
          const radios = Array.from(modal.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
          for (const radio of radios) {
            const label = modal.querySelector(`label[for="${radio.id}"]`) || radio.closest('label');
            const labelText = (label?.textContent || '').trim().toLowerCase();
            if (labelText === ans.toLowerCase() || labelText.includes(ans.toLowerCase())) {
              radio.click();
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }

          // 3. Fallback: match by label text
          const labels = Array.from(modal.querySelectorAll<HTMLLabelElement>('label'));
          for (const label of labels) {
            if ((label.textContent || '').trim().toLowerCase().includes(qText.toLowerCase())) {
              const input = (label.querySelector('input, textarea, select') ||
                (label.htmlFor ? modal.querySelector(`#${label.htmlFor}`) : null)) as HTMLElement | null;

              if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
                setReactInputValue(input, ans);
                return true;
              }
            }
          }

          return false;
        },
        question.questionId,
        question.questionText,
        answer,
        question.questionType,
      );
    } catch (err) {
      logger.warning(`Failed to fill form field for "${question.questionText}":`, err);
      return false;
    }
  }
}

export const formFiller = new LinkedInFormFiller();
