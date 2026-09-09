import mongoose, { Schema, Document, Types } from 'mongoose';

export type WebhookProcessingStatus = 'PROCESSING' | 'PROCESSED' | 'FAILED';

export interface IWebhookLedger extends Document {
  _id: Types.ObjectId;
  eventId: string;
  eventType: string;
  providerPaymentId?: string;
  status: WebhookProcessingStatus;
  errorMessage?: string;
  payload: Record<string, any>;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const webhookLedgerSchema = new Schema<IWebhookLedger>(
  {
    eventId: {
      type: String,
      required: [true, 'Event ID is required'],
      trim: true,
    },
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      trim: true,
    },
    providerPaymentId: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ['PROCESSING', 'PROCESSED', 'FAILED'],
        message: '{VALUE} is not a valid webhook processing status',
      },
      default: 'PROCESSING',
      required: true,
    },
    errorMessage: {
      type: String,
      trim: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      default: {},
    },
    processedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// Sparse Unique Index on eventId: Database-level protection against concurrent duplicate webhooks
webhookLedgerSchema.index({ eventId: 1 }, { unique: true });

// Compound Index: Fast lookup for provider payment events
webhookLedgerSchema.index({ providerPaymentId: 1, eventType: 1 });

export const WebhookLedger = mongoose.model<IWebhookLedger>('WebhookLedger', webhookLedgerSchema);
