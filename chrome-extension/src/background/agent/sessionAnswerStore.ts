/**
 * SessionAnswerStore - Isolated, per-application-session answer cache.
 *
 * Guarantees:
 * 1. Fingerprint stability: Identical questions in the same session return the identical answer.
 * 2. Multi-step persistence: Answers from Step 1 are remembered in Step 2, Step 3, and auto-heal retries.
 * 3. Priority ladder: User-approved answers can never be overwritten by unapproved or AI-generated answers.
 * 4. Isolation: Independent sessions (jobRunId) do not bleed answers into each other.
 * 5. Option sensitivity: If option choices change materially, a distinct fingerprint is produced.
 */

import { createLogger } from '../log';

const logger = createLogger('SessionAnswerStore');

export type AnswerSource = 'USER_SAVED' | 'PROFILE_EXPLICIT' | 'DETERMINISTIC_MAP' | 'AI_GENERATED' | 'UNKNOWN';

export type AnswerConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface SessionAnswerRecord {
  fingerprint: string;
  sessionId: string;
  questionLabel: string;
  normalizedQuestion: string;
  platform: string;
  fieldType: string;
  options?: string[];
  answer: string;
  source: AnswerSource;
  confidence: AnswerConfidence;
  userApproved: boolean;
  reason: string;
  missingInfo?: string;
  resolvedAt: number;
}

/**
 * Normalizes question text for fingerprint computation.
 * Lowercases, removes punctuation, collapses whitespace.
 */
export function normalizeQuestionText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generates a stable, collision-resistant fingerprint for a question within a platform context.
 * Options are sorted and normalized so option ordering variations don't alter the fingerprint.
 */
export function computeQuestionFingerprint(
  questionText: string,
  platform: string = 'linkedin',
  options?: string[],
): string {
  const normQ = normalizeQuestionText(questionText);
  const normOpts =
    Array.isArray(options) && options.length > 0
      ? options
          .map(o =>
            String(o || '')
              .toLowerCase()
              .trim(),
          )
          .filter(Boolean)
          .sort()
          .join('|')
      : '';
  const normPlatform = (platform || 'generic').toLowerCase().trim();
  return `${normPlatform}::${normQ}::${normOpts}`;
}

export class SessionAnswerStore {
  // sessionId -> Map<fingerprint, SessionAnswerRecord>
  private sessions = new Map<string, Map<string, SessionAnswerRecord>>();

  private static readonly PRIORITY_WEIGHTS: Record<AnswerSource, number> = {
    USER_SAVED: 5,
    PROFILE_EXPLICIT: 4,
    DETERMINISTIC_MAP: 3,
    AI_GENERATED: 2,
    UNKNOWN: 1,
  };

  /**
   * Retrieves an answer for a question within the given session.
   */
  get(sessionId: string, fingerprint: string): SessionAnswerRecord | undefined {
    if (!sessionId || !fingerprint) return undefined;
    return this.sessions.get(sessionId)?.get(fingerprint);
  }

  /**
   * Saves a resolved answer in the session memory.
   * Enforces priority ladder and approval protection.
   */
  set(record: SessionAnswerRecord): boolean {
    if (!record || !record.sessionId || !record.fingerprint) {
      return false;
    }

    let sessionMap = this.sessions.get(record.sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      this.sessions.set(record.sessionId, sessionMap);
    }

    const existing = sessionMap.get(record.fingerprint);
    if (existing) {
      // Rule 1: Never overwrite a user-approved answer with an unapproved answer
      if (existing.userApproved && !record.userApproved) {
        logger.info(
          `[SessionAnswerStore] Blocked overwrite: Existing answer for "${record.questionLabel}" is user-approved.`,
        );
        return false;
      }

      // Rule 2: Lower-priority source cannot overwrite higher-priority source
      const existingWeight = SessionAnswerStore.PRIORITY_WEIGHTS[existing.source] || 0;
      const newWeight = SessionAnswerStore.PRIORITY_WEIGHTS[record.source] || 0;

      if (newWeight < existingWeight) {
        logger.info(
          `[SessionAnswerStore] Blocked overwrite: Lower priority (${record.source} < ${existing.source}) for "${record.questionLabel}".`,
        );
        return false;
      }
    }

    sessionMap.set(record.fingerprint, {
      ...record,
      resolvedAt: record.resolvedAt || Date.now(),
    });
    return true;
  }

  /**
   * Checks if an answer exists for the fingerprint in this session.
   */
  has(sessionId: string, fingerprint: string): boolean {
    if (!sessionId || !fingerprint) return false;
    return Boolean(this.sessions.get(sessionId)?.has(fingerprint));
  }

  /**
   * Clears all answers stored for a session.
   */
  clearSession(sessionId: string): void {
    if (!sessionId) return;
    this.sessions.delete(sessionId);
    logger.info(`[SessionAnswerStore] Cleared session answers for "${sessionId}".`);
  }

  /**
   * Returns all answers in a session (useful for diagnostic logging).
   */
  getAllForSession(sessionId: string): SessionAnswerRecord[] {
    if (!sessionId) return [];
    const sessionMap = this.sessions.get(sessionId);
    return sessionMap ? Array.from(sessionMap.values()) : [];
  }

  /**
   * Total number of active sessions in memory.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

export const sessionAnswerStore = new SessionAnswerStore();
