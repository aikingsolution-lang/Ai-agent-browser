import mongoose, { Schema, Document, Types } from 'mongoose';

export type CreditTransactionType =
  | 'TRIAL_ALLOCATION'
  | 'SUBSCRIPTION_RENEWAL'
  | 'USAGE_DEDUCTION'
  | 'REFUND'
  | 'ADMIN_ADJUSTMENT'
  | 'PERIOD_EXPIRATION';

export interface ICreditLedger extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  type: CreditTransactionType;
  description: string;
  idempotencyKey?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const creditLedgerSchema = new Schema<ICreditLedger>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription',
      required: [true, 'Subscription ID is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Transaction amount is required'],
      validate: {
        validator: Number.isInteger,
        message: 'Transaction amount must be an integer',
      },
    },
    balanceBefore: {
      type: Number,
      required: [true, 'Balance before transaction is required'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Balance before must be an integer',
      },
    },
    balanceAfter: {
      type: Number,
      required: [true, 'Balance after transaction is required'],
      min: [0, 'Balance after cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Balance after must be an integer',
      },
    },
    type: {
      type: String,
      enum: {
        values: [
          'TRIAL_ALLOCATION',
          'SUBSCRIPTION_RENEWAL',
          'USAGE_DEDUCTION',
          'REFUND',
          'ADMIN_ADJUSTMENT',
          'PERIOD_EXPIRATION',
        ],
        message: '{VALUE} is not a valid credit transaction type',
      },
      required: [true, 'Transaction type is required'],
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
    },
    idempotencyKey: {
      type: String,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // Immutable audit log
  },
);

// Sparse Unique Index: Guarantees idempotency at database level
creditLedgerSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  },
);

// Compound Index: Fast paginated history lookup
creditLedgerSchema.index({ userId: 1, createdAt: -1 });

export const CreditLedger = mongoose.model<ICreditLedger>('CreditLedger', creditLedgerSchema);
