// chrome-extension/src/background/agent/linkedin/dedicatedWindow.ts
import { createLogger } from '@src/background/log';

const logger = createLogger('DedicatedWindowManager');

export type RunnerMode = 'window' | 'tab';

export type RunnerCloseReason = 'window_closed' | 'tab_closed' | 'navigated_away' | 'manual';

export interface RunnerTargetOptions {
  /**
   * Execution target mode:
   * - 'tab': Creates/reuses a dedicated tab within the user's active/current browser window (default for all platforms).
   * - 'window': Creates/reuses a dedicated browser window positioned to the side.
   * Default: 'tab'
   */
  mode?: RunnerMode;
  /**
   * Allowed URL patterns (RegExp or string) for boundary checking.
   * If the runner tab navigates away from these patterns mid-run, onNavigatedAway triggers.
   */
  allowedDomains?: (RegExp | string)[];
}

/**
 * Runner Mode Architecture Decision:
 * All platforms (LinkedIn, Indeed, Naukri) open in 'tab' mode (a dedicated tab within
 * the user's active/current browser window). This provides a seamless, unified experience
 * sharing authenticated sessions without extra windows.
 */
export class DedicatedWindowManager {
  private dedicatedWindowId: number | null = null;
  private dedicatedTabId: number | null = null;
  private ownsWindow: boolean = false;
  private currentMode: RunnerMode = 'tab';
  private allowedUrlPatterns: RegExp[] = [];

  private onCloseCallbacks: Set<(reason: RunnerCloseReason) => void> = new Set();
  private onNavigatedAwayCallbacks: Set<(newUrl: string) => void> = new Set();

  constructor() {
    this.initListeners();
  }

  private initListeners(): void {
    if (typeof chrome === 'undefined') return;

    if (chrome.windows?.onRemoved) {
      chrome.windows.onRemoved.addListener((windowId: number) => {
        // If we own the dedicated window and that window was closed
        if (this.ownsWindow && this.dedicatedWindowId === windowId) {
          logger.info(`Dedicated runner window ${windowId} was closed`);
          this.dedicatedWindowId = null;
          this.dedicatedTabId = null;
          this.ownsWindow = false;
          this.notifyClosed('window_closed');
        } else if (!this.ownsWindow && this.dedicatedWindowId === windowId) {
          // If in tab mode and the parent window containing our tab was closed
          logger.info(`Parent window ${windowId} containing runner tab was closed`);
          this.dedicatedWindowId = null;
          this.dedicatedTabId = null;
          this.notifyClosed('tab_closed');
        }
      });
    }

    if (chrome.tabs?.onRemoved) {
      chrome.tabs.onRemoved.addListener((tabId: number) => {
        if (this.dedicatedTabId === tabId) {
          logger.info(`Dedicated runner tab ${tabId} was closed`);
          this.dedicatedTabId = null;
          if (this.ownsWindow) {
            this.dedicatedWindowId = null;
            this.ownsWindow = false;
          }
          this.notifyClosed('tab_closed');
        }
      });
    }

    if (chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (this.dedicatedTabId === tabId && changeInfo.url) {
          this.checkNavigationAway(changeInfo.url);
        }
      });
    }
  }

  private checkNavigationAway(newUrl: string): void {
    if (this.allowedUrlPatterns.length === 0) return;

    // Check if new URL matches any allowed pattern
    const isAllowed = this.allowedUrlPatterns.some(pattern => pattern.test(newUrl));
    if (!isAllowed) {
      logger.warning(`Runner tab ${this.dedicatedTabId} navigated away to unapproved URL: ${newUrl}`);
      this.notifyNavigatedAway(newUrl);
    }
  }

  private notifyClosed(reason: RunnerCloseReason = 'manual'): void {
    for (const cb of Array.from(this.onCloseCallbacks)) {
      try {
        cb(reason);
      } catch (e) {
        logger.error('Error in window/tab close callback:', e);
      }
    }
  }

  private notifyNavigatedAway(newUrl: string): void {
    for (const cb of Array.from(this.onNavigatedAwayCallbacks)) {
      try {
        cb(newUrl);
      } catch (e) {
        logger.error('Error in navigated-away callback:', e);
      }
    }
  }

  public onWindowClosed(cb: (reason: RunnerCloseReason) => void): () => void {
    this.onCloseCallbacks.add(cb);
    return () => {
      this.onCloseCallbacks.delete(cb);
    };
  }

  public onNavigatedAway(cb: (newUrl: string) => void): () => void {
    this.onNavigatedAwayCallbacks.add(cb);
    return () => {
      this.onNavigatedAwayCallbacks.delete(cb);
    };
  }

  public setAllowedUrlPatterns(patterns: (RegExp | string)[]): void {
    this.allowedUrlPatterns = patterns.map(p => (typeof p === 'string' ? new RegExp(p, 'i') : p));
  }

  public clearAllowedUrlPatterns(): void {
    this.allowedUrlPatterns = [];
  }

  public getWindowId(): number | null {
    return this.dedicatedWindowId;
  }

  public getTabId(): number | null {
    return this.dedicatedTabId;
  }

  public getRunnerMode(): RunnerMode {
    return this.currentMode;
  }

  public isWindowOwner(): boolean {
    return this.ownsWindow;
  }

  /**
   * Retrieves an existing valid runner window/tab or creates a new one.
   * - mode 'window' (default): creates/reuses a separate 1100x900 window.
   * - mode 'tab': creates/reuses a tab in the user's current/last-focused browser window.
   */
  public async getOrCreateRunnerWindow(
    url?: string,
    options?: RunnerTargetOptions,
  ): Promise<{ windowId: number; tabId: number; mode?: RunnerMode }> {
    const mode = options?.mode || 'tab';
    this.currentMode = mode;

    if (options?.allowedDomains) {
      this.setAllowedUrlPatterns(options.allowedDomains);
    }

    if (mode === 'tab') {
      return this.getOrCreateRunnerTabInCurrentWindow(url);
    }

    return this.getOrCreateDedicatedRunnerWindow(url);
  }

  /**
   * Opens or reuses a tab in the user's current browser window.
   */
  private async getOrCreateRunnerTabInCurrentWindow(
    url?: string,
  ): Promise<{ windowId: number; tabId: number; mode?: RunnerMode }> {
    // 1. Check existing tab if valid
    if (this.dedicatedTabId !== null) {
      try {
        const tab = await chrome.tabs.get(this.dedicatedTabId);
        if (tab && tab.id) {
          if (url && tab.url !== url) {
            await chrome.tabs.update(tab.id, { url, active: true });
          } else {
            await chrome.tabs.update(tab.id, { active: true });
          }
          if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
          }
          this.dedicatedWindowId = tab.windowId;
          this.ownsWindow = false;
          return { windowId: tab.windowId, tabId: tab.id, mode: 'tab' };
        }
      } catch {
        // Tab no longer exists, reset and proceed to create
        this.dedicatedTabId = null;
      }
    }

    // 2. Locate current or last-focused window
    let targetWindowId: number | undefined;
    try {
      const currentWin = await chrome.windows.getLastFocused({ populate: false });
      if (currentWin && currentWin.id && currentWin.id !== chrome.windows.WINDOW_ID_NONE) {
        targetWindowId = currentWin.id;
      }
    } catch {
      // Fallback: chrome.tabs.create without windowId defaults to current window
    }

    // 3. Create fresh runner tab in current window
    try {
      const newTab = await chrome.tabs.create({
        url: url || 'about:blank',
        windowId: targetWindowId,
        active: true,
      });

      if (!newTab || typeof newTab.id !== 'number') {
        throw new Error('Chrome tabs API did not return a valid tab ID');
      }

      this.dedicatedTabId = newTab.id;
      this.dedicatedWindowId = newTab.windowId || targetWindowId || null;
      this.ownsWindow = false; // We do NOT own the window, only this tab

      logger.info(
        `Created dedicated runner tab in current window (tabId=${this.dedicatedTabId}, winId=${this.dedicatedWindowId})`,
      );
      return { windowId: this.dedicatedWindowId || 0, tabId: this.dedicatedTabId, mode: 'tab' };
    } catch (err: any) {
      logger.error('Failed to open runner tab in current window:', err);
      throw new Error(`Failed to open runner tab in current window: ${err?.message || 'Unknown error'}`);
    }
  }

  /**
   * Opens or reuses a separate dedicated window (e.g. for LinkedIn).
   */
  private async getOrCreateDedicatedRunnerWindow(
    url?: string,
  ): Promise<{ windowId: number; tabId: number; mode?: RunnerMode }> {
    if (this.dedicatedWindowId !== null && this.ownsWindow) {
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
                return { windowId: win.id, tabId: tab.id, mode: 'window' };
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
            return { windowId: win.id, tabId: tabs[0].id, mode: 'window' };
          }
        }
      } catch {
        // Window no longer exists
        this.dedicatedWindowId = null;
        this.dedicatedTabId = null;
        this.ownsWindow = false;
      }
    }

    // Create fresh window placed to side
    let newWin: chrome.windows.Window | undefined;
    try {
      newWin = await chrome.windows.create({
        url: url || 'about:blank',
        type: 'normal',
        width: 1100,
        height: 900,
        left: 100,
        top: 60,
        focused: true,
      });
    } catch (err: any) {
      logger.error('Failed to create dedicated browser window:', err);
      throw new Error(`Failed to create dedicated browser window: ${err?.message || 'Unknown error'}`);
    }

    if (!newWin || !newWin.id) {
      throw new Error('Failed to create dedicated browser window: window ID missing');
    }

    this.dedicatedWindowId = newWin.id;
    this.ownsWindow = true;

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
    return { windowId: this.dedicatedWindowId, tabId: this.dedicatedTabId, mode: 'window' };
  }

  /**
   * Closes the runner target.
   * If in 'window' mode, closes the dedicated window.
   * If in 'tab' mode, closes ONLY the runner tab, preserving the user's browser window.
   */
  public async closeRunnerWindow(): Promise<void> {
    const winId = this.dedicatedWindowId;
    const tabId = this.dedicatedTabId;
    const shouldRemoveWindow = this.ownsWindow && winId !== null;

    this.dedicatedWindowId = null;
    this.dedicatedTabId = null;
    this.ownsWindow = false;
    this.clearAllowedUrlPatterns();

    if (shouldRemoveWindow) {
      try {
        await chrome.windows.remove(winId);
        logger.info(`Closed dedicated runner window ${winId}`);
      } catch {
        // Already closed or not found
      }
    } else if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
        logger.info(`Closed dedicated runner tab ${tabId}`);
      } catch {
        // Tab already closed
      }
    }
  }
}

export const dedicatedWindowManager = new DedicatedWindowManager();
