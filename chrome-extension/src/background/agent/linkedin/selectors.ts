/**
 * LinkedIn Easy Apply — Fail-Safe DOM Selectors Dictionary
 *
 * Centralized, decoupled DOM selector mapping for LinkedIn Easy Apply automation.
 * Combines semantic ARIA attributes, robust CSS hierarchies, and text signatures
 * to insulate the automation state machine against LinkedIn DOM drift.
 */

export const LINKEDIN_APPLY_SELECTORS = {
  /** Candidates for the primary Easy Apply button on the job details view */
  easyApplyButtons: [
    'button.jobs-apply-button',
    'button[aria-label*="Easy Apply" i]',
    'button[aria-label*="easy apply" i]',
    '.jobs-unified-top-card__easy-apply-button',
    '.jobs-details__main-content button.jobs-apply-button',
    'div.jobs-apply-button--top-card button',
    '.jobs-apply-button--top-card button',
    '.jobs-s-apply button',
    'div[data-job-id] button.jobs-apply-button',
    'button.artdeco-button--primary.jobs-apply-button',
    'a.jobs-apply-button',
  ],

  /** Text signatures that confirm the apply trigger is strictly Easy Apply */
  easyApplyTextMatches: ['easy apply', 'continue with easy apply'],

  /** External Apply indicators (Must NOT click - skips external sites) */
  externalApplyIndicators: [
    'button[aria-label*="apply on company website" i]',
    'button[aria-label*="apply externally" i]',
    'a[data-tracking-control-name="public_jobs_topcard-apply-link"]',
  ],
};

export const LINKEDIN_MODAL_SELECTORS = {
  /** Root modal dialog elements */
  modalRoot: [
    'div[role="dialog"][aria-modal="true"]',
    'div[data-test-modal]',
    '.jobs-easy-apply-modal',
    'div.artdeco-modal[role="dialog"]',
    'div[role="dialog"][aria-labelledby]',
  ],

  /** Semantic headings and step titles within the modal */
  headerText: [
    'h2.jobs-easy-apply-modal__title',
    'h3.t-16.t-bold',
    'div[role="dialog"] h2',
    'div[role="dialog"] h3',
    'div[role="dialog"] [role="heading"]',
    'legend.fb-form-section__title',
    'h3.fb-form-section__title',
  ],

  /** Progress bar element selectors */
  progressBar: ['progress', '[role="progressbar"]', '.jobs-easy-apply-modal__progress'],

  /** Error banners or validation messages inside the modal */
  errorBanner: [
    '.artdeco-inline-feedback--error',
    'div[data-test-form-element-error-messages]',
    'div[role="alert"]',
    '.fb-form-element__error-text',
    'span.artdeco-inline-feedback__message',
  ],
};

export const LINKEDIN_INPUT_SELECTORS = {
  /** Form row / element containers */
  formElementContainer: [
    '.fb-dash-form-element',
    '.jobs-easy-apply-form-section__grouping',
    '.fb-form-element',
    'div[data-test-form-element]',
  ],

  /** Standard text, email, phone, number inputs */
  textInputs: [
    'input[type="text"]:not([disabled])',
    'input[type="email"]:not([disabled])',
    'input[type="tel"]:not([disabled])',
    'input[type="number"]:not([disabled])',
    'input:not([type]):not([disabled])',
  ],

  /** Multi-line textareas (cover letter, narrative, open questions) */
  textAreas: ['textarea:not([disabled])', '.fb-dash-form-element textarea'],

  /** Radio groups and individual radio choices */
  radioGroups: 'fieldset, div[role="radiogroup"]',
  radioOption: 'input[type="radio"]:not([disabled])',
  radioLabel: 'label[for]',

  /** Checkbox elements */
  checkbox: 'input[type="checkbox"]:not([disabled])',
  checkboxLabel: 'label[for]',

  /** Native select dropdowns */
  nativeSelect: 'select:not([disabled])',

  /** Custom artdeco / LinkedIn combobox dropdowns */
  customDropdownTrigger: ['div.fb-dropdown button', 'div[role="combobox"]', 'button[aria-haspopup="listbox"]'],
  dropdownOptions: ['select option', 'ul[role="listbox"] li[role="option"]', 'div[role="listbox"] [role="option"]'],

  /** Resume File Upload input */
  fileInput: 'input[type="file"][id*="resume" i], input[type="file"]',
};

export const LINKEDIN_ACTION_BUTTONS = {
  /** Forward navigation action buttons ('Next' or 'Review') */
  nextOrReview: [
    'footer button[aria-label*="continue to next step" i]',
    'footer button[aria-label*="review your application" i]',
    'footer button[aria-label*="next" i]',
    'div[role="dialog"] footer button.artdeco-button--primary',
    '.jobs-easy-apply-modal footer button.artdeco-button--primary',
    'button[aria-label*="continue to next step" i]',
    'button[aria-label*="review your application" i]',
    'button[aria-label*="next" i]',
    'button[data-easy-apply-next-button]',
    'button.artdeco-button--primary',
  ],

  /** Final submission action button */
  submit: [
    'footer button[aria-label*="submit application" i]',
    'button[aria-label*="submit application" i]',
    'footer button[aria-label*="submit" i]',
    'button[data-control-name="submit_unify"]',
  ],

  /** Modal dismiss / close button */
  dismiss: ['button[aria-label*="dismiss" i]', 'button.artdeco-modal__dismiss', 'button[data-test-modal-close-btn]'],

  /** Discard application confirmation dialog buttons */
  discardConfirm: [
    'button[data-control-name="discard_application_confirm_btn"]',
    'button[data-test-dialog-primary-btn]',
  ],

  /** Cancel discard / Keep application open */
  discardCancel: [
    'button[data-control-name="discard_application_cancel_btn"]',
    'button[data-test-dialog-secondary-btn]',
  ],
};
