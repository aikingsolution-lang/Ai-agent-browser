// chrome-extension/src/background/agent/platforms/naukri/selectors.ts

export const NAUKRI_SELECTORS = {
  // Session & Login indicators
  LOGIN_CONTAINER: [
    'form[name="login-form"]',
    '#usernameField',
    'input[placeholder*="Username" i]',
    '.login-layer',
    '.nI-gNb-header__login-btn',
  ],
  LOGGED_IN_INDICATORS: [
    '.nI-gNb-drawer',
    '.nI-gNb-user-img',
    'a[title="View Profile"]',
    '.user-name',
    '.nI-gNb-header__user-menu',
  ],

  // Job Search Results
  JOB_TUPLES: ['div.srp-jobtuple-wrapper', 'article.jobTuple', 'div.cust-job-tuple', 'div[data-job-id]', 'div.tuple'],
  JOB_TITLE: ['a.title', '.title', 'h2 a', 'a[data-job-id]'],
  COMPANY_NAME: ['a.comp-name', '.comp-name', 'a.subTitle', '.subTitle', '.org'],
  LOCATION: ['span.loc-wrap', 'span.locWdn', '.loc', '.location'],
  EXPERIENCE: ['span.exp-wrap', 'span.expwdth', '.exp', '.experience'],
  SALARY: ['span.sal-wrap', 'span.sal', '.sal', '.salary'],
  TAGS: ['ul.tags-gt li', '.tag-li', '.tags li', '.badge'],

  // Job Details Page & Apply Buttons
  PRIMARY_APPLY_BUTTON: [
    'button#apply-button',
    'button.apply-button',
    'button[id*="apply" i]',
    '.apply-button-container button',
    '.apply-pwa-btn',
    'button.waves-effect',
  ],
  EXTERNAL_APPLY_INDICATORS: [
    'apply on company site',
    'apply on employer website',
    'company website',
    'redirecting to employer',
  ],
  ALREADY_APPLIED_INDICATORS: ['already applied', 'you applied', 'applied on', '.applied-badge', '.already-applied'],
  SUCCESS_INDICATORS: [
    'successfully applied',
    'application sent',
    'applied successfully',
    'your application has been sent',
    '.apply-message',
  ],

  // Questionnaire / Popups / Chatbot
  MODAL_CONTAINER: [
    'div.apply-message-container',
    'div.chatbot-container',
    'div.apply-modal',
    'div.layer-wrap',
    'div.custom-question-modal',
    'div.drawer-wrapper',
  ],
  SUBMIT_BUTTON: [
    'button.apply-message-btn',
    'button.chatbot-submit',
    'button[type="submit"]',
    'button.save-apply',
    '.submit-btn',
  ],
};
