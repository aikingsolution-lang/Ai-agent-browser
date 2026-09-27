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
 * Detects generic relative date screening questions for work history, such as:
 * "Month of From", "Year of From", "Month of To", "Year of To", "From: Month", etc.
 * These are job/position specific and must NEVER be stored as generic golden answers.
 */
export function isGenericWorkExperienceDateField(question: string): boolean {
  if (!question || typeof question !== 'string') return false;
  const q = question.trim().toLowerCase();
  if (
    /how\s*many|years\s*of\s*(?:total\s*|overall\s*)?experience|notice\s*period|ctc|salary|when\s*can\s*you/i.test(q)
  ) {
    return false;
  }
  return (
    /\b(?:from|start)\s*(?:month|year|date)\b|\b(?:to|end|completion|finish)\s*(?:month|year|date)\b|\b(?:month|year)\s+(?:of\s+)?(?:from|start|to|end)\b|\b(?:from|to)\s*:\s*(?:month|year)\b/i.test(
      q,
    ) || /^(?:start|from|end|to)\s*(?:month|year)$/i.test(q)
  );
}

/**
 * Cleans a location string to extract a clean city / geographic location.
 * Strips out "or Remote", "(Remote)", "Remote /", "Hybrid", etc.
 * E.g., "Bengaluru, India or Remote" -> "Bengaluru, India".
 */
export function cleanLocationForCityField(rawLocation: string | undefined | null): string {
  if (!rawLocation || typeof rawLocation !== 'string') return '';
  let loc = rawLocation.trim();
  loc = loc
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*remote\b/gi, '')
    .replace(/\bremote\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(remote\)/gi, '')
    .replace(/\[remote\]/gi, '')
    .replace(/(?:(?:\b(?:or|and)\b)|[/\\])\s*hybrid\b/gi, '')
    .replace(/\bhybrid\s*(?:(?:\b(?:or|and)\b)|[/\\])/gi, '')
    .replace(/\(hybrid\)/gi, '')
    .replace(/\[hybrid\]/gi, '')
    .replace(/\s*,\s*remote\b/gi, '')
    .replace(/\bremote\s*,\s*/gi, '')
    .replace(/\bremote\b/gi, '')
    .replace(/^[,\-\s/\\|]+|[,\-\s/\\|]+$/g, '')
    .trim();
  return loc;
}

/**
 * Sanitizes and purges fabricated/hallucinated skillExperience entries from storage.
 * Detects uniform defaults (e.g. 4+ skills with "5 years" for an intern) or skills
 * exceeding verifiable tenure without explicit textual grounding.
 */
export function sanitizeStoredSkillExperience(
  rawSkillExp: Record<string, number> | undefined | null,
  workExp?: Array<{
    company?: string;
    title?: string;
    startYear?: string | number;
    endYear?: string | null | number;
    isCurrent?: boolean;
    description?: string;
  }> | null,
  rawResumeText?: string | null,
  overallYoe?: number | string | null,
): Record<string, number> {
  if (!rawSkillExp || typeof rawSkillExp !== 'object') return {};

  const cleanExp: Record<string, number> = {};
  const currentYear = new Date().getFullYear();

  let maxVerifiableTenure = 0;
  const validWorkExp = Array.isArray(workExp) ? workExp : [];

  for (const role of validWorkExp) {
    if (!role) continue;
    const startYr = parseInt(String(role.startYear || ''), 10);
    if (!isNaN(startYr) && startYr >= 1970 && startYr <= currentYear + 1) {
      const endYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
      const tenure = Math.max(0, (!isNaN(endYr) ? endYr : currentYear) - startYr);
      if (tenure > maxVerifiableTenure) {
        maxVerifiableTenure = tenure;
      }
    }
  }

  if (overallYoe !== undefined && overallYoe !== null) {
    const numYoe = parseInt(String(overallYoe), 10);
    if (!isNaN(numYoe) && numYoe >= 0) {
      if (validWorkExp.length === 0) {
        maxVerifiableTenure = numYoe;
      } else {
        maxVerifiableTenure = Math.max(maxVerifiableTenure, numYoe);
      }
    }
  }

  const entries = Object.entries(rawSkillExp);
  const valueCounts = new Map<number, number>();
  for (const [_, val] of entries) {
    if (typeof val === 'number' && !isNaN(val) && val > 0) {
      valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
    }
  }

  const suspectedFabricatedValues = new Set<number>();
  for (const [val, count] of valueCounts.entries()) {
    if (count >= 4 && val > Math.max(1, maxVerifiableTenure)) {
      suspectedFabricatedValues.add(val);
    }
  }

  for (const [skill, claimedYears] of entries) {
    if (!skill || typeof claimedYears !== 'number' || isNaN(claimedYears) || claimedYears <= 0) {
      continue;
    }
    const clean = skill
      .trim()
      .replace(/^[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+|[.,;:!?'"()[\]{}<>/\\|`~*#&^%$@+=]+$/g, '')
      .trim();
    if (!clean || clean.length > 35) continue;

    // Check if resume text explicitly states duration
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicitRegex = new RegExp(
      `(?:\\b${escaped}\\b[^\\n\\r,]{0,35}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?)|(?:(?:for|with)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,35}?\\b${escaped}\\b)`,
      'i',
    );
    const textMatch = rawResumeText ? rawResumeText.match(explicitRegex) : null;

    if (textMatch) {
      const explicitNum = parseFloat(textMatch[1] || textMatch[2]);
      if (!isNaN(explicitNum) && explicitNum > 0) {
        cleanExp[clean] = Math.round(explicitNum);
        continue;
      }
    }

    const isFabricatedValue = suspectedFabricatedValues.has(claimedYears);

    let skillRoleTenure: number | null = null;
    const lowerSkill = clean.toLowerCase();

    for (const role of validWorkExp) {
      const roleText = `${role.title || ''} ${role.company || ''} ${role.description || ''}`.toLowerCase();
      if (roleText.includes(lowerSkill)) {
        const sYr = parseInt(String(role.startYear || ''), 10);
        if (!isNaN(sYr)) {
          const eYr = role.isCurrent || !role.endYear ? currentYear : parseInt(String(role.endYear), 10);
          const rTenure = Math.max(0, (!isNaN(eYr) ? eYr : currentYear) - sYr);
          skillRoleTenure = Math.max(skillRoleTenure ?? 0, rTenure);
        }
      }
    }

    if (skillRoleTenure !== null) {
      if (maxVerifiableTenure === 0) {
        continue;
      }
      const verifiedYears = Math.min(claimedYears, Math.max(1, skillRoleTenure), Math.max(1, maxVerifiableTenure));
      cleanExp[clean] = verifiedYears;
    } else {
      if (isFabricatedValue || claimedYears > maxVerifiableTenure) {
        continue;
      }
      if (maxVerifiableTenure > 0 && claimedYears <= maxVerifiableTenure) {
        cleanExp[clean] = claimedYears;
      }
    }
  }

  return cleanExp;
}

/**
 * Schema for structured candidate work experience.
 */
export const workExperienceItemSchema = z.object({
  id: z.string(),
  company: z.string().trim().min(1, 'Company is required'),
  title: z.string().trim().min(1, 'Job title is required'),
  startMonth: z.string().default(''),
  startYear: z.string().default(''),
  endMonth: z.string().nullable().default(null),
  endYear: z.string().nullable().default(null),
  isCurrent: z.boolean().default(false),
  description: z.string().default(''),
  source: z.enum(['manual', 'resume']).default('manual'),
});

export type IWorkExperienceItem = z.infer<typeof workExperienceItemSchema>;

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
  /** Flag indicating whether the candidate has professional work experience */
  hasWorkExperience: z.boolean().default(true),
  /** Structured work experience items */
  workExperience: z.array(workExperienceItemSchema).default([]),
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
  /** Candidate gender identity (Male, Female, Other, Prefer not to say) */
  gender: z.string().default('Male'),
  /** Candidate date of birth (YYYY-MM-DD or DD/MM/YYYY) */
  dateOfBirth: z.string().optional(),
  /** Highest completed education level */
  highestEducation: z.string().default("Bachelor's Degree"),
  /** Willingness to relocate for the job */
  willingToRelocate: z.string().default('Yes'),
  /** Preferred work shift (Day / Flexible, Night Shift, Any) */
  preferredShift: z.string().default('Day / Flexible'),
  /** Valid driver's license possession */
  driverLicense: z.string().default('Yes'),
  /** Military / Protected Veteran status */
  veteranStatus: z.string().default('I am not a protected veteran'),
  /** Disability self-identification status */
  disabilityStatus: z.string().default('No, I do not have a disability'),
  /** Timestamp of last update */
  updatedAt: z.number().default(() => Date.now()),
});

export const GOLDEN_ANSWER_CATEGORIES = [
  'Eligibility / Legal',
  'Location & Relocation',
  'Compensation',
  'Experience & Education',
  'Availability & Shifts',
  'Yes/No Screening',
  'Diversity / Self-Identification',
] as const;

export type GoldenAnswerCategory = (typeof GOLDEN_ANSWER_CATEGORIES)[number];

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
  // ── 1. Eligibility / Legal ──
  {
    id: 'work_auth',
    question: 'Are you legally authorized to work in this country / India?',
    answer: 'Yes',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'visa_sponsorship',
    question: 'Will you now or in the future require visa sponsorship?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'age_requirement',
    question: 'Are you at least 18 years of age or older?',
    answer: 'Yes',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'security_clearance',
    question: 'Do you currently hold or require an active security clearance?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'non_compete',
    question: 'Are you bound by any non-compete or restrictive employment agreement?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },
  {
    id: 'felony_conviction',
    question: 'Have you ever been convicted of a criminal offense or felony?',
    answer: 'No',
    category: 'Eligibility / Legal',
    isDefault: true,
  },

  // ── 2. Location & Relocation ──
  {
    id: 'current_location_city',
    question: 'What is your current location / city of residence?',
    answer: 'Bengaluru, India',
    category: 'Location & Relocation',
    isDefault: true,
  },
  {
    id: 'relocation',
    question: 'Are you willing to relocate for this role?',
    answer: 'Yes',
    category: 'Location & Relocation',
    isDefault: true,
  },
  {
    id: 'work_mode_preference',
    question: 'Are you willing to work from office / hybrid / remote?',
    answer: 'Yes (Open to Remote, Hybrid, or Onsite)',
    category: 'Location & Relocation',
    isDefault: true,
  },
  {
    id: 'commute_onsite',
    question: 'Are you able to reliably commute or work onsite?',
    answer: 'Yes',
    category: 'Location & Relocation',
    isDefault: true,
  },

  // ── 3. Compensation ──
  {
    id: 'current_ctc',
    question: 'What is your current CTC / Annual Salary?',
    answer: '₹6,00,000',
    category: 'Compensation',
    isDefault: true,
  },
  {
    id: 'expected_ctc',
    question: 'What is your expected CTC / Annual Salary expectation?',
    answer: '₹10,00,000',
    category: 'Compensation',
    isDefault: true,
  },
  {
    id: 'salary_range_acceptable',
    question: 'Is the posted salary range acceptable to you?',
    answer: 'Yes',
    category: 'Compensation',
    isDefault: true,
  },

  // ── 4. Experience & Education ──
  {
    id: 'experience_years',
    question: 'Total years of relevant professional experience?',
    answer: '1',
    category: 'Experience & Education',
    isDefault: true,
  },
  {
    id: 'highest_education',
    question: 'What is your highest level of completed education?',
    answer: "Bachelor's Degree",
    category: 'Experience & Education',
    isDefault: true,
  },
  {
    id: 'skill_react_exp',
    question: 'How many years of experience do you have with React / Next.js?',
    answer: '1',
    category: 'Experience & Education',
    isDefault: true,
  },
  {
    id: 'skill_node_exp',
    question: 'How many years of experience do you have with Node.js / TypeScript?',
    answer: '1',
    category: 'Experience & Education',
    isDefault: true,
  },
  {
    id: 'skill_sql_exp',
    question: 'How many years of experience do you have with SQL / Databases?',
    answer: '1',
    category: 'Experience & Education',
    isDefault: true,
  },
  {
    id: 'production_llm_shipped',
    question: 'Have you built and shipped software integrated with LLMs / AI APIs?',
    answer: 'Yes',
    category: 'Experience & Education',
    isDefault: true,
  },

  // ── 5. Availability & Shifts ──
  {
    id: 'notice_period',
    question: 'What is your current notice period / When can you join?',
    answer: 'Immediate',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'start_immediately',
    question: 'Can you start immediately upon hire?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'preferred_shift',
    question: 'What is your preferred shift timing (Day / Night / Rotational)?',
    answer: 'Day / Flexible',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'shift_flexibility',
    question: 'Are you open to working flexible hours, weekends, or on-call if required?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },
  {
    id: 'timezone_overlap',
    question: 'Can you commit to daily overlap with US / client working hours?',
    answer: 'Yes',
    category: 'Availability & Shifts',
    isDefault: true,
  },

  // ── 6. Yes/No Screening ──
  {
    id: 'driver_license',
    question: 'Do you possess a valid driver’s license?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'background_check',
    question: 'Are you comfortable with undergoing a standard background verification check?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'drug_test',
    question: 'Are you willing to undergo a drug screening test if required?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'former_employee',
    question: 'Have you previously worked for or been employed by this company?',
    answer: 'No',
    category: 'Yes/No Screening',
    isDefault: true,
  },
  {
    id: 'currently_employed',
    question: 'Are you currently employed?',
    answer: 'Yes',
    category: 'Yes/No Screening',
    isDefault: true,
  },

  // ── 7. Diversity / Self-Identification ──
  {
    id: 'gender_identity',
    question: 'What is your gender / gender identity?',
    answer: 'Male',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
  {
    id: 'date_of_birth',
    question: 'What is your date of birth?',
    answer: '2000-01-01',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
  {
    id: 'veteran_status',
    question: 'What is your military or veteran status?',
    answer: 'I am not a protected veteran',
    category: 'Diversity / Self-Identification',
    isDefault: true,
  },
  {
    id: 'disability_status',
    question: 'Do you have a physical or mental disability?',
    answer: 'No, I do not have a disability',
    category: 'Diversity / Self-Identification',
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
  hasWorkExperience: true,
  workExperience: [
    {
      id: 'exp-1',
      title: 'Next.js Developer Intern',
      company: 'AI-King Solutions',
      startMonth: 'August',
      startYear: '2024',
      endMonth: null,
      endYear: null,
      isCurrent: true,
      description:
        'Contributing to live client projects built with Next.js, React.js, and TypeScript. Integrating REST APIs with backend services and databases.',
      source: 'manual',
    },
  ],
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
  gender: 'Male',
  dateOfBirth: '2000-01-01',
  highestEducation: "Bachelor's Degree",
  willingToRelocate: 'Yes',
  preferredShift: 'Day / Flexible',
  driverLicense: 'Yes',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
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
        gender: raw.gender !== undefined ? raw.gender : 'Male',
        dateOfBirth: raw.dateOfBirth !== undefined ? raw.dateOfBirth : undefined,
        highestEducation: raw.highestEducation !== undefined ? raw.highestEducation : "Bachelor's Degree",
        willingToRelocate: raw.willingToRelocate !== undefined ? raw.willingToRelocate : 'Yes',
        preferredShift: raw.preferredShift !== undefined ? raw.preferredShift : 'Day / Flexible',
        driverLicense: raw.driverLicense !== undefined ? raw.driverLicense : 'Yes',
        veteranStatus: raw.veteranStatus !== undefined ? raw.veteranStatus : 'I am not a protected veteran',
        disabilityStatus: raw.disabilityStatus !== undefined ? raw.disabilityStatus : 'No, I do not have a disability',
        goldenAnswers:
          Array.isArray(raw.goldenAnswers) && raw.goldenAnswers.length > 0 ? raw.goldenAnswers : DEFAULT_GOLDEN_ANSWERS,
        customAnswers: raw.customAnswers || {},
        skillExperience: raw.skillExperience || {},
        hasWorkExperience: raw.hasWorkExperience !== undefined ? Boolean(raw.hasWorkExperience) : true,
        workExperience: Array.isArray(raw.workExperience) ? raw.workExperience : [],
        resumeText:
          raw.resumeText && raw.resumeText.length >= 20
            ? raw.resumeText
            : raw.resumeFileName
              ? ''
              : DEFAULT_CAREER_BRAIN.resumeText,
      };
      data = merged;
    }

    // Seamless auto-migration: Purge any stale generic work-experience date fields from goldenAnswers
    let purgedStaleGolden = false;
    if (Array.isArray(data.goldenAnswers) && data.goldenAnswers.length > 0) {
      const filtered = data.goldenAnswers.filter(ga => !isGenericWorkExperienceDateField(ga.question));
      if (filtered.length !== data.goldenAnswers.length) {
        data.goldenAnswers = filtered;
        purgedStaleGolden = true;
      }
    }

    // Seamless auto-migration: Sanitize and purge fabricated skillExperience (e.g. uniform "5 years" across 20+ skills)
    let sanitizedSkillExp = false;
    if (data.skillExperience && Object.keys(data.skillExperience).length > 0) {
      const cleaned = sanitizeStoredSkillExperience(
        data.skillExperience,
        data.workExperience,
        data.resumeText,
        data.yearsOfExperience,
      );
      if (
        Object.keys(cleaned).length !== Object.keys(data.skillExperience).length ||
        Object.entries(cleaned).some(([k, v]) => data.skillExperience![k] !== v)
      ) {
        data.skillExperience = cleaned;
        sanitizedSkillExp = true;
      }
    }

    // Seamless auto-migration: Clean any stale "or Remote" suffixes from preferredLocation / currentLocation
    let cleanedLocation = false;
    if (data.preferredLocation && /remote|hybrid/i.test(data.preferredLocation)) {
      const cleaned = cleanLocationForCityField(data.preferredLocation);
      if (cleaned && cleaned !== data.preferredLocation) {
        data.preferredLocation = cleaned;
        cleanedLocation = true;
      }
    }
    if (data.currentLocation && /remote|hybrid/i.test(data.currentLocation)) {
      const cleaned = cleanLocationForCityField(data.currentLocation);
      if (cleaned && cleaned !== data.currentLocation) {
        data.currentLocation = cleaned;
        cleanedLocation = true;
      }
    }

    // Seamless auto-migration: Ensure all default golden answers exist even for existing users
    const existingIds = new Set((data.goldenAnswers || []).map(ga => ga.id));
    const existingQuestions = new Set((data.goldenAnswers || []).map(ga => ga.question.toLowerCase().trim()));
    const missingDefaults = DEFAULT_GOLDEN_ANSWERS.filter(
      d => !existingIds.has(d.id) && !existingQuestions.has(d.question.toLowerCase().trim()),
    );
    if (missingDefaults.length > 0 || purgedStaleGolden || sanitizedSkillExp || cleanedLocation) {
      if (missingDefaults.length > 0) {
        data.goldenAnswers = [...(data.goldenAnswers || []), ...missingDefaults];
      }
      storage
        .set(data)
        .catch(err => console.error('[CareerBrainStorage] Failed to save merged defaults/sanitized data:', err));
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
  saveWorkExperienceItem: (item: Omit<IWorkExperienceItem, 'id'> & { id?: string }) => Promise<void>;
  deleteWorkExperienceItem: (id: string) => Promise<void>;
  setHasWorkExperience: (hasExperience: boolean) => Promise<void>;
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
    // Never persist ambiguous relative work-experience date fields as generic golden answers
    if (isGenericWorkExperienceDateField(question)) {
      return;
    }

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

  async setHasWorkExperience(hasExperience: boolean): Promise<void> {
    await this.updateCareerBrain({ hasWorkExperience: hasExperience });
  },

  async saveWorkExperienceItem(item: Omit<IWorkExperienceItem, 'id'> & { id?: string }): Promise<void> {
    const current = await this.getCareerBrain();
    const currentList = Array.isArray(current.workExperience) ? [...current.workExperience] : [];
    const itemId = item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fullItem: IWorkExperienceItem = {
      id: itemId,
      company: item.company.trim(),
      title: item.title.trim(),
      startMonth: item.startMonth || '',
      startYear: item.startYear || '',
      endMonth: item.isCurrent ? null : item.endMonth || null,
      endYear: item.isCurrent ? null : item.endYear || null,
      isCurrent: Boolean(item.isCurrent),
      description: item.description || '',
      source: item.source || 'manual',
    };

    const existingIndex = currentList.findIndex(e => e.id === itemId);
    if (existingIndex >= 0) {
      currentList[existingIndex] = fullItem;
    } else {
      currentList.push(fullItem);
    }
    await this.updateCareerBrain({ workExperience: currentList, hasWorkExperience: true });
  },

  async deleteWorkExperienceItem(id: string): Promise<void> {
    const current = await this.getCareerBrain();
    const currentList = Array.isArray(current.workExperience) ? [...current.workExperience] : [];
    const updatedList = currentList.filter(e => e.id !== id);
    await this.updateCareerBrain({ workExperience: updatedList });
  },

  async saveData(data: unknown): Promise<SaveCareerBrainResult> {
    return saveCareerBrainData(data);
  },
};

export default careerBrainStore;
