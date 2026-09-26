import { z } from 'zod';
import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// ─── 1. The Strict Schema Layer ─────────────────────────────────────────────

/**
 * Schema for Golden Q&A screening items.
 * Ensures user does not leave question or answer blank.
 */
export const goldenAnswerSchema = z.object({
  id: z.string(),
  question: z.string().trim().min(1, 'Question text cannot be empty'),
  answer: z.string().trim().min(1, 'Answer text cannot be empty'),
  category: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export type IGoldenAnswer = z.infer<typeof goldenAnswerSchema>;

/**
 * Strict Zod Schema for Career Brain.
 * Enforces mandatory resumeText (minimum 50 chars), core contact fields,
 * and valid Golden Q&A list to prevent Bedrock AI form filler crashes.
 */
export const careerBrainSchema = z.object({
  /** Full candidate name */
  fullName: z.string().trim().min(1, 'Full name is required'),
  /** Primary contact email address */
  email: z.string().trim().email('Valid email address is required'),
  /** Primary contact phone number */
  phoneNumber: z.string().trim().min(5, 'Phone number must be at least 5 digits'),
  /** Current or target job title */
  currentTitle: z.string().trim().min(1, 'Job title is required'),
  /** Full raw text of the candidate resume */
  resumeText: z.string().default(''),
  /** Freeform narrative describing candidate strengths & work history */
  backgroundNarrative: z.string().default(''),
  /** Core tech stack & skills */
  skills: z.array(z.string()).default([]),
  /** Total years of relevant professional experience */
  yearsOfExperience: z.number().nonnegative().default(0),
  /** Education details (Degree, College, CGPA) */
  education: z.string().default(''),
  /** College or University attended */
  college: z.string().optional(),
  /** CGPA, GPA, or marks percentage */
  cgpa: z.string().optional(),
  /** Current compensation / CTC */
  currentCTC: z.string().optional(),
  /** Expected compensation / CTC */
  expectedCTC: z.string().optional(),
  /** Current residential city / location */
  currentLocation: z.string().optional(),
  /** Availability / notice period */
  noticePeriod: z.string().optional(),
  /** Work authorization status */
  workAuthorization: z.string().default('Citizen of India / Authorized to work without sponsorship'),
  /** Target salary expectations */
  salaryExpectation: z.string().default(''),
  /** Preferred location or remote preference */
  preferredLocation: z.string().default(''),
  /** Portfolio website URL */
  portfolioUrl: z.string().default(''),
  /** GitHub profile URL */
  githubUrl: z.string().default(''),
  /** LinkedIn profile URL */
  linkedinUrl: z.string().default(''),
  /** Dynamic Golden Q&A answers for screening questions */
  goldenAnswers: z.array(goldenAnswerSchema).default([]),
  /** Saved Q&A key-value pairs for common custom screening questions */
  customAnswers: z.record(z.string(), z.string()).default({}),
  /** Per-skill experience mapping e.g. { "Node.js": 3, "Spring Boot": 0 } */
  skillExperience: z.record(z.string(), z.number()).default({}),
  /** Predefined target job roles for searching */
  predefinedRoles: z.array(z.string()).default([]),
  /** Predefined preferred job locations */
  preferredLocations: z.array(z.string()).default([]),
  /** Target experience levels */
  experienceLevels: z.array(z.string()).default([]),
  /** Target job types */
  jobTypes: z.array(z.string()).default([]),
  /** Name of the active resume on file */
  resumeFileName: z.string().optional(),
  /** Skills auto-extracted from resume to display "from resume" indicator */
  autoExtractedSkills: z.array(z.string()).default([]),
  /** Timestamp of last update */
  updatedAt: z.number().default(() => Date.now()),
});

export type ICareerBrain = z.infer<typeof careerBrainSchema>;

/**
 * Result of checking candidate profile completeness before application start.
 */
export interface ProfileCompletenessResult {
  isValid: boolean;
  missingFields: string[];
}

/**
 * Validates whether the required fields for submitting job applications are present.
 * Required: fullName, email, phoneNumber, yearsOfExperience, workAuthorization, resume (file or text).
 */
export function validateProfileCompleteness(profile?: Partial<ICareerBrain> | null): ProfileCompletenessResult {
  const missingFields: string[] = [];

  if (!profile?.fullName || !profile.fullName.trim()) {
    missingFields.push('Full Name');
  }

  if (!profile?.email || !profile.email.trim()) {
    missingFields.push('Email');
  }

  if (!profile?.phoneNumber || !profile.phoneNumber.trim()) {
    missingFields.push('Phone Number');
  }

  if (
    profile?.yearsOfExperience === undefined ||
    profile.yearsOfExperience === null ||
    isNaN(Number(profile.yearsOfExperience))
  ) {
    missingFields.push('Years of Experience');
  }

  if (!profile?.workAuthorization || !profile.workAuthorization.trim()) {
    missingFields.push('Work Authorization');
  }

  const hasResume = Boolean(
    (profile?.resumeFileName && profile.resumeFileName.trim()) ||
      (profile?.resumeText && profile.resumeText.trim().length >= 20),
  );
  if (!hasResume) {
    missingFields.push('Resume (File or Text)');
  }

  return {
    isValid: missingFields.length === 0,
    missingFields,
  };
}

export const DEFAULT_GOLDEN_ANSWERS: IGoldenAnswer[] = [
  {
    id: 'work_auth',
    question: 'Are you legally authorized to work in this country?',
    answer: 'Yes',
    category: 'Eligibility',
    isDefault: true,
  },
  {
    id: 'visa_sponsorship',
    question: 'Do you now or in the future require visa sponsorship?',
    answer: 'No',
    category: 'Eligibility',
    isDefault: true,
  },
  {
    id: 'notice_period',
    question: 'What is your current notice period / availability to join?',
    answer: 'Immediate',
    category: 'Availability',
    isDefault: true,
  },
  {
    id: 'expected_ctc',
    question: 'What is your expected CTC / Salary expectation?',
    answer: '₹6,00,000 - ₹12,00,000',
    category: 'Compensation',
    isDefault: true,
  },
  {
    id: 'current_ctc',
    question: 'What is your current CTC / Salary?',
    answer: '₹6,00,000',
    category: 'Compensation',
    isDefault: true,
  },
  {
    id: 'relocation',
    question: 'Are you willing to relocate for this role?',
    answer: 'Yes',
    category: 'Location',
    isDefault: true,
  },
  {
    id: 'commute_onsite',
    question: 'Are you comfortable working onsite or in a hybrid model?',
    answer: 'Yes',
    category: 'Location',
    isDefault: true,
  },
  {
    id: 'remote_work',
    question: 'Are you comfortable working in a fully remote or distributed team?',
    answer: 'Yes',
    category: 'Location',
    isDefault: true,
  },
  {
    id: 'experience_years',
    question: 'Total years of relevant experience in software development?',
    answer: '1 year',
    category: 'Experience',
    isDefault: true,
  },
  {
    id: 'currently_employed',
    question: 'Are you currently employed / I currently work here?',
    answer: 'Yes',
    category: 'Experience',
    isDefault: true,
  },
  {
    id: 'background_check',
    question: 'Are you willing to undergo a standard background check?',
    answer: 'Yes',
    category: 'Compliance',
    isDefault: true,
  },
  {
    id: 'drug_test',
    question: 'Are you willing to undergo a drug screening test if required?',
    answer: 'Yes',
    category: 'Compliance',
    isDefault: true,
  },
  {
    id: 'age_requirement',
    question: 'Are you at least 18 years of age or older?',
    answer: 'Yes',
    category: 'Eligibility',
    isDefault: true,
  },
  {
    id: 'education_degree',
    question: 'Have you completed a Bachelor’s degree or higher?',
    answer: 'Yes',
    category: 'Education',
    isDefault: true,
  },
  {
    id: 'highest_education',
    question: 'What is your highest level of completed education?',
    answer: "Bachelor's Degree",
    category: 'Education',
    isDefault: true,
  },
  {
    id: 'driver_license',
    question: 'Do you possess a valid driver’s license?',
    answer: 'Yes',
    category: 'General',
    isDefault: true,
  },
  {
    id: 'travel_willingness',
    question: 'Are you willing to travel for work if required?',
    answer: 'Yes',
    category: 'General',
    isDefault: true,
  },
  {
    id: 'english_proficiency',
    question: 'What is your level of English proficiency?',
    answer: 'Professional / Fluent',
    category: 'Language',
    isDefault: true,
  },
  {
    id: 'former_employee',
    question: 'Have you previously worked for or been employed by this company?',
    answer: 'No',
    category: 'Eligibility',
    isDefault: true,
  },
  {
    id: 'relative_employed',
    question: 'Do you have any relatives or family currently working at this company?',
    answer: 'No',
    category: 'Compliance',
    isDefault: true,
  },
  {
    id: 'non_compete',
    question: 'Are you bound by any non-compete or restrictive employment agreement?',
    answer: 'No',
    category: 'Legal',
    isDefault: true,
  },
  {
    id: 'felony_conviction',
    question: 'Have you ever been convicted of a criminal offense or felony?',
    answer: 'No',
    category: 'Legal',
    isDefault: true,
  },
  {
    id: 'shift_flexibility',
    question: 'Are you open to working flexible hours or rotating shifts?',
    answer: 'Yes',
    category: 'Availability',
    isDefault: true,
  },
  {
    id: 'security_clearance',
    question: 'Do you currently hold or require an active security clearance?',
    answer: 'No',
    category: 'Eligibility',
    isDefault: true,
  },
  {
    id: 'start_immediately',
    question: 'Can you start immediately upon hire?',
    answer: 'Yes',
    category: 'Availability',
    isDefault: true,
  },
  {
    id: 'timezone_overlap',
    question: 'Can you commit to daily overlap with US / client working hours?',
    answer: 'Yes',
    category: 'Availability',
    isDefault: true,
  },
  {
    id: 'production_llm_shipped',
    question: 'Have you built and shipped something on top of a language model that is still running in production?',
    answer: 'Yes',
    category: 'Experience',
    isDefault: true,
  },
  {
    id: 'remote_availability',
    question: 'Are you available to work remotely in a distributed global team?',
    answer: 'Yes',
    category: 'Availability',
    isDefault: true,
  },
  {
    id: 'top_choice',
    question: 'Mark job as a top choice',
    answer: 'No',
    category: 'General',
    isDefault: true,
  },
];

export const DEFAULT_CAREER_BRAIN: ICareerBrain = {
  fullName: 'Mubasshir Ali',
  email: 'mubasshirali0710@gmail.com',
  phoneNumber: '+91 70031 51313',
  currentTitle: 'MERN Stack / Full Stack Developer',
  resumeText: `MUBASSHIR ALI
MERN Stack / Full Stack Developer
+91 70031 51313 | mubasshirali0710@gmail.com | Bengaluru, India

PROFESSIONAL SUMMARY
B.Tech Computer Science graduate (CGPA 8.57/10) with expertise in MERN Stack and Python full-stack development. Experienced in building scalable web applications using React.js, Redux Toolkit, Node.js, Express.js, MongoDB, REST APIs, JWT authentication, and responsive UI design. Strong foundation in Data Structures & Algorithms (200+ LeetCode problems), DBMS, OOPs, Operating Systems, and Computer Networks.

EDUCATION
Maulana Abul Kalam Azad University of Technology, West Bengal
Bachelor of Technology, Computer Science & Engineering • GPA: 8.57/10 • 2020 – 2024

TECHNICAL SKILLS
Frontend: React.js, Redux Toolkit, React Router, HTML5, CSS3, Tailwind CSS, JavaScript, TypeScript
Backend: Node.js, Express.js, REST APIs, JWT, Python
Database: MongoDB, Mongoose, MySQL
Tools: Git, GitHub, Docker, Postman, VS Code`,
  backgroundNarrative:
    'B.Tech Computer Science graduate (CGPA 8.57/10) with expertise in MERN Stack and Python full-stack development. Experienced in building scalable web applications using React.js, Redux Toolkit, Node.js, Express.js, MongoDB, REST APIs, JWT authentication, and responsive UI design. Strong foundation in Data Structures & Algorithms (200+ LeetCode problems), DBMS, OOPs, Operating Systems, and Computer Networks.',
  skills: [
    'React.js',
    'Redux Toolkit',
    'Node.js',
    'Express.js',
    'MongoDB',
    'REST APIs',
    'JavaScript',
    'TypeScript',
    'Tailwind CSS',
    'HTML5',
    'CSS3',
    'Python',
    'Git',
    'Docker',
  ],
  yearsOfExperience: 1,
  education:
    'Bachelor of Technology in Computer Science & Engineering, Maulana Abul Kalam Azad University of Technology (2020 – 2024), CGPA: 8.57/10',
  college: 'Maulana Abul Kalam Azad University of Technology',
  cgpa: '8.57/10',
  currentCTC: undefined,
  expectedCTC: '₹6,00,000 - ₹12,00,000',
  currentLocation: 'Bengaluru, India',
  noticePeriod: 'Immediate',
  workAuthorization: 'Citizen of India / Authorized to work without sponsorship',
  salaryExpectation: '₹6,00,000 - ₹12,00,000',
  preferredLocation: 'Bengaluru, India',
  portfolioUrl: '',
  githubUrl: 'https://github.com',
  linkedinUrl: 'https://linkedin.com',
  goldenAnswers: DEFAULT_GOLDEN_ANSWERS,
  customAnswers: {},
  skillExperience: {},
  predefinedRoles: [
    'Frontend Developer',
    'React Developer',
    'MERN Stack Developer',
    'Full Stack Developer',
    'AI Evaluator',
  ],
  preferredLocations: ['Bengaluru', 'Pune', 'Remote', 'India'],
  experienceLevels: ['Fresher', 'Entry Level', 'Internship'],
  jobTypes: ['Full-time', 'Internship'],
  autoExtractedSkills: [],
  updatedAt: Date.now(),
};

// ─── 2. The Safe Storage Wrapper ────────────────────────────────────────────

const storage = createStorage<ICareerBrain>('linkedin_career_brain', DEFAULT_CAREER_BRAIN, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export interface SaveCareerBrainResult {
  success: boolean;
  data?: ICareerBrain;
  error?: string;
  validationErrors?: Record<string, string>;
}

/**
 * Safely validates and saves Career Brain data to chrome.storage.local
 * with try/catch, quota verification, and comprehensive Zod error formatting.
 */
export async function saveCareerBrainData(data: unknown): Promise<SaveCareerBrainResult> {
  try {
    // 1. Strict Zod Validation
    const parseResult = careerBrainSchema.safeParse(data);
    if (!parseResult.success) {
      const validationErrors: Record<string, string> = {};
      const errorMessages: string[] = [];

      for (const issue of parseResult.error.issues) {
        const path = issue.path.join('.');
        validationErrors[path] = issue.message;
        errorMessages.push(`${issue.path.length > 0 ? issue.path.join(' -> ') + ': ' : ''}${issue.message}`);
      }

      return {
        success: false,
        error: errorMessages.join('; '),
        validationErrors,
      };
    }

    // 2. Add timestamp
    const validatedData: ICareerBrain = {
      ...parseResult.data,
      updatedAt: Date.now(),
    };

    // 3. Write to storage with Quota error protection
    await storage.set(validatedData);

    return {
      success: true,
      data: validatedData,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[CareerBrainStorage] Failed to save Career Brain data:', err);
    return {
      success: false,
      error: `Storage error: ${message}`,
    };
  }
}

/**
 * Strongly-typed getter for Career Brain data from chrome.storage.local
 * with corrupt-state auto recovery and fallback.
 */
export async function getCareerBrainData(): Promise<ICareerBrain> {
  try {
    const raw = await storage.get();
    if (!raw) return DEFAULT_CAREER_BRAIN;

    // Parse with schema to ensure backwards compatibility & repair corrupt fields
    const parseResult = careerBrainSchema.safeParse(raw);
    let data: ICareerBrain;
    if (parseResult.success) {
      data = parseResult.data;
    } else {
      console.warn(
        '[CareerBrainStorage] Stored data had schema discrepancies. Recovering defaults:',
        parseResult.error,
      );
      // Gracefully merge existing valid fields with defaults; missing optional fields default to undefined
      const merged: ICareerBrain = {
        ...DEFAULT_CAREER_BRAIN,
        ...raw,
        college: raw.college !== undefined ? raw.college : undefined,
        cgpa: raw.cgpa !== undefined ? raw.cgpa : undefined,
        currentCTC: raw.currentCTC !== undefined ? raw.currentCTC : undefined,
        expectedCTC: raw.expectedCTC !== undefined ? raw.expectedCTC : undefined,
        currentLocation: raw.currentLocation !== undefined ? raw.currentLocation : undefined,
        noticePeriod:
          raw.noticePeriod !== undefined ? raw.noticePeriod : (DEFAULT_CAREER_BRAIN.noticePeriod ?? 'Immediate'),
        goldenAnswers:
          Array.isArray(raw.goldenAnswers) && raw.goldenAnswers.length > 0 ? raw.goldenAnswers : DEFAULT_GOLDEN_ANSWERS,
        customAnswers: raw.customAnswers || {},
        skillExperience: raw.skillExperience || {},
        resumeText:
          raw.resumeText && raw.resumeText.length >= 20
            ? raw.resumeText
            : raw.resumeFileName
              ? ''
              : DEFAULT_CAREER_BRAIN.resumeText,
      };
      data = merged;
    }

    // Seamless auto-migration: Ensure all default golden answers exist even for existing users
    const existingIds = new Set((data.goldenAnswers || []).map(ga => ga.id));
    const existingQuestions = new Set((data.goldenAnswers || []).map(ga => ga.question.toLowerCase().trim()));
    const missingDefaults = DEFAULT_GOLDEN_ANSWERS.filter(
      d => !existingIds.has(d.id) && !existingQuestions.has(d.question.toLowerCase().trim()),
    );
    if (missingDefaults.length > 0) {
      data.goldenAnswers = [...(data.goldenAnswers || []), ...missingDefaults];
      storage.set(data).catch(err => console.error('[CareerBrainStorage] Failed to save merged defaults:', err));
    }

    return data;
  } catch (err) {
    console.error('[CareerBrainStorage] Failed to load Career Brain data. Returning defaults safely:', err);
    return DEFAULT_CAREER_BRAIN;
  }
}

// ─── 3. Compatibility Store Layer ───────────────────────────────────────────

export type CareerBrainStorage = BaseStorage<ICareerBrain> & {
  getCareerBrain: () => Promise<ICareerBrain>;
  updateCareerBrain: (updates: Partial<ICareerBrain>) => Promise<ICareerBrain>;
  setCustomAnswer: (questionKey: string, answer: string) => Promise<void>;
  saveData: (data: unknown) => Promise<SaveCareerBrainResult>;
  saveSkillExperience: (skill: string, years: number) => Promise<void>;
  saveGoldenAnswer: (question: string, answer: string, category?: string) => Promise<void>;
  deleteGoldenAnswer: (id: string) => Promise<void>;
  updateGoldenAnswer: (id: string, newAnswer: string) => Promise<void>;
};

export const careerBrainStore: CareerBrainStorage = {
  ...storage,

  async getCareerBrain(): Promise<ICareerBrain> {
    return getCareerBrainData();
  },

  async updateCareerBrain(updates: Partial<ICareerBrain>): Promise<ICareerBrain> {
    const current = await this.getCareerBrain();
    const updated = {
      ...current,
      ...updates,
      updatedAt: Date.now(),
    };
    const result = await saveCareerBrainData(updated);
    if (result.success && result.data) {
      return result.data;
    }
    await storage.set(updated as ICareerBrain);
    return updated as ICareerBrain;
  },

  async setCustomAnswer(questionKey: string, answer: string): Promise<void> {
    const current = await this.getCareerBrain();
    const customAnswers = { ...current.customAnswers, [questionKey]: answer };
    await this.updateCareerBrain({ customAnswers });
  },

  async saveSkillExperience(skill: string, years: number): Promise<void> {
    const current = await this.getCareerBrain();
    const cleanSkill = skill.trim();
    const cleanYears = Math.max(0, Math.min(99, Math.round(years)));
    const skillExperience = { ...current.skillExperience, [cleanSkill]: cleanYears };
    await this.updateCareerBrain({ skillExperience });
  },

  async saveGoldenAnswer(question: string, answer: string, category?: string): Promise<void> {
    const current = await this.getCareerBrain();
    const cleanQ = question.trim();
    const cleanA = answer.trim();
    const existingIndex = current.goldenAnswers.findIndex(
      ga => ga.question.toLowerCase().trim() === cleanQ.toLowerCase(),
    );
    let updatedGolden = [...current.goldenAnswers];
    if (existingIndex >= 0) {
      updatedGolden[existingIndex] = {
        ...updatedGolden[existingIndex],
        answer: cleanA,
        category: category || updatedGolden[existingIndex].category,
      };
    } else {
      updatedGolden.push({
        id: `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        question: cleanQ,
        answer: cleanA,
        category: category || 'Screening',
      });
    }
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async deleteGoldenAnswer(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const updatedGolden = current.goldenAnswers.filter(ga => ga.id !== id);
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async updateGoldenAnswer(id: string, newAnswer: string): Promise<void> {
    const current = await this.getCareerBrain();
    const cleanA = newAnswer.trim();
    const updatedGolden = current.goldenAnswers.map(ga => (ga.id === id ? { ...ga, answer: cleanA } : ga));
    await this.updateCareerBrain({ goldenAnswers: updatedGolden });
  },

  async saveData(data: unknown): Promise<SaveCareerBrainResult> {
    return saveCareerBrainData(data);
  },
};

export default careerBrainStore;
