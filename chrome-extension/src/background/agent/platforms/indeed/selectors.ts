// chrome-extension/src/background/agent/platforms/indeed/selectors.ts

export const INDEED_SELECTORS = {
  // Session & Auth
  LOGGED_IN_INDICATORS: [
    'a[data-gnav-element-name="Profile"]',
    'button[data-gnav-element-name="Profile"]',
    'button[id*="user-menu" i]',
    'a[href*="/account" i]',
    '.gnav-AccountMenu',
  ],
  LOGIN_CONTAINER: ['form[action*="/auth" i]', 'input[name="__email"]', '#login-email-input', 'div.signin-container'],

  // Captcha & Cloudflare bot challenges
  CAPTCHA_CONTAINERS: [
    'iframe[src*="cloudflare" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="recaptcha" i]',
    'div#challenge-running',
    'div.cf-turnstile',
    '#challenge-form',
    'div[id*="captcha" i]',
  ],

  // Job Search Results
  JOB_CARDS: [
    'div.job_seen_beacon',
    'div.cardOutline',
    'div.jobsearch-SerpJobCard',
    'div[data-jk]',
    'td.resultContent',
  ],
  JOB_TITLE: ['h2.jobTitle a', 'a.jcs-JobTitle', 'a[data-jk]', 'span[id^="jobTitle"]'],
  COMPANY_NAME: ['span[data-testid="company-name"]', 'span.companyName', '.company_location .companyName'],
  LOCATION: ['div[data-testid="text-location"]', 'div.companyLocation', '.company_location .companyLocation'],
  SALARY: ['div.metadata.salary-snippet-container', 'div[data-testid="attribute_snippet_testid"]', '.salary-snippet'],
  EASILY_APPLY_BADGE: ['span.iaIcon', 'div.iaIcon', '.ia-badge', 'span.ia-tag'],

  // Job Detail & Apply Buttons
  PRIMARY_APPLY_BUTTON: [
    '#indeedApplyButton',
    'button[data-testid="indeedApplyButton"]',
    'button.indeed-apply-button',
    'button.ia-IndeedApplyButton',
  ],
  EXTERNAL_APPLY_INDICATORS: ['apply on company site', 'apply on employer website', 'company site', 'external site'],
  ALREADY_APPLIED_INDICATORS: [
    'you applied to this job',
    'applied on indeed',
    'already applied',
    'div.ia-AppliedBadge',
  ],
  SUCCESS_INDICATORS: [
    'your application has been submitted',
    'application submitted',
    'your application was submitted',
    'successfully applied',
  ],

  // Multi-Step Apply Modal / Iframe Elements
  MODAL_CONTAINER: ['div#indeedapply-modal', 'div.ia-BasePage', 'div[role="dialog"]', 'iframe[name*="indeedapply"]'],
  FORWARD_BUTTONS: [
    'button[data-testid="continue-button"]',
    'button.ia-continueButton',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Review your application")',
  ],
  SUBMIT_BUTTON: [
    'button[data-testid="submit-button"]',
    'button:has-text("Submit your application")',
    'button:has-text("Submit application")',
    'button.ia-submitButton',
  ],
};
