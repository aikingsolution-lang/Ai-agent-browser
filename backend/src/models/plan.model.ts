import mongoose, { Schema, Document, Types } from 'mongoose';

export type BillingInterval = 'none' | 'monthly' | 'yearly';

export interface IPlan extends Document {
  _id: Types.ObjectId;
  code: string;
  name: string;
  description: string;
  amount: number; // Smallest currency unit (integer paise: ₹299 -> 29900)
  currency: string;
  billingInterval: BillingInterval;
  creditsPerBillingPeriod: number;
  rateLimitPerMinute: number;
  features: string[];
  razorpayPlanId?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<IPlan>(
  {
    code: {
      type: String,
      required: [true, 'Plan code is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    name: {
      type: String,
      required: [true, 'Plan name is required'],
      trim: true,
    },
    description: {
      type: String,
      required: [true, 'Plan description is required'],
    },
    amount: {
      type: Number,
      required: [true, 'Plan amount is required'],
      min: [0, 'Amount must be a non-negative number'],
      validate: {
        validator: Number.isInteger,
        message: 'Amount must be an integer representing the smallest currency unit (e.g. paise)',
      },
    },
    currency: {
      type: String,
      required: [true, 'Currency is required'],
      uppercase: true,
      default: 'INR',
      trim: true,
      minlength: [3, 'Currency must be a 3-letter ISO code'],
      maxlength: [3, 'Currency must be a 3-letter ISO code'],
    },

    billingInterval: {
      type: String,
      enum: {
        values: ['none', 'monthly', 'yearly'],
        message: '{VALUE} is not a valid billing interval',
      },
      required: [true, 'Billing interval is required'],
      default: 'monthly',
    },
    creditsPerBillingPeriod: {
      type: Number,
      required: [true, 'Credits per billing period is required'],
      min: [1, 'Credits per billing period must be at least 1'],
    },
    rateLimitPerMinute: {
      type: Number,
      required: [true, 'Rate limit per minute is required'],
      min: [1, 'Rate limit per minute must be at least 1'],
    },
    features: [{ type: String }],
    razorpayPlanId: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

export const Plan = mongoose.model<IPlan>('Plan', planSchema);
