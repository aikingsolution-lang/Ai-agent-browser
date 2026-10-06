import type { Document, Types } from 'mongoose';
import mongoose, { Schema } from 'mongoose';

export interface IGoldenAnswerSchema {
  id: string;
  question: string;
  answer: string;
  category?: string;
  isDefault?: boolean;
}

export interface IWorkExperience {
  role: string;
  company: string;
  duration?: string;
  highlights?: string[];
}

export interface IWorkExperienceItem {
  id: string;
  company: string;
  title: string;
  startMonth?: string;
  startYear?: string;
  endMonth?: string | null;
  endYear?: string | null;
  isCurrent?: boolean;
  description?: string;
  source?: 'manual' | 'resume';
}

export interface ICareerBrainDocument extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  fullName: string;
  email: string;
  phoneNumber: string;
  currentTitle: string;
  resumeText: string;
  resumeFileName?: string;
  backgroundNarrative?: string;
  skills: string[];
  yearsOfExperience: number;
  hasWorkExperience?: boolean;
  workExperience?: IWorkExperienceItem[];
  education?: string;
  college?: string;
  cgpa?: string;
  workHistory?: IWorkExperience[];
  noticePeriod: string;
  workAuthorization: string;
  skillExperience?: Record<string, number>;
  salaryExpectation?: string;
  currentLocation?: string;
  preferredLocation?: string;
  preferredLocations?: string[];
  portfolioUrl?: string;
  githubUrl?: string;
  linkedinUrl?: string;
  goldenAnswers: IGoldenAnswerSchema[];
  customAnswers: Record<string, string>;
  tier: 'free' | 'premium';
  dailyQuota: {
    appliedToday: number;
    dailyLimit: number;
    lastResetDate: string; // YYYY-MM-DD
  };
  createdAt: Date;
  updatedAt: Date;
}

const goldenAnswerSubSchema = new Schema<IGoldenAnswerSchema>(
  {
    id: { type: String, required: true },
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
    category: { type: String, default: 'General' },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

const workExperienceSubSchema = new Schema<IWorkExperience>(
  {
    role: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true },
    duration: { type: String, default: '', trim: true },
    highlights: { type: [String], default: [] },
  },
  { _id: false },
);

const workExperienceItemSubSchema = new Schema<IWorkExperienceItem>(
  {
    id: { type: String, required: true },
    company: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    startMonth: { type: String, default: '', trim: true },
    startYear: { type: String, default: '', trim: true },
    endMonth: { type: String, default: null },
    endYear: { type: String, default: null },
    isCurrent: { type: Boolean, default: false },
    description: { type: String, default: '', trim: true },
    source: { type: String, enum: ['manual', 'resume'], default: 'manual' },
  },
  { _id: false },
);

const careerBrainSchema = new Schema<ICareerBrainDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      unique: true,
      index: true,
    },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phoneNumber: { type: String, default: '', trim: true },
    currentTitle: { type: String, required: true, trim: true },
    resumeText: { type: String, required: true, trim: true },
    resumeFileName: { type: String, default: '', trim: true },
    backgroundNarrative: { type: String, default: '', trim: true },
    skills: { type: [String], default: [] },
    yearsOfExperience: { type: Number, default: 0, min: 0 },
    hasWorkExperience: { type: Boolean, default: true },
    workExperience: { type: [workExperienceItemSubSchema], default: [] },
    education: { type: String, default: '', trim: true },
    college: { type: String, default: '', trim: true },
    cgpa: { type: String, default: '', trim: true },
    workHistory: { type: [workExperienceSubSchema], default: [] },
    noticePeriod: { type: String, default: 'Immediate', trim: true },
    workAuthorization: { type: String, default: 'Authorized to work', trim: true },
    skillExperience: { type: Schema.Types.Mixed, default: {} },
    salaryExpectation: { type: String, default: '', trim: true },
    currentLocation: { type: String, default: '', trim: true },
    preferredLocation: { type: String, default: '', trim: true },
    preferredLocations: { type: [String], default: [] },
    portfolioUrl: { type: String, default: '', trim: true },
    githubUrl: { type: String, default: '', trim: true },
    linkedinUrl: { type: String, default: '', trim: true },
    goldenAnswers: { type: [goldenAnswerSubSchema], default: [] },
    customAnswers: { type: Schema.Types.Mixed, default: {} },
    tier: {
      type: String,
      enum: ['free', 'premium'],
      default: 'free',
      index: true,
    },
    dailyQuota: {
      appliedToday: { type: Number, default: 0, min: 0 },
      dailyLimit: { type: Number, default: 15, min: 1 },
      lastResetDate: {
        type: String,
        default: () => new Date().toISOString().split('T')[0],
      },
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

export const CareerBrain = mongoose.model<ICareerBrainDocument>('CareerBrain', careerBrainSchema);
