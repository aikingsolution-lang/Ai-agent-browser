/**
 * "Extract Emails" on the JobForm Automator website's Automation Hub.
 *
 * The page fires `startEmailExtraction`; the content script (jobformWebsiteBridge) asks for a job
 * title in its dialog and sends it here. The same Auto Email workflow as the side panel runs; its
 * progress is reported to that tab, and the results are delivered back to it (CustomEvent
 * "emailsData", which the website reads).
 *
 * Accepted only from this extension's content script in the top frame of a website tab, and only
 * while someone is signed in to the extension.
 */

import { authStorage, sessionUserId } from '@extension/storage';
import { createLogger } from '../log';
import { isAutoEmailRunning, runAutoEmailWorkflow, stopAutoEmail, type AutoEmailProgress } from './autoEmail';
import { isTrustedWebsiteSender } from './websiteSessionSync';

const logger = createLogger('WebsiteAutoEmail');

// Keep in sync with pages/content/src/jobformWebsiteBridge.ts
export const AUTO_EMAIL_WEBSITE_MESSAGES = {
  start: 'JOBFORM_WEBSITE_START_AUTO_EMAIL',
  stop: 'JOBFORM_WEBSITE_STOP_AUTO_EMAIL',
} as const;
/** `action` of the progress messages sent to the website tab. */
export const AUTO_EMAIL_PROGRESS_ACTION = 'autoEmailProgress';

const MAX_QUERY_LENGTH = 200;

export type AutoEmailWebsiteResult =
  | { ok: true }
  | { ok: false; reason: 'untrusted-sender' | 'invalid-query' | 'signed-out' | 'already-running' | 'unknown-message' };

export interface AutoEmailWebsiteDeps {
  isSignedIn: () => Promise<boolean>;
  isRunning: () => boolean;
  run: typeof runAutoEmailWorkflow;
  stop: () => void;
  sendToTab: (tabId: number, message: unknown) => void;
}

const defaultDeps: AutoEmailWebsiteDeps = {
  isSignedIn: async () => {
    const session = await authStorage.getSession();
    return Boolean(session.token && sessionUserId(session.user));
  },
  isRunning: isAutoEmailRunning,
  run: runAutoEmailWorkflow,
  stop: stopAutoEmail,
  sendToTab: (tabId, message) => {
    chrome.tabs.sendMessage(tabId, message).catch(() => {
      // The tab was closed or navigated away; the run continues and still delivers its results.
    });
  },
};

/** The job title / search query typed into the dialog, or null when unusable. */
export function parseAutoEmailQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const query = value.trim().replace(/\s+/g, ' ');
  return query && query.length <= MAX_QUERY_LENGTH ? query : null;
}

export async function handleAutoEmailWebsiteMessage(
  message: { type?: unknown; query?: unknown },
  sender: chrome.runtime.MessageSender,
  deps: AutoEmailWebsiteDeps = defaultDeps,
): Promise<AutoEmailWebsiteResult> {
  if (!isTrustedWebsiteSender(sender) || sender.tab?.id === undefined) {
    logger.warning(`Ignored ${String(message.type)} from an untrusted sender`);
    return { ok: false, reason: 'untrusted-sender' };
  }
  const tabId = sender.tab.id;

  if (message.type === AUTO_EMAIL_WEBSITE_MESSAGES.stop) {
    deps.stop();
    return { ok: true };
  }
  if (message.type !== AUTO_EMAIL_WEBSITE_MESSAGES.start) return { ok: false, reason: 'unknown-message' };

  const query = parseAutoEmailQuery(message.query);
  if (!query) return { ok: false, reason: 'invalid-query' };
  if (!(await deps.isSignedIn())) return { ok: false, reason: 'signed-out' };
  if (deps.isRunning()) return { ok: false, reason: 'already-running' };

  // Progress without the results list (the results are delivered separately as "emailsData")
  const report = (progress: Pick<AutoEmailProgress, 'type' | 'message'>) =>
    deps.sendToTab(tabId, {
      action: AUTO_EMAIL_PROGRESS_ACTION,
      data: { type: progress.type, message: progress.message },
    });

  deps.run(query, report, { resultsTabId: tabId }).catch(error => {
    logger.error('Auto Email from the website failed:', error);
    report({ type: 'ERROR', message: 'Email extraction stopped because of an error. Please try again.' });
  });
  return { ok: true };
}

export function registerWebsiteAutoEmail(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = message?.type;
    if (type !== AUTO_EMAIL_WEBSITE_MESSAGES.start && type !== AUTO_EMAIL_WEBSITE_MESSAGES.stop) return false;
    handleAutoEmailWebsiteMessage(message, sender).then(sendResponse, error => {
      logger.error('Auto Email website message failed:', error);
      sendResponse({ ok: false, reason: 'unknown-message' });
    });
    return true; // async response
  });
}
