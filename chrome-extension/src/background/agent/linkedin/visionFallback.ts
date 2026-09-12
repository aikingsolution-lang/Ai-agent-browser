/**
 * LinkedIn Easy Apply — Vision Fallback
 *
 * STRICTLY a fallback mechanism: Only executed when ARIA/DOM semantic
 * step detector returns confidence < 0.4 or an UNKNOWN step type.
 * Controls cost and latency by not executing in normal workflows.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';
import type { EasyApplyStepType } from './types';

const logger = createLogger('LinkedInVisionFallback');

export interface VisionDetectionResult {
  stepType: EasyApplyStepType;
  confidence: number;
  reasoning: string;
  hasForwardButton: boolean;
  forwardButtonText?: string;
}

export class LinkedInVisionFallback {
  /**
   * Captures a screenshot of the active browser viewport and uses a vision-capable LLM
   * to classify the Easy Apply modal step.
   */
  async evaluateModalWithVision(page: Page, visionLLM?: BaseChatModel): Promise<VisionDetectionResult> {
    logger.info('[VisionFallback] ⚠️ Triggering Vision Fallback due to low DOM confidence / unknown step...');

    const puppeteerPage = page.puppeteerPage;
    if (!puppeteerPage) {
      return {
        stepType: 'UNKNOWN',
        confidence: 0,
        reasoning: 'Puppeteer page not attached for screenshot.',
        hasForwardButton: false,
      };
    }

    if (!visionLLM) {
      logger.warning('[VisionFallback] No vision-capable LLM available for fallback.');
      return {
        stepType: 'UNKNOWN',
        confidence: 0,
        reasoning: 'Vision model not configured.',
        hasForwardButton: false,
      };
    }

    try {
      // 1. Capture base64 screenshot of viewport
      const screenshotBase64 = (await puppeteerPage.screenshot({
        encoding: 'base64',
        type: 'jpeg',
        quality: 75,
      })) as string;

      // 2. Query vision model
      const systemPrompt = `You are an expert AI Browser Assistant analyzing a screenshot of a LinkedIn Easy Apply job application modal.
Identify which step the application modal is currently on.

Valid step types:
- CONTACT_INFO (Phone, Email, Country code)
- HOME_ADDRESS (Address, City, Postal code)
- WORK_EXPERIENCE (Past roles, employers)
- EDUCATION (Degrees, schools)
- RESUME (Resume upload or selection)
- SCREENING_QUESTIONS (Questions, qualifications, authorization)
- VOLUNTARY_DISCLOSURES (Diversity, disability, veteran status)
- REVIEW (Review application summary)
- SUBMITTED (Application sent confirmation)
- UNKNOWN (Cannot determine)

Respond ONLY with a JSON object:
{
  "stepType": "<one of the valid step types above>",
  "confidence": <number 0.0 to 1.0>,
  "reasoning": "<1-sentence reason>",
  "hasForwardButton": <boolean, true if Next/Review/Submit is visible>,
  "forwardButtonText": "<e.g. Next, Review, Submit application>"
}`;

      const humanMessage = new HumanMessage({
        content: [
          {
            type: 'text',
            text: 'Analyze the screenshot and identify the LinkedIn Easy Apply modal step and available navigation buttons.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
          },
        ],
      });

      const response = await visionLLM.invoke([new SystemMessage(systemPrompt), humanMessage]);

      const text =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
            : '';

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        logger.info(
          `[VisionFallback] Vision classified step as: ${parsed.stepType} (confidence: ${parsed.confidence})`,
        );

        return {
          stepType: parsed.stepType || 'UNKNOWN',
          confidence: Number(parsed.confidence) || 0.5,
          reasoning: parsed.reasoning || 'Vision evaluation completed.',
          hasForwardButton: Boolean(parsed.hasForwardButton),
          forwardButtonText: parsed.forwardButtonText,
        };
      }
    } catch (err) {
      logger.error('Vision fallback encountered an error:', err);
    }

    return {
      stepType: 'UNKNOWN',
      confidence: 0.1,
      reasoning: 'Vision fallback failed to resolve modal step.',
      hasForwardButton: false,
    };
  }
}

export const visionFallback = new LinkedInVisionFallback();
