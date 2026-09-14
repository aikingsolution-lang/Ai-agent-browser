/**
 * LinkedIn Easy Apply — TypeScript Interfaces
 *
 * Strict type definitions for job data, application state,
 * screening questions, modal step detection, and fit-score evaluation.
 */

// ─── Status ──────────────────────────────────────────────────────────────────

export const JOB_APPLICATION_STATUSES = [
  'QUEUED',
  'APPLIED',
  'DRY_RUN_SUCCESS',
  'NEEDS_MANUAL_REVIEW',
  'FAILED_MISSING_DATA',
  'PENDING_RESUME_APPROVAL',
  'SKIPPED_EXTERNAL_SITE',
  'SKIPPED_JOB_REMOVED',
  'SKIPPED_MISSING_RESUME',
] as const;

export type JobApplicationStatus = (typeof JOB_APPLICATION_STATUSES)[number];

// ─── Step Types ─────────────────────────────────────────────────────────────

export const EASY_APPLY_STEP_TYPES = [
  'CONTACT_INFO',
  'HOME_ADDRESS',
  'WORK_EXPERIENCE',
  'EDUCATION',
  'RESUME',
  'SCREENING_QUESTIONS',
  'ADDITIONAL_QUESTIONS',
  'VOLUNTARY_DISCLOSURES',
  'REVIEW',
  'SUBMITTED',
  'UNKNOWN',
] as const;

export type EasyApplyStepType = (typeof EASY_APPLY_STEP_TYPES)[number];

// ─── Modal & Step Detection Results ─────────────────────────────────────────

export interface IModalNavigationButtons {
  /** 'Next' or 'Continue to next step' button present */
  hasNext: boolean;
  /** 'Review' or 'Review your application' button present */
  hasReview: boolean;
  /** 'Submit application' button present */
  hasSubmit: boolean;
  /** 'Back' button present */
  hasBack: boolean;
  /** 'Dismiss' or 'Close' modal button present */
  hasDismiss: boolean;
  /** ARIA label or text of the primary forward action button */
  primaryActionLabel?: string;
}

export interface IModalErrorBanner {
  hasError: boolean;
  errorMessages: string[];
}

export interface IStepDetectionResult {
  /** Identified semantic step category */
  stepType: EasyApplyStepType;
  /** Detected heading / title text for this step */
  stepTitle: string;
  /** Extracted raw header or legend text */
  rawHeaderText: string;
  /** Percentage completed from progress bar (0-100) if found */
  progressPercent?: number;
  /** Current step number from 'Step X of Y' or progress bar */
  stepNumber?: number;
  /** Total steps if declared in the modal */
  totalSteps?: number;
  /** Available navigation buttons in current step */
  buttons: IModalNavigationButtons;
  /** Form validation errors currently displayed on screen */
  errors: IModalErrorBanner;
  /** Whether the modal dialog is actively open in the DOM */
  isModalOpen: boolean;
  /** Confidence score of step identification (0 to 1) */
  confidence: number;
}

export interface IStepTransitionResult {
  /** Whether the transition to a new step succeeded */
  success: boolean;
  /** Previous step detected before click */
  previousStep: EasyApplyStepType;
  /** Current step detected after click */
  currentStep: EasyApplyStepType;
  /** Details of the step after transition */
  stepDetails?: IStepDetectionResult;
  /** Milliseconds taken for DOM transition to complete */
  transitionTimeMs: number;
  /** Error description if transition failed */
  errorMessage?: string;
  /** Whether an unknown state or unhandled blocking error was encountered */
  needsManualReview?: boolean;
}

// ─── Job Data ────────────────────────────────────────────────────────────────

/** Shape of a scraped LinkedIn job listing */
export interface IJobData {
  /** Full URL of the job listing page */
  url: string;
  /** SHA-256 hash of the URL, used as unique jobId */
  jobId: string;
  /** Job title as displayed on LinkedIn */
  title: string;
  /** Company name */
  company: string;
  /** Location (city, remote, hybrid, etc.) */
  location: string;
  /** Salary range string, if available (e.g. "₹8L - ₹12L") */
  salaryRange: string;
  /** Raw job description text (will be sanitized before LLM usage) */
  description: string;
  /** Job type — full-time, part-time, contract, etc. */
  jobType: string;
  /** Required experience level */
  experienceLevel: string;
  /** Whether the job has Easy Apply enabled */
  isEasyApply: boolean;
}

// ─── Application State ──────────────────────────────────────────────────────

/** Tracks the real-time state of an in-progress application */
export interface IApplicationState {
  /** The job being applied to */
  jobData: IJobData;
  /** Current lifecycle status */
  status: JobApplicationStatus;
  /** Current step index in the multi-step Easy Apply modal (0-based) */
  currentStep: number;
  /** Total number of steps detected in the Easy Apply modal */
  totalSteps: number;
  /** Current step semantic type */
  currentStepType?: EasyApplyStepType;
  /** Screening questions extracted from the application form */
  screeningQuestions: IScreeningQuestion[];
  /** Accumulated errors during the application process */
  errors: string[];
  /** Timestamp when the application process started */
  startedAt: number;
  /** Timestamp when the application process completed (or failed) */
  completedAt: number | null;
}

// ─── Screening Questions ────────────────────────────────────────────────────

/** Types of screening questions LinkedIn may present */
export type ScreeningQuestionType =
  | 'text'
  | 'numeric'
  | 'boolean'
  | 'single_select'
  | 'multi_select'
  | 'date'
  | 'file_upload';

/** A single screening question from the Easy Apply form */
export interface IScreeningQuestion {
  /** Unique identifier for the question (DOM-derived or positional) */
  questionId: string;
  /** The question text as displayed */
  questionText: string;
  /** The type/format of the expected answer */
  questionType: ScreeningQuestionType;
  /** Whether the question is marked as required */
  required: boolean;
  /** Available options for select-type questions */
  options: string[];
  /** The answer provided (or to be provided) by the user/LLM */
  userAnswer: string | null;
}

// ─── Fit Score ──────────────────────────────────────────────────────────────

/** Recommendation based on fit score evaluation */
export type FitRecommendation = 'STRONG_MATCH' | 'GOOD_MATCH' | 'WEAK_MATCH' | 'NO_MATCH';

/** Result of evaluating how well a user's profile matches a job listing */
export interface IFitScoreResult {
  /** Numeric score from 0 to 100 */
  score: number;
  /** LLM-generated reasoning explaining the score */
  reasoning: string;
  /** Skills from the user's profile that match the job requirements */
  matchedSkills: string[];
  /** Skills required by the job but missing from the user's profile */
  missingSkills: string[];
  /** Overall recommendation based on the score */
  recommendation: FitRecommendation;
}
