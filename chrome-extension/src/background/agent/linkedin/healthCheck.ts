/**
 * LinkedIn Pre-Flight Health Check
 *
 * Checks if the user is actively logged into LinkedIn on the DOM level
 * before starting any automation steps.
 * Detects profile navigation icons (e.g., div.global-nav__me) and handles
 * logged-out / unauthenticated states gracefully.
 */

import { createLogger } from '@src/background/log';
import type Page from '@src/background/browser/page';

const logger = createLogger('LinkedInHealthChecker');

export interface HealthCheckResult {
  isLoggedIn: boolean;
  profileDetected: boolean;
  pageReachable: boolean;
  message: string;
}

// Key selectors representing an active LinkedIn authenticated session on the page
const AUTHENTICATED_SELECTORS = [
  'div.global-nav__me',
  '.feed-identity-module',
  'img.global-nav__me-photo',
  '.nav-item__profile-member-photo',
  'button[aria-label*="Me"]',
  'button[aria-label*="Profile"]',
  '#global-nav-typeahead',
  '.nav-item--profile',
];

// Selectors that explicitly indicate a login/sign-in page
const LOGGED_OUT_SELECTORS = [
  'form.login__form',
  'a[href*="linkedin.com/login"]',
  'a[data-tracking-control-name="guest_homepage-basic_nav-header-signin"]',
  'button[data-tracking-control-name="public_jobs_apply-link-offsite_sign-in-modal"]',
  '.join-form',
];

export class LinkedInHealthChecker {
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(maxRetries = 3, baseDelayMs = 1000) {
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
  }

  /**
   * Evaluates the current page DOM to verify LinkedIn login state.
   */
  async runPreFlightCheck(page: Page): Promise<HealthCheckResult> {
    logger.info('Running LinkedIn pre-flight health check...');

    try {
      const pageUrl = (page.url() || '').toLowerCase();
      if (!pageUrl.includes('linkedin.com')) {
        return {
          isLoggedIn: false,
          profileDetected: false,
          pageReachable: true,
          message: '⚠️ Current page is not LinkedIn. Please navigate to LinkedIn first.',
        };
      }

      let profileDetected = false;
      let loggedOutDetected = false;

      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        try {
          const puppeteerPage = page.puppeteerPage;
          if (!puppeteerPage) {
            throw new Error('Puppeteer page instance not attached.');
          }

          // Evaluate presence of authenticated vs logged-out indicators in DOM
          const checkResult = await puppeteerPage.evaluate(
            (authSelectors: string[], logoutSelectors: string[]) => {
              const hasAuthElement = authSelectors.some(sel => {
                const el = document.querySelector(sel);
                return el !== null && (el as HTMLElement).offsetParent !== null;
              });

              const hasLogoutElement = logoutSelectors.some(sel => {
                const el = document.querySelector(sel);
                return el !== null && (el as HTMLElement).offsetParent !== null;
              });

              return { hasAuthElement, hasLogoutElement };
            },
            AUTHENTICATED_SELECTORS,
            LOGGED_OUT_SELECTORS,
          );

          if (checkResult.hasAuthElement) {
            profileDetected = true;
            break;
          }

          if (checkResult.hasLogoutElement) {
            loggedOutDetected = true;
            break;
          }
        } catch (err) {
          logger.warning(`Pre-flight attempt ${attempt + 1} encountered an error:`, err);
        }

        if (attempt < this.maxRetries - 1) {
          const delay = this.baseDelayMs * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      if (profileDetected) {
        logger.info('✅ LinkedIn pre-flight check passed: profile icon/element detected.');
        return {
          isLoggedIn: true,
          profileDetected: true,
          pageReachable: true,
          message: '✅ LinkedIn pre-flight check passed. User is logged in.',
        };
      }

      if (loggedOutDetected) {
        logger.warning('⚠️ LinkedIn pre-flight check failed: login page or guest banner detected.');
        return {
          isLoggedIn: false,
          profileDetected: false,
          pageReachable: true,
          message: '⚠️ LinkedIn login required. Please log into your LinkedIn account and try again.',
        };
      }

      // Neither definitively found after retries
      logger.warning('⚠️ LinkedIn profile icon not found after retries.');
      return {
        isLoggedIn: false,
        profileDetected: false,
        pageReachable: true,
        message: '⚠️ Could not detect LinkedIn profile icon (div.global-nav__me). Please ensure you are logged in.',
      };
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      logger.error('Pre-flight health check error:', err);
      return {
        isLoggedIn: false,
        profileDetected: false,
        pageReachable: false,
        message: `⚠️ Pre-flight health check failed to reach LinkedIn page: ${err}`,
      };
    }
  }
}
