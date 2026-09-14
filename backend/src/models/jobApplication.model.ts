import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

/**
 * Status enum for job application lifecycle.
 *
 * QUEUED               — Job identified, waiting to be processed
 * APPLIED              — Successfully applied via Easy Apply
 * DRY_RUN_SUCCESS      — Dry-run completed without submitting
 * NEEDS_MANUAL_REVIEW  — Application requires human intervention
 * FAILED_MISSING_DATA  — Could not apply due to missing required data
 * PENDING_RESUME_APPROVAL — Resume generated, awaiting user approval before submission
 */
export const JOB_APPLICATION_STATUSES = [
  'QUEUED',
  'APPLIED',
  'DRY_RUN_SUCCESS',
  'NEEDS_MANUAL_REVIEW',
  'FAILED_MISSING_DATA',
  'PENDING_RESUME_APPROVAL',
  'SKIPPED_JOB_REMOVED',
] as const;

export type JobApplicationStatus = (typeof JOB_APPLICATION_STATUSES)[number];

export interface IJobApplication extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  jobId: string;
  title: string;
  company: string;
  location: string;
  salaryRange: string;
  fitScore: number;
  status: JobApplicationStatus;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const jobApplicationSchema = new Schema<IJobApplication>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    jobId: {
      type: String,
      required: [true, 'Job ID (URL hash) is required'],
      trim: true,
    },
    title: {
      type: String,
      required: [true, 'Job title is required'],
      trim: true,
    },
    company: {
      type: String,
      required: [true, 'Company name is required'],
      trim: true,
    },
    location: {
      type: String,
      default: '',
      trim: true,
    },
    salaryRange: {
      type: String,
      default: '',
      trim: true,
    },
    fitScore: {
      type: Number,
      default: 0,
      min: [0, 'Fit score cannot be negative'],
      max: [100, 'Fit score cannot exceed 100'],
    },
    status: {
      type: String,
      enum: JOB_APPLICATION_STATUSES,
      default: 'QUEUED',
      index: true,
    },
    appliedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, any>) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Compound unique index: one user can apply to a specific job only once
jobApplicationSchema.index({ userId: 1, jobId: 1 }, { unique: true });

// Index for querying applications by status efficiently
jobApplicationSchema.index({ userId: 1, status: 1 });

export const JobApplication = mongoose.model<IJobApplication>('JobApplication', jobApplicationSchema);
