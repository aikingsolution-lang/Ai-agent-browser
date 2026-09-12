/**
 * LinkedIn Easy Apply — TypeScript Interfaces
 *
 * Strict type definitions for job data, application state,
 * screening questions, and fit-score evaluation.
 */

// ─── Status ──────────────────────────────────────────────────────────────────

export const JOB_APPLICATION_STATUSES = [
  'QUEUED',
  'APPLIED',
  'DRY_RUN_SUCCESS',
  'NEEDS_MANUAL_REVIEW',
  'FAILED_MISSING_DATA',
  'PENDING_RESUME_APPROVAL',
] as const;

export type JobApplicationStatus = (typeof JOB_APPLICATION_STATUSES)[number];

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
