import mongoose, { Schema, Document } from 'mongoose';

export type LlmRequestStatus = 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'TIMEOUT';

export interface ILlmUsageLog {
  _id: mongoose.Types.ObjectId;
  requestId: string;
  userId: mongoose.Types.ObjectId;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  creditsDeducted: number;
  latencyMs: number;
  status: LlmRequestStatus;
  errorMessage?: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export type ILlmUsageLogDocument = ILlmUsageLog & Document;

const LlmUsageLogSchema: Schema = new Schema(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      required: true,
      default: 'openai',
    },
    model: {
      type: String,
      required: true,
    },
    promptTokens: {
      type: Number,
      default: 0,
    },
    completionTokens: {
      type: Number,
      default: 0,
    },
    totalTokens: {
      type: Number,
      default: 0,
    },
    creditsDeducted: {
      type: Number,
      default: 0,
    },
    latencyMs: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'PARTIAL', 'TIMEOUT'],
      required: true,
    },
    errorMessage: {
      type: String,
    },
    idempotencyKey: {
      type: String,
      sparse: true,
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for user usage queries
LlmUsageLogSchema.index({ userId: 1, createdAt: -1 });

export const LlmUsageLog = mongoose.model<ILlmUsageLogDocument>('LlmUsageLog', LlmUsageLogSchema);
