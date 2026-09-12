/**
 * LinkedIn Session Validator
 *
 * Uses chrome.cookies API to validate LinkedIn session.
 * Checks for key authentication cookies (li_at, JSESSIONID)
 * before starting any LinkedIn automation tasks.
 */

import { createLogger } from '@src/background/log';

const logger = createLogger('LinkedInSessionValidator');

// ─── Constants ──────────────────────────────────────────────────────────────

const LINKEDIN_DOMAIN = '.linkedin.com';
const LINKEDIN_URL = 'https://www.linkedin.com';

/** Key LinkedIn authentication cookies */
const LINKEDIN_AUTH_COOKIES = {
  /** Primary authentication token — presence = logged in */
  LI_AT: 'li_at',
  /** Session identifier */
  JSESSIONID: 'JSESSIONID',
} as const;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LinkedInSessionStatus {
  /** Whether the session is valid and user is logged in */
  isValid: boolean;
  /** List of missing cookies that indicate an invalid session */
  missingCookies: string[];
  /** List of expired cookies detected */
  expiredCookies: string[];
  /** Human-readable status message */
  message: string;
}

export interface LinkedInCookieInfo {
  name: string;
  value: string;
  expirationDate: number | undefined;
  isExpired: boolean;
}

// ─── Validator ──────────────────────────────────────────────────────────────

/**
 * Retrieves a specific LinkedIn cookie by name.
 * Returns null if the cookie doesn't exist.
 */
async function getLinkedInCookie(cookieName: string): Promise<chrome.cookies.Cookie | null> {
  try {
    const cookie = await chrome.cookies.get({
      url: LINKEDIN_URL,
      name: cookieName,
    });
    return cookie;
  } catch (error) {
    logger.warning(`Failed to retrieve cookie '${cookieName}':`, error);
    return null;
  }
}

/**
 * Checks if a cookie is expired based on its expirationDate.
 * Session cookies (no expirationDate) are considered valid.
 */
function isCookieExpired(cookie: chrome.cookies.Cookie): boolean {
  if (!cookie.expirationDate) {
    // Session cookie — valid as long as browser is open
    return false;
  }
  return cookie.expirationDate * 1000 < Date.now();
}

/**
 * Validates the LinkedIn session by checking for key authentication cookies.
 *
 * Primary check: `li_at` cookie (LinkedIn auth token).
 * Secondary check: `JSESSIONID` cookie (session identifier).
 *
 * @returns Session status with validity, missing cookies, and a human-readable message
 */
export async function validateLinkedInSession(): Promise<LinkedInSessionStatus> {
  logger.info('Validating LinkedIn session...');

  const missingCookies: string[] = [];
  const expiredCookies: string[] = [];
  const cookieDetails: LinkedInCookieInfo[] = [];

  // Check each authentication cookie
  for (const [key, cookieName] of Object.entries(LINKEDIN_AUTH_COOKIES)) {
    const cookie = await getLinkedInCookie(cookieName);

    if (!cookie) {
      missingCookies.push(cookieName);
      logger.warning(`Cookie '${cookieName}' (${key}) not found`);
      continue;
    }

    const expired = isCookieExpired(cookie);
    if (expired) {
      expiredCookies.push(cookieName);
      logger.warning(`Cookie '${cookieName}' (${key}) is expired`);
    }

    cookieDetails.push({
      name: cookie.name,
      value: `${cookie.value.substring(0, 8)}...`, // Truncate for security
      expirationDate: cookie.expirationDate,
      isExpired: expired,
    });
  }

  // Primary auth token (li_at) is the critical one
  const liAtMissing = missingCookies.includes(LINKEDIN_AUTH_COOKIES.LI_AT);
  const liAtExpired = expiredCookies.includes(LINKEDIN_AUTH_COOKIES.LI_AT);
  const isValid = !liAtMissing && !liAtExpired;

  let message: string;
  if (isValid) {
    message = '✅ LinkedIn session is valid. User is logged in.';
    logger.info(message);
  } else if (liAtMissing) {
    message =
      '⚠️ LinkedIn session not found. Please log in to LinkedIn in your browser before using Easy Apply automation.';
    logger.warning(message);
  } else if (liAtExpired) {
    message =
      '⚠️ LinkedIn session has expired. Please refresh your LinkedIn login by visiting linkedin.com and signing in again.';
    logger.warning(message);
  } else {
    message = `⚠️ LinkedIn session may be invalid. Missing cookies: ${missingCookies.join(', ')}`;
    logger.warning(message);
  }

  return {
    isValid,
    missingCookies,
    expiredCookies,
    message,
  };
}

/**
 * Quick check — returns true if the primary LinkedIn auth cookie exists and is not expired.
 * Use this for fast pre-flight checks before detailed validation.
 */
export async function isLinkedInSessionActive(): Promise<boolean> {
  const cookie = await getLinkedInCookie(LINKEDIN_AUTH_COOKIES.LI_AT);
  if (!cookie) return false;
  return !isCookieExpired(cookie);
}
