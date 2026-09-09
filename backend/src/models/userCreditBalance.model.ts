import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IUserCreditBalance extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  allocatedCredits: number;
  usedCredits: number;
  remainingCredits: number;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userCreditBalanceSchema = new Schema<IUserCreditBalance>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription',
      required: [true, 'Subscription ID is required'],
      index: true,
    },
    allocatedCredits: {
      type: Number,
      required: [true, 'Allocated credits is required'],
      min: [0, 'Allocated credits cannot be negative'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Allocated credits must be an integer',
      },
    },
    usedCredits: {
      type: Number,
      required: [true, 'Used credits is required'],
      min: [0, 'Used credits cannot be negative'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Used credits must be an integer',
      },
    },
    remainingCredits: {
      type: Number,
      required: [true, 'Remaining credits is required'],
      min: [0, 'Remaining credits cannot be negative'],
      default: 0,
      validate: {
        validator: Number.isInteger,
        message: 'Remaining credits must be an integer',
      },
    },
    periodStart: {
      type: Date,
      required: [true, 'Period start date is required'],
    },
    periodEnd: {
      type: Date,
      required: [true, 'Period end date is required'],
    },
  },
  {
    timestamps: true,
  },
);

// Compound Index: Fast lookups for balance checks with remaining credits
userCreditBalanceSchema.index({ userId: 1, remainingCredits: 1 });

export const UserCreditBalance = mongoose.model<IUserCreditBalance>('UserCreditBalance', userCreditBalanceSchema);
