import mongoose, { Schema, Document, Types } from 'mongoose';
import type { BillingInterval } from './plan.model.js';

export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED';

export interface ISubscription extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  planCodeSnapshot: string;
  planNameSnapshot: string;
  amountSnapshot: number; // Smallest currency unit (integer paise: ₹499 -> 49900)
  currencySnapshot: string;
  billingIntervalSnapshot: BillingInterval;
  creditsSnapshot: number;
  rateLimitSnapshot: number;
  provider: 'manual' | 'razorpay';
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  status: SubscriptionStatus;
  isTrial: boolean;
  trialStartDate?: Date;
  trialEndDate?: Date;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  endedAt?: Date;
  pastDueStartedAt?: Date;
  lastEventTimestamp?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const subscriptionSchema = new Schema<ISubscription>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
    },

    planId: {
      type: Schema.Types.ObjectId,
      ref: 'Plan',
      required: [true, 'Plan ID is required'],
    },
    planCodeSnapshot: {
      type: String,
      required: [true, 'Plan code snapshot is required'],
    },
    planNameSnapshot: {
      type: String,
      required: [true, 'Plan name snapshot is required'],
    },
    amountSnapshot: {
      type: Number,
      required: [true, 'Amount snapshot is required'],
      min: [0, 'Amount snapshot must be a non-negative number'],
      validate: {
        validator: Number.isInteger,
        message: 'amountSnapshot must be an integer representing the smallest currency unit (e.g. paise)',
      },
    },
    currencySnapshot: {
      type: String,
      required: [true, 'Currency snapshot is required'],
      uppercase: true,
      default: 'INR',
      trim: true,
      minlength: [3, 'Currency snapshot must be a 3-letter ISO code'],
      maxlength: [3, 'Currency snapshot must be a 3-letter ISO code'],
    },

    billingIntervalSnapshot: {
      type: String,
      enum: {
        values: ['none', 'monthly', 'yearly'],
        message: '{VALUE} is not a valid billing interval snapshot',
      },
      required: [true, 'Billing interval snapshot is required'],
    },
    creditsSnapshot: {
      type: Number,
      required: [true, 'Credits snapshot is required'],
      min: [1, 'Credits snapshot must be at least 1'],
    },
    rateLimitSnapshot: {
      type: Number,
      required: [true, 'Rate limit snapshot is required'],
      min: [1, 'Rate limit snapshot must be at least 1'],
    },
    provider: {
      type: String,
      enum: {
        values: ['manual', 'razorpay'],
        message: '{VALUE} is not a valid provider',
      },
      default: 'manual',
    },
    providerCustomerId: {
      type: String,
      trim: true,
      index: true,
    },
    providerSubscriptionId: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    status: {
      type: String,
      enum: {
        values: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'],
        message: '{VALUE} is not a valid subscription status',
      },
      required: [true, 'Status is required'],
      default: 'TRIALING',
    },
    isTrial: {
      type: Boolean,
      default: false,
    },
    trialStartDate: { type: Date },
    trialEndDate: {
      type: Date,
      validate: {
        validator: function (this: ISubscription, val?: Date) {
          if (!val || !this.trialStartDate) return true;
          return val > this.trialStartDate;
        },
        message: 'Trial end date must be after trial start date',
      },
    },
    currentPeriodStart: {
      type: Date,
      required: [true, 'Current period start date is required'],
    },
    currentPeriodEnd: {
      type: Date,
      required: [true, 'Current period end date is required'],
      validate: {
        validator: function (this: ISubscription, val: Date) {
          if (!val || !this.currentPeriodStart) return true;
          return val > this.currentPeriodStart;
        },
        message: 'Current period end date must be after current period start date',
      },
    },

    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },
    canceledAt: { type: Date },
    endedAt: { type: Date },
    pastDueStartedAt: { type: Date },
    lastEventTimestamp: { type: Date },
  },
  {
    timestamps: true,
  },
);

// Data Integrity Guard: Auto-populate trialEndDate if missing, while enforcing trialEndDate > trialStartDate via schema validator
subscriptionSchema.pre('validate', function (next) {
  if (this.isTrial && this.trialStartDate) {
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
    const expectedEndDate = new Date(this.trialStartDate.getTime() + FIVE_DAYS_MS);

    if (!this.trialEndDate) {
      this.trialEndDate = expectedEndDate;
    }

    if (this.status === 'TRIALING' && !this.currentPeriodEnd) {
      this.currentPeriodStart = this.trialStartDate;
      this.currentPeriodEnd = this.trialEndDate;
    }
  }
  next();
});

// Partial Unique Index 1: Max 1 concurrent entitled subscription per user (TRIALING, ACTIVE, PAST_DUE)
subscriptionSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
    },
  },
);

// Partial Unique Index 2: Max 1 historical free trial per user (isTrial = true)
subscriptionSchema.index(
  { userId: 1, isTrial: 1 },
  {
    unique: true,
    partialFilterExpression: { isTrial: true },
  },
);

// Compound Index: Fast background expiration queries for trialing subscriptions
subscriptionSchema.index({ status: 1, isTrial: 1, trialEndDate: 1 });

export const Subscription = mongoose.model<ISubscription>('Subscription', subscriptionSchema);
