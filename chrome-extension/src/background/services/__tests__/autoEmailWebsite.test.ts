/**
 * "Extract Emails" on the JobForm Automator website → the extension's Auto Email run: sender checks,
 * sign-in, input validation, progress to the requesting tab and results delivered back to it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const local = {
    get: async () => ({ ...data }),
    set: async (items: Record<string, unknown>) => Object.assign(data, items),
    remove: async () => undefined,
    onChanged: { addListener: () => undefined, removeListener: () => undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: 'extension-id', onMessage: { addListener: () => undefined }, getURL: (p: string) => p },
    storage: {
      local,
      sync: local,
      session: { ...local, setAccessLevel: async () => undefined },
      onChanged: { addListener: () => undefined },
    },
  };
});

import { isAutomationHubUrl } from '../autoEmail';
import {
  AUTO_EMAIL_PROGRESS_ACTION,
  AUTO_EMAIL_WEBSITE_MESSAGES,
  handleAutoEmailWebsiteMessage,
  type AutoEmailWebsiteDeps,
} from '../autoEmailWebsite';

const HUB_URL = 'https://www.jobformautomator.com/dashboard/automation-hub';

const websiteSender = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({
  id: 'extension-id',
  tab: { id: 42 } as chrome.tabs.Tab,
  frameId: 0,
  url: HUB_URL,
  origin: 'https://www.jobformautomator.com',
  ...overrides,
});

function setup(overrides: Partial<AutoEmailWebsiteDeps> = {}) {
  const sent: Array<{ tabId: number; message: unknown }> = [];
  const deps: AutoEmailWebsiteDeps = {
    isSignedIn: vi.fn().mockResolvedValue(true),
    isRunning: vi.fn().mockReturnValue(false),
    run: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    sendToTab: (tabId, message) => sent.push({ tabId, message }),
    ...overrides,
  };
  return { deps, sent };
}

const start = (query: unknown) => ({ type: AUTO_EMAIL_WEBSITE_MESSAGES.start, query });

describe('Extract Emails on the website starts the extension’s Auto Email', () => {
  it('runs the search typed in the dialog and delivers the results to the tab that asked', async () => {
    const { deps } = setup();
    expect(await handleAutoEmailWebsiteMessage(start('  React   Developer Bangalore '), websiteSender(), deps)).toEqual(
      {
        ok: true,
      },
    );
    expect(deps.run).toHaveBeenCalledWith('React Developer Bangalore', expect.any(Function), { resultsTabId: 42 });
  });

  it('reports progress to that tab, without the results list', async () => {
    const { deps, sent } = setup();
    await handleAutoEmailWebsiteMessage(start('Data Analyst'), websiteSender(), deps);
    const onProgress = vi.mocked(deps.run).mock.calls[0][1];
    onProgress({ type: 'COMPLETE', message: 'Complete! Found HR emails for 3 of 5 companies.', results: [] });
    expect(sent).toEqual([
      {
        tabId: 42,
        message: {
          action: AUTO_EMAIL_PROGRESS_ACTION,
          data: { type: 'COMPLETE', message: 'Complete! Found HR emails for 3 of 5 companies.' },
        },
      },
    ]);
  });

  it('a run that fails is reported to the tab as an error', async () => {
    const { deps, sent } = setup({ run: vi.fn().mockRejectedValue(new Error('tab crashed')) });
    await handleAutoEmailWebsiteMessage(start('Designer'), websiteSender(), deps);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent.at(-1)).toMatchObject({ tabId: 42, message: { data: { type: 'ERROR' } } });
  });

  it('is refused unless it comes from the top frame of a JobForm Automator website tab', async () => {
    const { deps } = setup();
    const untrusted = [
      websiteSender({ url: 'https://evil.example/dashboard/automation-hub', origin: 'https://evil.example' }),
      websiteSender({ frameId: 3 }),
      websiteSender({ id: 'another-extension' }),
      websiteSender({ tab: undefined }),
    ];
    for (const sender of untrusted) {
      expect(await handleAutoEmailWebsiteMessage(start('Engineer'), sender, deps)).toEqual({
        ok: false,
        reason: 'untrusted-sender',
      });
      await handleAutoEmailWebsiteMessage({ type: AUTO_EMAIL_WEBSITE_MESSAGES.stop }, sender, deps);
    }
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.stop).not.toHaveBeenCalled();
  });

  it('needs someone signed in to the extension', async () => {
    const { deps } = setup({ isSignedIn: vi.fn().mockResolvedValue(false) });
    expect(await handleAutoEmailWebsiteMessage(start('Engineer'), websiteSender(), deps)).toEqual({
      ok: false,
      reason: 'signed-out',
    });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('rejects an empty, too long or non-text search', async () => {
    const { deps } = setup();
    for (const query of ['', '   ', 'x'.repeat(201), 42, undefined]) {
      expect(await handleAutoEmailWebsiteMessage(start(query), websiteSender(), deps)).toEqual({
        ok: false,
        reason: 'invalid-query',
      });
    }
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('does not start a second run while one is running', async () => {
    const { deps } = setup({ isRunning: vi.fn().mockReturnValue(true) });
    expect(await handleAutoEmailWebsiteMessage(start('Engineer'), websiteSender(), deps)).toEqual({
      ok: false,
      reason: 'already-running',
    });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('Stop in the website dialog stops the run', async () => {
    const { deps } = setup();
    expect(
      await handleAutoEmailWebsiteMessage({ type: AUTO_EMAIL_WEBSITE_MESSAGES.stop }, websiteSender(), deps),
    ).toEqual({ ok: true });
    expect(deps.stop).toHaveBeenCalledTimes(1);
  });

  it('results go back only to an Automation Hub page of the website', () => {
    expect(isAutomationHubUrl(HUB_URL)).toBe(true);
    expect(isAutomationHubUrl('https://jobformautomator.com/dashboard/automation-hub/?tab=email')).toBe(true);
    expect(isAutomationHubUrl('https://www.jobformautomator.com/dashboard')).toBe(false);
    expect(isAutomationHubUrl('https://evil.example/dashboard/automation-hub')).toBe(false);
    expect(isAutomationHubUrl('not a url')).toBe(false);
    expect(isAutomationHubUrl(undefined)).toBe(false);
  });
});
