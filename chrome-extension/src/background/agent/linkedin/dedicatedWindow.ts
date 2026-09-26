// chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts
import { createLogger } from '@src/background/log';

const logger = createLogger('DedicatedWindowManager');

export class DedicatedWindowManager {
  private dedicatedWindowId: number | null = null;
  private dedicatedTabId: number | null = null;
  private onCloseCallbacks: Set<() => void> = new Set();

  constructor() {
    this.initListeners();
  }

  private initListeners(): void {
    if (typeof chrome === 'undefined' || !chrome.windows) return;

    chrome.windows.onRemoved.addListener((windowId: number) => {
      if (this.dedicatedWindowId === windowId) {
        logger.info(`Dedicated runner window ${windowId} was closed`);
        this.dedicatedWindowId = null;
        this.dedicatedTabId = null;
        this.notifyClosed();
      }
    });

    chrome.tabs.onRemoved.addListener((tabId: number) => {
      if (this.dedicatedTabId === tabId) {
        logger.info(`Dedicated runner tab ${tabId} was closed`);
        this.dedicatedTabId = null;
        // If the runner tab was closed, notify and treat as window closure for current run
        this.notifyClosed();
      }
    });
  }

  private notifyClosed(): void {
    for (const cb of Array.from(this.onCloseCallbacks)) {
      try {
        cb();
      } catch (e) {
        logger.error('Error in window close callback:', e);
      }
    }
  }

  public onWindowClosed(cb: () => void): () => void {
    this.onCloseCallbacks.add(cb);
    return () => {
      this.onCloseCallbacks.delete(cb);
    };
  }

  public getWindowId(): number | null {
    return this.dedicatedWindowId;
  }

  public getTabId(): number | null {
    return this.dedicatedTabId;
  }

  /**
   * Retrieves an existing valid runner window & tab or creates a new one placed to one side.
   */
  public async getOrCreateRunnerWindow(url?: string): Promise<{ windowId: number; tabId: number }> {
    if (this.dedicatedWindowId !== null) {
      try {
        const win = await chrome.windows.get(this.dedicatedWindowId);
        if (win && win.id) {
          if (this.dedicatedTabId !== null) {
            try {
              const tab = await chrome.tabs.get(this.dedicatedTabId);
              if (tab && tab.id) {
                if (url && tab.url !== url) {
                  await chrome.tabs.update(tab.id, { url, active: true });
                } else {
                  await chrome.tabs.update(tab.id, { active: true });
                }
                await chrome.windows.update(win.id, { focused: true });
                return { windowId: win.id, tabId: tab.id };
              }
            } catch {
              // Tab missing, find tabs in this window
            }
          }

          const tabs = await chrome.tabs.query({ windowId: win.id });
          if (tabs.length > 0 && tabs[0].id) {
            this.dedicatedTabId = tabs[0].id;
            if (url) {
              await chrome.tabs.update(tabs[0].id, { url, active: true });
            }
            await chrome.windows.update(win.id, { focused: true });
            return { windowId: win.id, tabId: tabs[0].id };
          }
        }
      } catch {
        // Window no longer exists
        this.dedicatedWindowId = null;
        this.dedicatedTabId = null;
      }
    }

    // Create fresh window placed to side
    const newWin = await chrome.windows.create({
      url: url || 'about:blank',
      type: 'normal',
      width: 1100,
      height: 900,
      left: 100,
      top: 60,
      focused: true,
    });

    if (!newWin || !newWin.id) {
      throw new Error('Failed to create dedicated browser window');
    }

    this.dedicatedWindowId = newWin.id;

    let targetTabId: number | null = null;
    if (newWin.tabs && newWin.tabs.length > 0 && newWin.tabs[0].id) {
      targetTabId = newWin.tabs[0].id;
    } else {
      const tabs = await chrome.tabs.query({ windowId: newWin.id });
      targetTabId = tabs[0]?.id || null;
    }

    if (!targetTabId) {
      throw new Error('Failed to obtain tab ID from newly created runner window');
    }

    this.dedicatedTabId = targetTabId;
    logger.info(`Created dedicated runner window (winId=${this.dedicatedWindowId}, tabId=${this.dedicatedTabId})`);
    return { windowId: this.dedicatedWindowId, tabId: this.dedicatedTabId };
  }

  /**
   * Closes the dedicated runner window if open.
   */
  public async closeRunnerWindow(): Promise<void> {
    if (this.dedicatedWindowId !== null) {
      const winId = this.dedicatedWindowId;
      this.dedicatedWindowId = null;
      this.dedicatedTabId = null;
      try {
        await chrome.windows.remove(winId);
        logger.info(`Closed dedicated runner window ${winId}`);
      } catch {
        // Already closed or not found
      }
    }
  }
}

export const dedicatedWindowManager = new DedicatedWindowManager();
