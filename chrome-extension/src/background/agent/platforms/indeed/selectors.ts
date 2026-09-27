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
    '#challenge-stage',
  ],

  // Job Search Results
  JOB_CARDS: ['div.job_seen_beacon', 'div.cardOutline', 'div.jobsearch-SerpJobCard', 'div[data-jk]'],
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
    'application was sent',
  ],

  // Multi-Step Apply Modal / Iframe Elements
  MODAL_CONTAINER: ['div#indeedapply-modal', 'div.ia-BasePage', 'div[role="dialog"]', 'iframe[name*="indeedapply"]'],
  FORWARD_BUTTON_SELECTORS: [
    'button[data-testid="continue-button"]',
    'button.ia-continueButton',
    'button.ia-SmartApplyCard-primaryButton',
    'button[data-testid="review-button"]',
    'button[type="submit"]',
  ],
  FORWARD_BUTTON_TEXTS: ['continue', 'next', 'review your application', 'review application', 'save and continue'],
  SUBMIT_BUTTON_SELECTORS: [
    'button[data-testid="submit-button"]',
    'button.ia-submitButton',
    'button.ia-SubmitButton',
    'button[data-testid="apply-button"]',
  ],
  SUBMIT_BUTTON_TEXTS: ['submit your application', 'submit application', 'apply now', 'submit'],
};
