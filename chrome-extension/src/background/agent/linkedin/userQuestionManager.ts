import { careerBrainStore } from '@extension/storage';
import { createLogger } from '../../log';

const logger = createLogger('userQuestionManager');

export interface PendingQuestion {
  questionId: string;
  questionText: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  skillName?: string;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BatchQuestionItem {
  id: string;
  fieldIndex?: number;
  questionText: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  skillName?: string;
  required?: boolean;
}

export interface PendingBatch {
  batchId: string;
  questions: BatchQuestionItem[];
  resolve: (answers: Record<string, string>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class UserQuestionManager {
  private pendingQuestions: Map<string, PendingQuestion> = new Map();
  private pendingBatches: Map<string, PendingBatch> = new Map();
  private port: chrome.runtime.Port | null = null;

  public setPort(port: chrome.runtime.Port | null) {
    this.port = port;
  }

  public hasPendingQuestions(): boolean {
    return this.pendingQuestions.size > 0 || this.pendingBatches.size > 0;
  }

  public async askQuestion(params: {
    questionText: string;
    fieldType?: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
    options?: string[];
    min?: number;
    max?: number;
    skillName?: string;
  }): Promise<string> {
    const questionId = `q_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fieldType = params.fieldType || 'text';

    logger.info(`[UserQuestionManager] Asking user question: "${params.questionText}" (type: ${fieldType})`);

    return new Promise<string>((resolve, reject) => {
      // 10-second timeout
      const timer = setTimeout(() => {
        if (this.pendingQuestions.has(questionId)) {
          this.pendingQuestions.delete(questionId);
          logger.warning(`[UserQuestionManager] Question timed out: "${params.questionText}"`);
          reject(new Error(`Paused: waiting for candidate input on "${params.questionText}" timed out (10s).`));
        }
      }, 10000); // 10 seconds

      this.pendingQuestions.set(questionId, {
        questionId,
        questionText: params.questionText,
        fieldType,
        options: params.options,
        min: params.min,
        max: params.max,
        skillName: params.skillName,
        resolve,
        reject,
        timer,
      });

      // Send to side panel
      if (this.port) {
        try {
          this.port.postMessage({
            type: 'ASK_USER_QUESTION',
            data: {
              questionId,
              questionText: params.questionText,
              fieldType,
              options: params.options,
              min: params.min,
              max: params.max,
              skillName: params.skillName,
            },
          });
        } catch (err) {
          logger.error('Failed to post question to port:', err);
        }
      }
    });
  }

  public async handleAnswer(questionId: string, answer: string): Promise<boolean> {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warning(`[UserQuestionManager] Received answer for unknown or expired question: ${questionId}`);
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingQuestions.delete(questionId);

    logger.info(`[UserQuestionManager] User answered question "${pending.questionText}": "${answer}"`);

    // Persist answer to goldenAnswers and customAnswers
    try {
      await careerBrainStore.saveGoldenAnswer(pending.questionText, answer);
      await careerBrainStore.setCustomAnswer(pending.questionText, answer).catch(() => {});

      // If skill question or skillName provided, persist to skillExperience
      const skillName = pending.skillName || this.extractSkillName(pending.questionText);
      if (skillName && !isNaN(Number(answer))) {
        await careerBrainStore.saveSkillExperience(skillName, Number(answer));
        logger.info(`[UserQuestionManager] Saved skill experience for "${skillName}": ${answer}`);
      }
    } catch (e) {
      logger.error('Failed to save answer to careerBrain:', e);
    }

    pending.resolve(answer);
    return true;
  }

  public extractSkillName(questionText: string): string | null {
    if (!questionText) return null;
    const cleanQ = questionText.trim();

    const patterns = [
      // 1. Explicit 'with/in/using [Skill]' preceded by years of work experience / experience
      /(?:how\s+many\s+years|years\s+of|experience).*?\b(?:with|in|using)\s+([A-Za-z0-9#+.\s-]{2,35}?)(?:\?|\*|$|\s*\(|\s+in\s+years)/i,
      // 2. Experience with/in/using
      /(?:experience\s+(?:do\s+you\s+have\s+)?(?:with|in|using)|worked\s+with|using)\s+([A-Za-z0-9#+.\s-]{2,35}?)(?:\?|$|\s+in|\s+using|\s+for|\s+at|\s*\()/i,
      // 3. Years with
      /years\s+with\s+([A-Za-z0-9#+.\s-]{2,35}?)(?:\?|$|\s+in|\s*\()/i,
      // 4. [Skill] experience (e.g. 'How many years of Python experience')
      /how\s+many\s+years\s+(?:of\s+)?(?!of\b|work\b|professional\b|total\b|overall\b|relevant\b|software\b|coding\b|hands-on\b)([A-Za-z0-9#+.\s-]{2,30}?)\s+(?:work\s+)?experience/i,
      /years\s+(?:of\s+)?(?!of\b|work\b|professional\b|total\b|overall\b|relevant\b|software\b|coding\b|hands-on\b)([A-Za-z0-9#+.\s-]{2,30}?)\s+(?:work\s+)?experience/i,
    ];

    for (const pat of patterns) {
      const match = cleanQ.match(pat);
      if (match && match[1]) {
        const clean = match[1]
          .replace(/[^\w#+.-]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (
          clean.length >= 2 &&
          !/^(a|an|the|any|your|our|this|that|of|work|total|overall|relevant|professional|experience|years|hands-on)$/i.test(
            clean,
          )
        ) {
          return clean;
        }
      }
    }
    return null;
  }

  public async askQuestionBatch(questions: BatchQuestionItem[]): Promise<Record<string, string>> {
    if (!questions || questions.length === 0) {
      return {};
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    logger.info(
      `[UserQuestionManager] Asking user question batch (${questions.length} questions, batchId: ${batchId})`,
    );

    return new Promise<Record<string, string>>((resolve, reject) => {
      // 10-second timeout for batch
      const timer = setTimeout(() => {
        if (this.pendingBatches.has(batchId)) {
          this.pendingBatches.delete(batchId);
          logger.warning(`[UserQuestionManager] Batch questions timed out (batchId: ${batchId})`);
          reject(
            new Error(
              `Paused: waiting for candidate input on batch questions (${questions.length} fields) timed out (10s).`,
            ),
          );
        }
      }, 10000); // 10 seconds

      this.pendingBatches.set(batchId, {
        batchId,
        questions,
        resolve,
        reject,
        timer,
      });

      // Send to side panel
      if (this.port) {
        try {
          this.port.postMessage({
            type: 'ASK_USER_QUESTION_BATCH',
            data: {
              batchId,
              questions,
            },
          });
        } catch (err) {
          logger.error('Failed to post question batch to port:', err);
        }
      }
    });
  }

  public async handleBatchAnswer(batchId: string, answers: Record<string, string>): Promise<boolean> {
    const pending = this.pendingBatches.get(batchId);
    if (!pending) {
      logger.warning(`[UserQuestionManager] Received batch answers for unknown or expired batch: ${batchId}`);
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingBatches.delete(batchId);

    logger.info(`[UserQuestionManager] User answered batch ${batchId} with ${Object.keys(answers).length} answers`);

    // Persist each answer to goldenAnswers, customAnswers, and skillExperience
    for (const q of pending.questions) {
      const ans = answers[q.id];
      if (ans !== undefined && ans !== null && ans !== '') {
        try {
          await careerBrainStore.saveGoldenAnswer(q.questionText, ans, 'Screening');
          await careerBrainStore.setCustomAnswer(q.questionText, ans).catch(() => {});

          const skillName = q.skillName || this.extractSkillName(q.questionText);
          if (skillName && !isNaN(Number(ans))) {
            await careerBrainStore.saveSkillExperience(skillName, Number(ans));
            logger.info(`[UserQuestionManager] Saved skill experience from batch for "${skillName}": ${ans}`);
          }
        } catch (e) {
          logger.error(`Failed to save batch answer to careerBrain for "${q.questionText}":`, e);
        }
      }
    }

    pending.resolve(answers);
    return true;
  }

  public cancelAll(reason = 'Canceled'): void {
    for (const q of this.pendingQuestions.values()) {
      clearTimeout(q.timer);
      q.reject(new Error(reason));
    }
    this.pendingQuestions.clear();

    for (const b of this.pendingBatches.values()) {
      clearTimeout(b.timer);
      b.reject(new Error(reason));
    }
    this.pendingBatches.clear();
  }
}

export const userQuestionManager = new UserQuestionManager();
