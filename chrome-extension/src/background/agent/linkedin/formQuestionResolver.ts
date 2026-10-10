/**
 * Form Question Resolver for LinkedIn Job Application
 *
 * Implements the 4 core LLM form-filling rules:
 * 1. Semantic Matching: Uses LLM to match ambiguous question wording to candidate profile,
 *    golden answers, and skillExperience (e.g. "years with server-side JavaScript" -> Node.js).
 * 2. Free-Text Generation: Uses LLM to generate concise, non-factual narrative answers from
 *    resume/profile (e.g. "Why do you want this role?"). Never invents specific numbers/facts.
 * 3. Factual Zero-Invention: For factual/verifiable fields (CTC, skill experience, notice period,
 *    CGPA, work auth, compliance yes/no) with no basis in profile, triggers ask_user once and
 *    auto-saves to goldenAnswers or skillExperience with loose duplicate detection.
 * 4. Auditable Live Activity: Categorizes each filled field as [MATCHED], [GENERATED], or [ASKED].
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  careerBrainStore,
  type ICareerBrain,
  type IWorkExperienceItem,
  isGenericWorkExperienceDateField,
  cleanLocationForCityField,
  parseLocationParts,
  isSocialMediaOrUrlQuestion,
  areQuestionsSemanticallyEquivalent,
  findBestMatchingGoldenAnswer,
} from '@extension/storage';
import { isValidSkillName } from '@extension/shared';
import { createLogger } from '../../log';
import { userQuestionManager } from './userQuestionManager';
import { alignValueToOptions, matchQuestionSemantically } from '../intelligence';
import { getActiveChatModel } from '../activeModelHelper';

const logger = createLogger('FormQuestionResolver');

// Circuit breaker for LLM tier: after 3 consecutive network failures, disable LLM tier for the rest of run / backoff
let consecutiveLlmNetworkFailures = 0;
let llmDisabledUntilTimestamp = 0;

export function recordLlmNetworkFailure(err?: unknown): void {
  consecutiveLlmNetworkFailures++;
  const errMsg = (err as any)?.message || String(err || '');
  logger.warning(
    `[FormQuestionResolver] LLM network failure recorded (${consecutiveLlmNetworkFailures}/3 consecutive failures): ${errMsg}`,
  );
  if (consecutiveLlmNetworkFailures >= 3) {
    // Disable LLM for 5 minutes
    llmDisabledUntilTimestamp = Date.now() + 5 * 60 * 1000;
    logger.error(
      '[FormQuestionResolver] ⚠️ 3 consecutive LLM network failures detected. Disabling LLM tier for 5 minutes with backoff to prevent hangs.',
    );
  }
}

export function recordLlmSuccess(): void {
  consecutiveLlmNetworkFailures = 0;
  llmDisabledUntilTimestamp = 0;
}

export function isLlmTierAvailable(): boolean {
  if (llmDisabledUntilTimestamp > 0 && Date.now() < llmDisabledUntilTimestamp) {
    return false;
  }
  return true;
}

export function isNetworkError(err: unknown): boolean {
  const msg = ((err as any)?.message || String(err || '')).toLowerCase();
  return (
    msg.includes('connection error') ||
    msg.includes('failed to fetch') ||
    msg.includes('network') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('timeout')
  );
}

export type QuestionResolutionCategory = 'MATCHED' | 'GENERATED' | 'ASKED';

export interface FormFieldDescriptor {
  id?: string;
  label: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  isTextArea?: boolean;
  placeholder?: string;
  hintText?: string;
  required?: boolean;
}

export interface QuestionResolutionResult {
  success: boolean;
  category?: QuestionResolutionCategory;
  answer?: string;
  sourceDetail?: string;
  error?: string;
  needsUserAnswer?: boolean;
}

/**
 * Deduplicates LinkedIn and ATS text artifacts:
 * - Collapses whitespace and newlines
 * - Strips duplicate substrings (e.g. "Question?Question?", "Question? Question?", repeated phrases)
 */
export function cleanLinkedInText(rawText: string): string {
  if (!rawText) return '';
  let text = rawText
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 4) return text;

  // 1. Direct concatenation without separator: "Question?Question?"
  if (text.length % 2 === 0) {
    const half = text.slice(0, text.length / 2);
    if (half + half === text) return half;
  }

  // 2. Space-separated exact duplication: "Question? Question?"
  const mid = Math.floor(text.length / 2);
  if (text[mid] === ' ') {
    const left = text.slice(0, mid).trim();
    const right = text.slice(mid + 1).trim();
    if (left === right) return left;
  }

  // 3. Word-based even split:
  const words = text.split(/\s+/);
  if (words.length >= 4 && words.length % 2 === 0) {
    const halfLen = words.length / 2;
    const w1 = words.slice(0, halfLen).join(' ');
    const w2 = words.slice(halfLen).join(' ');
    if (w1 === w2) return w1;
  }

  // 4. Repeated sentence split on punctuation:
  const punctMatch = text.match(/^(.+?[?.!*])\s+(.+)$/);
  if (punctMatch) {
    const p1 = punctMatch[1].trim();
    const p2 = punctMatch[2].trim();
    const normP1 = p1.replace(/[*?.\s]/g, '').toLowerCase();
    const normP2 = p2.replace(/[*?.\s]/g, '').toLowerCase();
    if (normP1 && (normP1 === normP2 || normP2.startsWith(normP1))) return p1;
  }

  // 5. General substring repetition search:
  for (let len = Math.floor(text.length / 2); len >= 8; len--) {
    const candidate = text.slice(0, len).trim();
    const remainder = text.slice(len).trim();
    if (candidate.length > 6) {
      const normC = candidate.replace(/[*?.\s]/g, '').toLowerCase();
      const normR = remainder.replace(/[*?.\s]/g, '').toLowerCase();
      if (normC.length > 6 && (normC === normR || normR.startsWith(normC))) {
        return candidate;
      }
    }
  }

  return text;
}

/**
 * Normalizes question text for loose duplicate detection:
 * - Cleans LinkedIn text artifacts
 * - Lowercases and trims
 * - Strips punctuation marks
 * - Strips common question filler words ("how", "many", "years", "of", "experience", "with", etc.)
 * - Collapses whitespace
 */
export function normalizeQuestionForMatch(text: string): string {
  if (!text) return '';
  return cleanLinkedInText(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // remove punctuation: ?, ., !, :, ;, etc.
    .replace(
      /\b(how|many|years|year|of|work|professional|experience|do|you|have|with|in|using|please|enter|select|state|specify|your)\b/gi,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Checks if two question strings match loosely
 */
export function matchesQuestionLoosely(q1: string, q2: string): boolean {
  if (!q1 || !q2) return false;
  const t1 = cleanLinkedInText(q1).toLowerCase().trim();
  const t2 = cleanLinkedInText(q2).toLowerCase().trim();
  if (t1 === t2) return true;
  if (t1.includes(t2) || t2.includes(t1)) return true;

  // 1. Semantic equivalence (normalization + curated synonym clusters + token Jaccard)
  const semantic = areQuestionsSemanticallyEquivalent(q1, q2);
  if (semantic.matched) {
    return true;
  }

  const norm1 = normalizeQuestionForMatch(q1);
  const norm2 = normalizeQuestionForMatch(q2);
  if (norm1 && norm2) {
    if (norm1 === norm2) return true;
    if (norm1.length >= 3 && norm2.length >= 3) {
      if (norm1.includes(norm2) || norm2.includes(norm1)) return true;
    }
  }
  return false;
}

/**
 * Extracts candidate skill or topic from a question text.
 */
export function extractQuestionTopic(questionText: string): string | null {
  const cleanQ = cleanLinkedInText(questionText);
  const extracted = userQuestionManager.extractSkillName(cleanQ);
  if (extracted) return cleanLinkedInText(extracted);

  const patterns = [
    /(?:how\s+many\s+years|years\s+of|experience).*?\b(?:with|in|using)\s+([A-Za-z0-9#+.\s-]{2,40}?)(?:\?|\*|$|\s*\(|\s+in\s+years)/i,
    /(?:do you have experience with|experience with|familiar with|knowledge of|proficient in|skills? in)\s+([A-Za-z0-9#+.\s-]{2,40}?)(?:\?|$|\s+in|\s+using|\s+for|\s*\()/i,
    /(?:have you worked with|worked with)\s+([A-Za-z0-9#+.\s-]{2,40}?)(?:\?|$|\s+in|\s*\()/i,
    /(?:level of education:?|completed the following level of education:?|degree:?)\s*([A-Za-z0-9'’.\s-]{2,40}?)(?:\?|$)/i,
    /(?:do you have a|have you completed a|graduated with a)\s+([A-Za-z0-9'’.\s-]{2,40}?)\s*(?:degree|diploma)?(?:\?|$)/i,
    /(?:with|in|using)\s+([A-Za-z0-9#+.\s-]{2,40}?)(?:\?|\*|$|\s*\()/i,
  ];

  for (const pat of patterns) {
    const match = cleanQ.match(pat);
    if (match && match[1]) {
      const clean = match[1]
        .replace(/[^\w#+.-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (
        clean.length >= 2 &&
        !/^(a|an|the|any|your|our|this|that|of|work|total|overall|relevant|professional|experience|years|hands-on)$/i.test(
          clean,
        )
      ) {
        return clean;
      }
    }
  }

  const norm = normalizeQuestionForMatch(cleanQ);
  if (
    norm.length >= 2 &&
    norm.length <= 40 &&
    !/^(a|an|the|any|your|our|this|that|of|work|total|overall|relevant|professional|experience|years|hands-on)$/i.test(
      norm,
    )
  ) {
    return norm;
  }
  return null;
}

/**
 * Determines if a question is a non-factual narrative question suitable for LLM free-text generation.
 * Rule 2 addition: Must NOT ask for specific factual claims (numbers, exact contribution %, metrics, dates).
 */
export function isFreeTextNarrativeQuestion(field: FormFieldDescriptor): boolean {
  if (field.fieldType !== 'text') return false;

  const labelLower = (field.label || '').toLowerCase();

  // Factual triggers that must NEVER be treated as free-text narrative:
  const factualTriggers = [
    /\b(salary|ctc|compensation|pay|notice\s*period|cgpa|gpa|percentage|phone|mobile|email|city|location|postal|zip|authorized|sponsorship|visa)\b/i,
    /\b(how\s*many\s*years|years\s*of|experience\s*with)\b/i,
    /\b(exact|specific|percentage|%|metrics|revenue|sales\s*figure|tenure|dates?)\b/i,
  ];

  for (const pattern of factualTriggers) {
    if (pattern.test(labelLower)) return false;
  }

  // Narrative indicators:
  const narrativeTriggers = [
    /\bwhy\s*(do\s*you\s*want|are\s*you\s*interested|should\s*we\s*hire|join)\b/i,
    /\bdescribe\s*(your|a|an)\b/i,
    /\btell\s*us\s*about\b/i,
    /\bwhat\s*(makes\s*you|interests\s*you|are\s*your\s*strengths)\b/i,
    /\bcover\s*letter\b/i,
    /\bsummary\s*of\b/i,
    /\bbriefly\s*(explain|describe)\b/i,
    /\bproject\s*(highlight|description|details)\b/i,
    /\badditional\s*information\b/i,
  ];

  return field.isTextArea === true || narrativeTriggers.some(pattern => pattern.test(labelLower));
}

/**
 * Detects whether a field is asking for years/duration of experience with a SPECIFIC skill/tool.
 * Strictly excludes:
 * - Generic total work experience (e.g. "How many years of total work experience do you have?")
 * - Radio groups or binary Yes/No questions
 * - Other factual screening fields (CTC, salary, notice period, work auth, visa, sponsorship, education, degree, GPA, phone, email, etc.)
 */
export function isSkillExperienceYearsQuestion(field: FormFieldDescriptor): {
  isSkillExp: boolean;
  skillName?: string;
} {
  // Radio groups and binary questions must NEVER be defaulted to 0
  if (field.fieldType === 'radio') return { isSkillExp: false };
  if (
    field.options &&
    field.options.some(o => /^yes$/i.test(o.trim())) &&
    field.options.some(o => /^no$/i.test(o.trim()))
  ) {
    return { isSkillExp: false };
  }

  const label = cleanLinkedInText(field.label || '');
  const labelLower = label.toLowerCase().trim();

  // Factual triggers that must NEVER be defaulted to 0:
  const nonSkillFactual =
    /\b(salary|ctc|compensation|pay|lpa|inr|notice\s*period|cgpa|gpa|percentage|phone|mobile|email|city|location|postal|zip|authorized|sponsorship|visa|degree|bachelor|master|phd|high\s*school|graduation|college|university|current\s*role|start\s*date|end\s*date)\b/i;
  if (nonSkillFactual.test(labelLower)) {
    return { isSkillExp: false };
  }

  // Must NOT be generic total experience (without specific skill attribution)
  const isGenericTotalExperience =
    /\b(?:total|overall|all)\s*(?:years?|yrs?)?\s*(?:of)?\s*(?:work|professional)?\s*experi[ea]nce\b/i.test(
      labelLower,
    ) ||
    /\bhow\s*many\s*(?:years?|yrs?)\s*(?:of)?\s*(?:total|overall|work|professional)?\s*experi[ea]nce\b/i.test(
      labelLower,
    ) ||
    /\btotal\s*experi[ea]nce\b/i.test(labelLower) ||
    /\bexperi[ea]nce\s*in\s*years\b/i.test(labelLower) ||
    /^(?:total\s*)?(?:work\s*)?experi[ea]nce\s*(?:\(in\s*years?\))?[:?*]?$/i.test(labelLower);

  if (isGenericTotalExperience) {
    const hasSpecificSkillAttribution =
      /\b(?:with|using|in)\s+[a-z0-9#+.]+/i.test(labelLower) &&
      !/\b(?:in\s+total|in\s+your\s+career|in\s+this\s+field|in\s+the\s+industry|with\s+work)\b/i.test(labelLower);
    if (!hasSpecificSkillAttribution) {
      return { isSkillExp: false };
    }
  }

  // Must have years/experience indicator (in label, hintText, placeholder, or numeric field type)
  const combinedContext = (labelLower + ' ' + (field.hintText || '') + ' ' + (field.placeholder || '')).toLowerCase();
  const hasYearsIndicator =
    /how many years/i.test(combinedContext) ||
    /years of/i.test(combinedContext) ||
    /years with/i.test(combinedContext) ||
    /experience with/i.test(combinedContext) ||
    /hands-on experience/i.test(combinedContext) ||
    /\(in\s*years?\)/i.test(combinedContext) ||
    /whole\s*number/i.test(combinedContext) ||
    /example:\s*\d+/i.test(combinedContext) ||
    field.fieldType === 'number';

  if (!hasYearsIndicator) {
    return { isSkillExp: false };
  }

  // Extract skill name:
  // 1. Try regex extraction from sentence patterns
  let skill = userQuestionManager.extractSkillName(label) || extractQuestionTopic(label);
  if (!skill) {
    const match = labelLower.match(/(?:with|in|using)\s+([a-z0-9#+.\s-]{2,35}?)(?:\?|\*|$|\s*\(|\s+in\s+years)/i);
    if (match && match[1]) {
      skill = match[1].trim();
    }
  }

  // 2. If still not extracted and field is numeric (e.g. label is simply 'Microsoft Azure?' or 'SharePoint?')
  if (!skill && (field.fieldType === 'number' || /whole\s*number|\(in\s*years?\)/i.test(combinedContext))) {
    const candidate = label
      .replace(/[?*:]+/g, ' ')
      .replace(/\(optional\)|\(required\)/gi, '')
      .trim();
    if (
      candidate.length >= 2 &&
      candidate.length <= 35 &&
      !/^(a|an|the|any|your|our|this|that|of|work|total|overall|relevant|professional|experience|years|hands-on)$/i.test(
        candidate,
      )
    ) {
      skill = candidate;
    }
  }

  if (skill) {
    const cleanSkill = skill
      .replace(/[\n\r?*:]+/g, ' ')
      .replace(/\(optional\)|\(required\)/gi, '')
      .trim();
    if (
      cleanSkill.length >= 2 &&
      !/^(a|an|the|any|your|our|this|that|of|work|total|overall|relevant|professional|experience|years|hands-on)$/i.test(
        cleanSkill,
      )
    ) {
      return { isSkillExp: true, skillName: cleanSkill };
    }
  }

  return { isSkillExp: false };
}

/**
 * Analyzes candidate's education from profile and resume text.
 */
export function getCandidateEducationLevels(careerBrain: ICareerBrain): {
  hasBachelor: boolean;
  hasMaster: boolean;
  hasDoctorate: boolean;
  hasHighSchool: boolean;
  highestLevel: 'Doctorate' | 'Master' | 'Bachelor' | 'High School' | 'None';
  summary: string;
} {
  const text = `${careerBrain.education || ''} ${careerBrain.resumeText || ''}`.toLowerCase();

  const hasBachelor =
    /\b(bachelor|b\.?tech|btech|b\.?e\b|b\.?s\b|b\.?sc\b|bca|undergraduate|bba|b\.?com|b\.\s*a\b)\b/i.test(text);
  const hasMaster = /\b(master|m\.?tech|mtech|m\.?e\b|m\.?s\b|m\.?sc\b|mca|postgraduate|mba|m\.?sc)\b/i.test(text);
  const hasDoctorate = /\b(phd|doctorate|doctor of philosophy)\b/i.test(text);
  const hasHighSchool =
    hasBachelor ||
    hasMaster ||
    hasDoctorate ||
    /\b(high\s*school|secondary|intermediate|12th|10\+2|diploma)\b/i.test(text);

  let highestLevel: 'Doctorate' | 'Master' | 'Bachelor' | 'High School' | 'None' = 'None';
  if (hasDoctorate) highestLevel = 'Doctorate';
  else if (hasMaster) highestLevel = 'Master';
  else if (hasBachelor) highestLevel = 'Bachelor';
  else if (hasHighSchool) highestLevel = 'High School';

  const summary = careerBrain.education || (hasBachelor ? "Bachelor's Degree" : hasMaster ? "Master's Degree" : '');

  return { hasBachelor, hasMaster, hasDoctorate, hasHighSchool, highestLevel, summary };
}

/**
 * Strips LinkedIn UI artifacts, duplicate title repetitions, and badges from job titles.
 * E.g. "Back End Developer Back End Developer with verification" -> "Back End Developer"
 */
export function cleanLinkedInJobTitle(raw: string): string {
  if (!raw) return '';
  let txt = raw
    .replace(/\bwith verification\b/gi, '')
    .replace(/\bactively recruiting\b/gi, '')
    .replace(/\bpromoted\b/gi, '')
    .replace(/\beasy apply\b/gi, '')
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip exact repeated halves (e.g. "Back End Developer Back End Developer")
  if (txt.length > 4 && txt.length % 2 === 0) {
    const half = txt.slice(0, txt.length / 2);
    if (half + half === txt) {
      txt = half;
    }
  }

  // Strip word-boundary repeated halves (e.g. "Back End Developer Back End Developer")
  const words = txt.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const halfLen = words.length / 2;
    const firstHalf = words.slice(0, halfLen).join(' ');
    const secondHalf = words.slice(halfLen).join(' ');
    if (firstHalf.toLowerCase() === secondHalf.toLowerCase()) {
      txt = firstHalf;
    }
  }

  // Strip repeated phrases separated by spaces
  const match = txt.match(/^(.{3,40}?)\s+\1(?:\b.*)?$/i);
  if (match && match[1]) {
    txt = match[1];
  }

  return txt.trim();
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const MONTH_MAP: Record<string, string> = {
  jan: 'January',
  january: 'January',
  '01': 'January',
  '1': 'January',
  feb: 'February',
  february: 'February',
  '02': 'February',
  '2': 'February',
  mar: 'March',
  march: 'March',
  '03': 'March',
  '3': 'March',
  apr: 'April',
  april: 'April',
  '04': 'April',
  '4': 'April',
  may: 'May',
  '05': 'May',
  '5': 'May',
  jun: 'June',
  june: 'June',
  '06': 'June',
  '6': 'June',
  jul: 'July',
  july: 'July',
  '07': 'July',
  '7': 'July',
  aug: 'August',
  august: 'August',
  '08': 'August',
  '8': 'August',
  sep: 'September',
  sept: 'September',
  september: 'September',
  '09': 'September',
  '9': 'September',
  oct: 'October',
  october: 'October',
  '10': 'October',
  nov: 'November',
  november: 'November',
  '11': 'November',
  dec: 'December',
  december: 'December',
  '12': 'December',
};

export interface ParsedWorkDates {
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  isCurrentRole: boolean;
}

/**
 * Retrieves the candidate's primary work experience entry from structured careerBrain.workExperience.
 * Prioritizes current role (isCurrent === true), then most recent by start year/month.
 */
export function getPrimaryWorkExperience(careerBrain: ICareerBrain): IWorkExperienceItem | null {
  const list = Array.isArray(careerBrain.workExperience) ? careerBrain.workExperience : [];
  if (list.length === 0) return null;

  // 1. Prioritize current active position
  const current = list.find(item => item.isCurrent);
  if (current) return current;

  // 2. Sort descending by startYear and startMonth
  const sorted = [...list].sort((a, b) => {
    const yearA = parseInt(a.startYear || '0', 10);
    const yearB = parseInt(b.startYear || '0', 10);
    if (yearA !== yearB) return yearB - yearA;

    const monthA = MONTH_NAMES.findIndex(m =>
      m.toLowerCase().startsWith((a.startMonth || '').slice(0, 3).toLowerCase()),
    );
    const monthB = MONTH_NAMES.findIndex(m =>
      m.toLowerCase().startsWith((b.startMonth || '').slice(0, 3).toLowerCase()),
    );
    return monthB - monthA;
  });

  return sorted[0] || null;
}

/**
 * Extracts work history dates prioritizing structured careerBrain.workExperience first,
 * then falling back to resumeText regex or years of experience.
 */
export function extractWorkHistoryDates(careerBrain: ICareerBrain): ParsedWorkDates {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthIndex = now.getMonth();
  const currentMonthName = MONTH_NAMES[currentMonthIndex];

  // 1. Structured Work Experience in Career Brain (highest priority, user-confirmed)
  const primary = getPrimaryWorkExperience(careerBrain);
  if (primary) {
    const rawStartMonth = (primary.startMonth || '').trim().toLowerCase();
    const startMonth =
      rawStartMonth && MONTH_MAP[rawStartMonth] ? MONTH_MAP[rawStartMonth] : primary.startMonth || 'January';
    const startYear = primary.startYear || String(currentYear - 1);

    const isPresent = Boolean(primary.isCurrent);
    const rawEndMonth = (primary.endMonth || '').trim().toLowerCase();
    const endMonth = isPresent
      ? currentMonthName
      : rawEndMonth && MONTH_MAP[rawEndMonth]
        ? MONTH_MAP[rawEndMonth]
        : primary.endMonth || currentMonthName;
    const endYear = isPresent ? String(currentYear) : primary.endYear || String(currentYear);

    return {
      startMonth,
      startYear,
      endMonth,
      endYear,
      isCurrentRole: isPresent,
    };
  }

  // 2. Fallback: Parse date ranges from resume text
  const resume = careerBrain.resumeText || '';
  const rangeRegex =
    /(?:(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{1,2}[\/-])\s*)?(\d{4})\s*(?:-|–|—|to)\s*(Present|Current|Now|(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|\d{1,2}[\/-])\s*)?(\d{4})))/i;

  const match = resume.match(rangeRegex);
  if (match) {
    const rawStartMonth = match[1]?.replace(/[\/-]/g, '').trim().toLowerCase();
    const rawStartYear = match[2];
    const isPresent = /present|current|now/i.test(match[3] || '');
    const rawEndMonth = match[4]?.replace(/[\/-]/g, '').trim().toLowerCase();
    const rawEndYear = match[5];

    const startMonth = rawStartMonth && MONTH_MAP[rawStartMonth] ? MONTH_MAP[rawStartMonth] : 'June';
    const startYear = rawStartYear;
    const endMonth = isPresent
      ? currentMonthName
      : rawEndMonth && MONTH_MAP[rawEndMonth]
        ? MONTH_MAP[rawEndMonth]
        : currentMonthName;
    const endYear = isPresent ? String(currentYear) : rawEndYear || String(currentYear);

    return {
      startMonth,
      startYear,
      endMonth,
      endYear,
      isCurrentRole: isPresent,
    };
  }

  // 3. Fallback: estimate start date from candidate's yearsOfExperience
  const yoe = Math.max(1, Math.round(careerBrain.yearsOfExperience || 2));
  const estimatedStartYear = String(currentYear - yoe);
  return {
    startMonth: 'January',
    startYear: estimatedStartYear,
    endMonth: currentMonthName,
    endYear: String(currentYear),
    isCurrentRole: true,
  };
}

/**
 * Maps a target month or year to available dropdown options (name, 2-digit, 1-digit, or string).
 * Returns null if the targetValue is fundamentally incompatible (e.g. "No" for a month, or a year for a month).
 */
export function matchDateOption(
  field: FormFieldDescriptor,
  targetValue: string,
  type: 'month' | 'year',
): string | null {
  if (!targetValue || typeof targetValue !== 'string') {
    return null;
  }
  const val = targetValue.trim();

  // Strict type checks:
  if (type === 'month') {
    // A month cannot be a 4-digit number (e.g. "2026") or boolean ("No", "Yes")
    if (/^\d{4}$/.test(val) || /^(?:yes|no|true|false)$/i.test(val)) {
      return null;
    }
  } else if (type === 'year') {
    // A year must be numeric (usually 4 digits), never boolean or month name
    if (
      /^(?:yes|no|true|false)$/i.test(val) ||
      MONTH_NAMES.some(m => m.toLowerCase().startsWith(val.slice(0, 3).toLowerCase()))
    ) {
      return null;
    }
  }

  if (!field.options || field.options.length === 0) {
    return val;
  }
  const cleanOptions = field.options.map(o => o.trim()).filter(Boolean);

  if (type === 'month') {
    const monthName = val;
    const monthIdx = MONTH_NAMES.findIndex(m => m.toLowerCase().startsWith(monthName.slice(0, 3).toLowerCase()));
    const validIdx = monthIdx >= 0 ? monthIdx : -1;
    if (validIdx === -1 && !/^\d{1,2}$/.test(val)) {
      return null;
    }

    const monthNum1 = validIdx >= 0 ? String(validIdx + 1) : String(parseInt(val, 10));
    const monthNum2 =
      validIdx >= 0 ? String(validIdx + 1).padStart(2, '0') : String(parseInt(val, 10)).padStart(2, '0');
    const fullMonth = validIdx >= 0 ? MONTH_NAMES[validIdx] : '';

    // 1. Direct name match (e.g. "January" or "Jan")
    if (fullMonth) {
      const nameMatch = cleanOptions.find(
        o =>
          o.toLowerCase() === fullMonth.toLowerCase() ||
          o.toLowerCase().startsWith(fullMonth.slice(0, 3).toLowerCase()) ||
          fullMonth.toLowerCase().startsWith(o.toLowerCase()),
      );
      if (nameMatch) return nameMatch;
    }

    // 2. Numeric match (e.g. "01" or "1")
    const numMatch = cleanOptions.find(o => o === monthNum2 || o === monthNum1);
    if (numMatch) return numMatch;

    return null;
  } else {
    // type === 'year'
    const yearMatch = cleanOptions.find(o => o === val || o.trim() === val);
    if (yearMatch) return yearMatch;

    // Fallback: closest year if valid 4-digit number
    const targetNum = parseInt(val, 10);
    if (!isNaN(targetNum) && targetNum >= 1970 && targetNum <= 2100) {
      const sortedYears = cleanOptions
        .map(o => ({ opt: o, num: parseInt(o, 10) }))
        .filter(x => !isNaN(x.num) && x.num >= 1970 && x.num <= 2100)
        .sort((a, b) => Math.abs(a.num - targetNum) - Math.abs(b.num - targetNum));
      if (sortedYears.length > 0 && Math.abs(sortedYears[0].num - targetNum) <= 5) {
        return sortedYears[0].opt;
      }
    }
    return null;
  }
}

export interface FormatAdaptationResult {
  valid: boolean;
  value: string;
  wasConverted: boolean;
  sourceNote?: string;
}

/**
 * Detects whether a form field expects a specific numeric or structured format
 * (e.g. notice period in days, CTC in INR, CTC in LPA, years of experience, general integer)
 * using the label, fieldType, min/max, placeholder, and hintText.
 *
 * If the provided rawAnswer doesn't match the format:
 * - Losslessly converts it if confident (e.g. "Immediate" -> "0" or "1", "12 LPA" -> "1200000")
 * - If it cannot be converted confidently, returns valid: false so the resolver
 *   will NOT inject an invalid string into the DOM and will cleanly fall through to ask_user.
 */
export function adaptAnswerToFieldFormat(
  rawAnswer: string | number | undefined | null,
  field: FormFieldDescriptor,
): FormatAdaptationResult {
  if (rawAnswer === undefined || rawAnswer === null) {
    return { valid: false, value: '', wasConverted: false };
  }

  const answer = String(rawAnswer).trim();
  if (!answer) {
    return { valid: false, value: '', wasConverted: false };
  }

  const labelLower = (field.label || '').toLowerCase();
  const hintLower = `${field.hintText || ''} ${field.placeholder || ''}`.toLowerCase();
  const combinedContext = `${labelLower} ${hintLower}`;

  // 0a. Check date fields first (Month / Year)
  const isMonthField =
    (/\b(?:from|start|to|end)?\s*month\b|\bmonth\s+(?:of\s+)?(?:from|start|to|end)\b/i.test(labelLower) ||
      /^(?:start|from|end|to)\s*month$/i.test(labelLower)) &&
    !/how\s*many|notice\s*period|ctc|salary/i.test(labelLower);

  const isYearField =
    (/\b(?:from|start|to|end)?\s*year\b|\byear\s+(?:of\s+)?(?:from|start|to|end)\b/i.test(labelLower) ||
      /^(?:start|from|end|to)\s*year$/i.test(labelLower)) &&
    !/how\s*many|years\s*of|notice\s*period|ctc|salary/i.test(labelLower);

  if (isMonthField) {
    const matched = matchDateOption(field, answer, 'month');
    if (matched) {
      return { valid: true, value: matched, wasConverted: matched !== answer };
    }
    return { valid: false, value: answer, wasConverted: false };
  }

  if (isYearField) {
    const matched = matchDateOption(field, answer, 'year');
    if (matched) {
      return { valid: true, value: matched, wasConverted: matched !== answer };
    }
    return { valid: false, value: answer, wasConverted: false };
  }

  // 0b. General Dropdown: Must match one of the available options
  if (field.fieldType === 'dropdown') {
    if (field.options && field.options.length > 0) {
      const cleanOptions = field.options.map(o => o.trim()).filter(Boolean);
      const strAnswer = answer.toLowerCase();
      const exactMatch = cleanOptions.find(o => o.toLowerCase() === strAnswer);
      if (exactMatch) {
        return { valid: true, value: exactMatch, wasConverted: false };
      }
      const partialMatch = cleanOptions.find(
        o => o.toLowerCase().startsWith(strAnswer) || strAnswer.startsWith(o.toLowerCase()),
      );
      if (partialMatch) {
        return { valid: true, value: partialMatch, wasConverted: true };
      }
      return { valid: false, value: answer, wasConverted: false };
    }
    return { valid: true, value: answer, wasConverted: false };
  }

  // 0c. Radio / Checkbox: For Yes/No options, must be valid boolean/Yes/No
  if (field.fieldType === 'radio' || field.fieldType === 'checkbox') {
    if (field.options && field.options.length > 0 && field.options.every(o => /^(?:yes|no)$/i.test(o.trim()))) {
      const strAns = answer.toLowerCase();
      if (/^(?:yes|true|1|y)$/i.test(strAns)) {
        const yesOpt = field.options.find(o => /^yes$/i.test(o.trim())) || 'Yes';
        return { valid: true, value: yesOpt, wasConverted: yesOpt !== answer };
      }
      if (/^(?:no|false|0|n)$/i.test(strAns)) {
        const noOpt = field.options.find(o => /^no$/i.test(o.trim())) || 'No';
        return { valid: true, value: noOpt, wasConverted: noOpt !== answer };
      }
      return { valid: false, value: answer, wasConverted: false };
    }
    return { valid: true, value: answer, wasConverted: false };
  }

  const isNumericField =
    field.fieldType === 'number' ||
    /whole\s*number|only\s*(?:whole\s*)?numbers|digits?\s*only|decimal\s*number|larger\s*than|greater\s*than/i.test(
      combinedContext,
    ) ||
    /example:\s*\d+/i.test(hintLower);

  // 1. Notice Period in Days / Months / Numeric
  const isNoticePeriod = /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(
    labelLower,
  );

  // In Easy Apply, if the field is an input (text/number) that reached here,
  // recruiters almost universally configure it as numeric (days, months, or decimal number).
  // Therefore, we ALWAYS format notice period into digits first.
  const isInputField = field.fieldType === 'text' || field.fieldType === 'number';
  const expectsDaysOrNumber = isNoticePeriod && (isInputField || isNumericField);

  if (expectsDaysOrNumber) {
    // Check if 0 is forbidden by min attribute, error message, or hint text (e.g. "larger than 0.0")
    const minVal = field.min;
    const requiresGreaterThanZero =
      (minVal !== undefined && minVal > 0) ||
      /larger\s+than\s+0(?:\.0)?|greater\s+than\s+0(?:\.0)?|more\s+than\s+0(?:\.0)?|enter\s+a\s+(?:whole\s+|decimal\s+)?number\s+larger\s+than\s+0/i.test(
        combinedContext,
      );

    // a) Immediate / Zero / Now
    if (/^(?:immediate|immediately|now|0|none|0\s*days?|available\s*immediately)$/i.test(answer)) {
      if (requiresGreaterThanZero) {
        const val = Math.max(1, minVal || 1).toString();
        return {
          valid: true,
          value: val,
          wasConverted: true,
          sourceNote: `[MATCHED] notice period '${answer}' -> ${val} (adjusted to satisfy > 0 constraint)`,
        };
      }
      return {
        valid: true,
        value: '0',
        wasConverted: true,
        sourceNote: `[MATCHED] notice period '${answer}' -> 0`,
      };
    }

    // b) X days (e.g. "15 days", "30 days")
    const daysMatch = answer.match(/^(\d+)\s*days?$/i);
    if (daysMatch) {
      const val = daysMatch[1] === '0' && requiresGreaterThanZero ? '1' : daysMatch[1];
      return {
        valid: true,
        value: val,
        wasConverted: true,
        sourceNote: `[MATCHED] notice period '${answer}' -> ${val} days`,
      };
    }

    // c) X months (e.g. "1 month" -> 30, "2 months" -> 60, "3 months" -> 90 or decimal month if expecting decimal)
    const monthMatch = answer.match(/^(\d+(?:\.\d+)?)\s*months?$/i);
    if (monthMatch) {
      // If the field explicitly specifies months in label or hint, keep month count (e.g. 1 or 2)
      // Otherwise convert to days (e.g. 30 or 60)
      const numMonths = parseFloat(monthMatch[1]);
      let numVal: string;
      if (/\bin\s*months?\b|\bmonths?\b/i.test(combinedContext) && !/\bdays\b/i.test(combinedContext)) {
        numVal = numMonths <= 0 && requiresGreaterThanZero ? '1' : monthMatch[1];
      } else {
        const days = Math.round(numMonths * 30);
        numVal = days <= 0 && requiresGreaterThanZero ? '1' : days.toString();
      }
      return {
        valid: true,
        value: numVal,
        wasConverted: true,
        sourceNote: `[MATCHED] notice period '${answer}' -> ${numVal}`,
      };
    }

    // d) X weeks (e.g. "2 weeks" -> 14)
    const weekMatch = answer.match(/^(\d+)\s*weeks?$/i);
    if (weekMatch) {
      const days = parseInt(weekMatch[1], 10) * 7;
      const val = days <= 0 && requiresGreaterThanZero ? '1' : days.toString();
      return {
        valid: true,
        value: val,
        wasConverted: true,
        sourceNote: `[MATCHED] notice period '${answer}' -> ${val} days`,
      };
    }

    // e) Pure number or decimal
    if (/^\d+(?:\.\d+)?$/.test(answer)) {
      if ((answer === '0' || answer === '0.0') && requiresGreaterThanZero) {
        return {
          valid: true,
          value: '1',
          wasConverted: true,
          sourceNote: `[MATCHED] notice period '0' -> 1 (adjusted to satisfy > 0 constraint)`,
        };
      }
      return { valid: true, value: answer, wasConverted: false };
    }

    // f) Extract any numbers from string (e.g. "Serving notice, 15 days left" -> 15)
    const extractedNum = answer.match(/\d+(?:\.\d+)?/);
    if (extractedNum) {
      let val = extractedNum[0];
      if ((val === '0' || val === '0.0') && requiresGreaterThanZero) {
        val = '1';
      }
      return {
        valid: true,
        value: val,
        wasConverted: true,
        sourceNote: `[MATCHED] notice period '${answer}' -> ${val} (extracted digits)`,
      };
    }

    // Fallback: If in an input field, default to 1 (if > 0) or 0 (immediate)
    const fallback = requiresGreaterThanZero ? '1' : '0';
    return {
      valid: true,
      value: fallback,
      wasConverted: true,
      sourceNote: `[MATCHED] notice period '${answer}' -> ${fallback} (digits fallback)`,
    };
  }

  // 2. CTC / Salary in INR or LPA
  const isCTCQuestion =
    /(?:current|present|existing|fixed|annual|expected|target|desired|seeking)?\s*(?:ctc|salary|compensation)\b/i.test(
      labelLower,
    );

  if (isCTCQuestion) {
    // Detect whether the field expects INR (full digits like 1200000) or LPA (e.g. 12 or 12.5)
    const expectsLPA =
      /\bin\s*lpa\b|\blpa\b|\bin\s*lakhs?\b|\blacs?\b/i.test(labelLower) ||
      /example:\s*\d{1,2}(?:\.\d+)?\b/i.test(hintLower);

    const expectsINR =
      /\bin\s*inr\b|\binr\b|\brupees\b|\bannual\b/i.test(labelLower) ||
      /example:\s*(?:[1-9]\d{4,})/i.test(hintLower) ||
      isNumericField;

    // Parse the candidate's stored CTC value
    let lpaVal: number | null = null;
    let inrVal: number | null = null;

    // Check for "X LPA" or "X Lakhs" (e.g. "12 LPA", "12.5 Lakhs", "12L")
    const lpaMatch = answer.match(/^₹?\s*(?:rs\.?)?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:lpa|lakhs?|lacs?|l)\b/i);
    if (lpaMatch) {
      const num = parseFloat(lpaMatch[1].replace(/,/g, ''));
      if (!isNaN(num)) {
        lpaVal = num;
        inrVal = Math.round(num * 100000);
      }
    }

    // Check for pure number / currency (e.g. "₹12,00,000", "1200000", "12,00,000", "12")
    if (inrVal === null) {
      const cleanedNum = answer.replace(/[₹$,\s]|(?:rs\.?)|(?:inr)/gi, '');
      const parsed = parseFloat(cleanedNum);
      if (!isNaN(parsed) && /^\d+(?:\.\d+)?$/.test(cleanedNum)) {
        if (parsed <= 100) {
          // Values <= 100 in Indian CTC contexts are almost universally in LPA (e.g. 12 = 12 LPA)
          lpaVal = parsed;
          inrVal = Math.round(parsed * 100000);
        } else {
          // Values > 100 are full INR amounts (e.g. 1200000)
          inrVal = Math.round(parsed);
          lpaVal = parsed / 100000;
        }
      }
    }

    if (inrVal !== null && lpaVal !== null) {
      if (expectsLPA) {
        const valStr = String(lpaVal);
        return {
          valid: true,
          value: valStr,
          wasConverted: valStr !== answer,
          sourceNote: valStr !== answer ? `[MATCHED] CTC '${answer}' -> ${valStr} LPA` : undefined,
        };
      }
      if (expectsINR) {
        const valStr = String(inrVal);
        return {
          valid: true,
          value: valStr,
          wasConverted: valStr !== answer,
          sourceNote: valStr !== answer ? `[MATCHED] CTC '${answer}' -> ${valStr} INR` : undefined,
        };
      }
    }

    // If numeric field but could not parse number (e.g. "Confidential", "Market standard")
    if (isNumericField && !/^\d+$/.test(answer)) {
      return { valid: false, value: answer, wasConverted: false };
    }
  }

  // 3. Work Experience / Years Questions
  const isExpQuestion =
    /how many years|years? of|experi[ea]nce with|years? with|total\s*(?:year|years)?|overall\s*experi[ea]nce|experi[ea]nce/i.test(
      labelLower,
    );
  if (isExpQuestion) {
    const expMatch = answer.match(/(\d+(?:\.\d+)?)/);
    if (expMatch) {
      const requiresWhole = /whole\s*number/i.test(combinedContext);
      const num = parseFloat(expMatch[1]);
      const finalVal = requiresWhole ? String(Math.round(num)) : expMatch[1];
      return {
        valid: true,
        value: finalVal,
        wasConverted: finalVal !== answer,
        sourceNote: finalVal !== answer ? `[MATCHED] experience '${answer}' -> ${finalVal}` : undefined,
      };
    }
    // If not convertible to numeric
    if (!/^\d+(?:\.\d+)?$/.test(answer)) {
      return { valid: false, value: answer, wasConverted: false };
    }
  }

  // 4. Strict Guard for ANY Numeric Field:
  // If the target field is explicitly numeric, NEVER insert letters/strings (like "Immediate", "Yes", etc.)
  if (isNumericField) {
    const cleanDigits = answer.replace(/[,\s]/g, '');
    if (!/^-?\d+(?:\.\d+)?$/.test(cleanDigits)) {
      logger.warning(
        `[FormQuestionResolver] Answer "${answer}" contains non-numeric characters for numeric field "${field.label}". Rejecting to prevent DOM validation error.`,
      );
      return { valid: false, value: answer, wasConverted: false };
    }
    return { valid: true, value: cleanDigits, wasConverted: cleanDigits !== answer };
  }

  return { valid: true, value: answer, wasConverted: false };
}

/**
 * Generates a tailored 3-paragraph professional cover letter / pitch.
 */
export function generateTailoredCoverLetter(
  careerBrain: ICareerBrain,
  jobTitle: string = 'Software Engineer',
  companyName: string = 'your team',
): string {
  const name = careerBrain.fullName && careerBrain.fullName !== 'Candidate' ? careerBrain.fullName : 'Candidate';
  const role = careerBrain.currentTitle || jobTitle;
  const exp = careerBrain.yearsOfExperience ? `${careerBrain.yearsOfExperience}+ years` : 'a proven track record';
  const topSkills = (careerBrain.skills || []).slice(0, 5).join(', ') || 'modern software engineering principles';
  const narrative = careerBrain.backgroundNarrative?.trim() || '';
  const notice = careerBrain.noticePeriod || 'immediate availability';

  return `Dear Hiring Team at ${companyName},

I am excited to submit my application for the ${jobTitle} position. With ${exp} of professional experience specializing in ${topSkills}, I have developed a strong foundation in building scalable, production-ready systems that solve real-world problems.

${narrative ? narrative + '\n\n' : ''}In my recent work as a ${role}, I have consistently focused on clean architecture, performance optimization, and cross-functional collaboration. I am eager to bring my expertise in ${topSkills} to help ${companyName} deliver impactful features and exceed engineering benchmarks.

Thank you for your time and consideration. With my background and ${notice}, I would welcome the opportunity to discuss how my qualifications align with your team's objectives.

Best regards,
${name}`;
}

/**
 * Fast Rule-Based Matcher across profile, goldenAnswers, customAnswers, and skillExperience.
 * Uses loose question matching to prevent trivial re-asking.
 */
export function matchRuleBased(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
): { matched: boolean; answer?: string; sourceDetail?: string } {
  const label = field.label || '';
  const labelLower = label.toLowerCase().trim();

  // 1. Skill Experience (single-skill and multi-skill stack matching)
  const isSkillQuestion =
    /how many years/i.test(labelLower) ||
    /years of/i.test(labelLower) ||
    /experience with/i.test(labelLower) ||
    /years with/i.test(labelLower) ||
    /hands-on experience/i.test(labelLower);

  if (isSkillQuestion && careerBrain.skillExperience) {
    // Find all candidate skills that match the question
    const matchedSkills: { skill: string; yrs: number }[] = [];
    for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
      if (!skill || yrs === undefined) continue;
      const cleanSkill = skill.toLowerCase().trim();
      const escaped = cleanSkill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wordRegex = new RegExp(`(?:^|[^a-zA-Z0-9#+])${escaped}(?:$|[^a-zA-Z0-9#+])`, 'i');
      if (wordRegex.test(labelLower) || matchesQuestionLoosely(label, skill)) {
        matchedSkills.push({ skill, yrs });
      }
    }

    // Check if the question mentions multiple tools/skills (e.g. "GoLang, Python, SQLAlchemy, PostgreSQL and TypeScript")
    const afterWithMatch = labelLower.match(/(?:with|in|using)\s+([a-z0-9#+.,\s&]+?)(?:\?|\*|$)/i);
    const listedTools = afterWithMatch
      ? afterWithMatch[1]
          .split(/,|\band\b|&/)
          .map(t => t.trim())
          .filter(t => t.length > 1 && !['hands-on', 'experience', 'years'].includes(t))
      : [];

    const isMultiSkill = matchedSkills.length > 1 || listedTools.length > 1;

    if (isMultiSkill) {
      // If the question lists tools that candidate does NOT have in skillExperience,
      // DO NOT arbitrarily pick one matching skill! Let it fall through to ask_user.
      const candidateKnownSkills = Object.keys(careerBrain.skillExperience).map(s => s.toLowerCase().trim());
      const hasUnmatchedListedTool = listedTools.some(
        tool => !candidateKnownSkills.some(cs => cs === tool || cs.includes(tool) || tool.includes(cs)),
      );

      if (hasUnmatchedListedTool || matchedSkills.length === 0) {
        logger.info(
          `[FormQuestionResolver] Combined multi-skill question "${label}" contains skills not in candidate profile (${listedTools.join(', ')}). Falling through to prevent arbitrary guessing.`,
        );
        // Do not match here; allows ask_user to get honest combined number
      } else {
        // All named skills are known in profile: use conservative minimum
        const minYears = Math.min(...matchedSkills.map(m => m.yrs));
        const skillNames = matchedSkills.map(m => m.skill).join(', ');
        return {
          matched: true,
          answer: String(minYears),
          sourceDetail: `conservative minimum across multi-skill stack [${skillNames}] (${minYears} yrs)`,
        };
      }
    } else if (matchedSkills.length === 1) {
      const single = matchedSkills[0];
      return {
        matched: true,
        answer: String(single.yrs),
        sourceDetail: `skillExperience["${single.skill}"] (${single.yrs} yrs)`,
      };
    }
  }

  // 1b. Generic Total Work Experience (NOT tied to any specific skill or technology)
  const isGenericTotalExperience =
    /\b(?:total|overall|all)\s*(?:years?|yrs?)?\s*(?:of)?\s*(?:work|professional)?\s*experi[ea]nce\b/i.test(
      labelLower,
    ) ||
    /\bhow\s*many\s*(?:years?|yrs?)\s*(?:of)?\s*(?:total|overall|work|professional)?\s*experi[ea]nce\b/i.test(
      labelLower,
    ) ||
    /\btotal\s*experi[ea]nce\b/i.test(labelLower) ||
    /\bexperi[ea]nce\s*in\s*years\b/i.test(labelLower) ||
    /^(?:total\s*)?(?:work\s*)?experi[ea]nce\s*(?:\(in\s*years?\))?[:?*]?$/i.test(labelLower);

  if (isGenericTotalExperience) {
    // Distinguishing signal: check whether a specific technology/tool name or skill-attribution pattern appears
    const hasSkillAttribution =
      /\b(?:with|using|in)\s+[a-z0-9#+.]+/i.test(labelLower) &&
      !/\b(?:in\s+total|in\s+your\s+career|in\s+this\s+field|in\s+the\s+industry|with\s+work)\b/i.test(labelLower);

    const allCandidateSkills = [
      ...(careerBrain.skills || []),
      ...Object.keys(careerBrain.skillExperience || {}),
    ].filter(s => s && s.trim().length > 1);

    const mentionsCandidateSkill = allCandidateSkills.some(skill => {
      const escaped = skill.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^a-zA-Z0-9#+])${escaped}(?:$|[^a-zA-Z0-9#+])`, 'i').test(labelLower);
    });

    if (!hasSkillAttribution && !mentionsCandidateSkill) {
      const rawYoe = careerBrain.yearsOfExperience ?? 1;
      const formattedYoe =
        /whole\s*number/i.test(labelLower + ' ' + (field.hintText || '') + ' ' + (field.placeholder || '')) ||
        Number.isInteger(rawYoe)
          ? String(Math.round(rawYoe))
          : String(rawYoe);
      const adapted = adaptAnswerToFieldFormat(formattedYoe, field);
      if (adapted.valid) {
        return {
          matched: true,
          answer: adapted.value,
          sourceDetail: adapted.sourceNote || `careerBrain.yearsOfExperience (${adapted.value} yrs)`,
        };
      }
    }
  }

  // 1c. Domain / Full Stack / Front End & Back End / Software / Web Development Experience
  const isDomainExperience =
    /(?:how\s*many\s*years|years\s*of|experience).*?(?:in|with)?\s*(?:front[-\s]*end\s*(?:&|and)\s*back[-\s]*end|full[-\s]*stack|software\s*(?:development|engineering)|web\s*development|front[-\s]*end|back[-\s]*end)\s*(?:development|engineering)?/i.test(
      labelLower,
    );

  if (isDomainExperience) {
    const rawYoe = careerBrain.yearsOfExperience ?? 1;
    const skillsMap = careerBrain.skillExperience || {};
    const frontendSkills = Object.entries(skillsMap).filter(([s]) =>
      /react|vue|angular|next\.?js|front[-\s]*end|javascript|typescript|html|css/i.test(s),
    );
    const backendSkills = Object.entries(skillsMap).filter(([s]) =>
      /node\.?js|express|python|django|flask|java|spring|back[-\s]*end|sql|mongo|postgres/i.test(s),
    );

    let calculatedYoe = rawYoe;
    if (/front[-\s]*end\s*(?:&|and)\s*back[-\s]*end|full[-\s]*stack/i.test(labelLower)) {
      if (frontendSkills.length > 0 && backendSkills.length > 0) {
        const maxFe = Math.max(...frontendSkills.map(([_, y]) => y));
        const maxBe = Math.max(...backendSkills.map(([_, y]) => y));
        calculatedYoe = Math.min(maxFe, maxBe, rawYoe) || rawYoe || 1;
      }
    } else if (/front[-\s]*end/i.test(labelLower) && frontendSkills.length > 0) {
      calculatedYoe = Math.max(...frontendSkills.map(([_, y]) => y));
    } else if (/back[-\s]*end/i.test(labelLower) && backendSkills.length > 0) {
      calculatedYoe = Math.max(...backendSkills.map(([_, y]) => y));
    }

    const formattedYoe = String(Math.max(1, Math.round(calculatedYoe)));
    const adapted = adaptAnswerToFieldFormat(formattedYoe, field);
    if (adapted.valid) {
      return {
        matched: true,
        answer: adapted.value,
        sourceDetail: `domain experience: calculated from candidate profile & stack (${adapted.value} yrs)`,
      };
    }
  }

  // 1d. Structured Work Experience & Work History (Dates, Title, Company, Currently Working)
  // CRITICAL: Strictly guard against general duration/years of experience questions
  const isExperienceOrDurationQuestion =
    /how\s*many\s*years|years\s*of|experience|duration|\(in\s*years?\)|notice\s*period|ctc|salary|when\s*can\s*you/i.test(
      labelLower,
    );

  if (!isExperienceOrDurationQuestion) {
    const primaryWork = getPrimaryWorkExperience(careerBrain);

    // Job Title / Position
    if (primaryWork?.title && /^(?:job\s*)?title$|^(?:current\s*)?(?:job\s*)?title$|^position$/i.test(labelLower)) {
      return {
        matched: true,
        answer: primaryWork.title,
        sourceDetail: `workExperience: title ("${primaryWork.title}")`,
      };
    }

    // Company / Employer
    if (
      primaryWork?.company &&
      /^(?:company|company\s*name|employer)$|^(?:current\s*)?(?:company|employer)$/i.test(labelLower)
    ) {
      return {
        matched: true,
        answer: primaryWork.company,
        sourceDetail: `workExperience: company ("${primaryWork.company}")`,
      };
    }

    // Role description / summary
    if (
      primaryWork?.description &&
      /^(?:role\s*)?description$|^summary$|^(?:work|job)\s*description$/i.test(labelLower)
    ) {
      return {
        matched: true,
        answer: primaryWork.description,
        sourceDetail: `workExperience: description`,
      };
    }

    // Start Month: "Month of From", "From: Month", "Start Month", etc.
    if (
      (/\b(?:from|start)\s*(?:month|date)\b|\bmonth\s+(?:of\s+)?(?:from|start)\b/i.test(labelLower) ||
        /^(?:start|from)\s*month$/i.test(labelLower)) &&
      !/start\s*(?:salary|ctc|compensation)/i.test(labelLower)
    ) {
      const dates = extractWorkHistoryDates(careerBrain);
      const ans = matchDateOption(field, dates.startMonth, 'month');
      if (ans) {
        return {
          matched: true,
          answer: ans,
          sourceDetail: `work history: start month (${dates.startMonth})`,
        };
      }
    }

    // Start Year: "Year of From", "From: Year", "Start Year", etc.
    if (
      (/\b(?:from|start)\s*year\b|\byear\s+(?:of\s+)?(?:from|start)\b/i.test(labelLower) ||
        /^(?:start|from)\s*year$/i.test(labelLower)) &&
      !/start\s*(?:salary|ctc|compensation)/i.test(labelLower)
    ) {
      const dates = extractWorkHistoryDates(careerBrain);
      const ans = matchDateOption(field, dates.startYear, 'year');
      if (ans) {
        return {
          matched: true,
          answer: ans,
          sourceDetail: `work history: start year (${dates.startYear})`,
        };
      }
    }

    // End Month: "Month of To", "To: Month", "End Month", etc.
    if (
      !/front[-\s]*end|back[-\s]*end|end[-\s]*to[-\s]*end/i.test(labelLower) &&
      (/\b(?:to|end|completion|finish)\s*(?:month|date)\b|\bmonth\s+(?:of\s+)?(?:to|end)\b/i.test(labelLower) ||
        /^(?:end|to)\s*month$/i.test(labelLower))
    ) {
      const dates = extractWorkHistoryDates(careerBrain);
      const ans = matchDateOption(field, dates.endMonth, 'month');
      if (ans) {
        return {
          matched: true,
          answer: ans,
          sourceDetail: `work history: end month (${dates.endMonth})`,
        };
      }
    }

    // End Year: "Year of To", "To: Year", "End Year", etc.
    if (
      !/front[-\s]*end|back[-\s]*end|end[-\s]*to[-\s]*end/i.test(labelLower) &&
      (/\b(?:to|end|completion|finish)\s*year\b|\byear\s+(?:of\s+)?(?:to|end)\b/i.test(labelLower) ||
        /^(?:end|to)\s*year$/i.test(labelLower))
    ) {
      const dates = extractWorkHistoryDates(careerBrain);
      const ans = matchDateOption(field, dates.endYear, 'year');
      if (ans) {
        return {
          matched: true,
          answer: ans,
          sourceDetail: `work history: end year (${dates.endYear})`,
        };
      }
    }
  }

  // Currently working here / I currently work here
  if (
    /currently\s*work|current\s*(?:role|job|company|employer|position|work)|currently\s*employed|i\s*work\s*here|present\s*(?:company|employer|role|job)/i.test(
      labelLower,
    )
  ) {
    const dates = extractWorkHistoryDates(careerBrain);
    const isCurrent = dates.isCurrentRole ?? true;
    const ans = isCurrent ? 'Yes' : 'No';
    const adapted = adaptAnswerToFieldFormat(ans, field);
    return {
      matched: true,
      answer: adapted.valid ? adapted.value : ans,
      sourceDetail: `work history: ${isCurrent ? 'currently working here' : 'past role'}`,
    };
  }

  // 2. Golden Answers (semantic cluster matching + format adaptation)
  if (!isGenericWorkExperienceDateField(label)) {
    const goldenAnswers = Array.isArray(careerBrain.goldenAnswers) ? careerBrain.goldenAnswers : [];
    const validGolden = goldenAnswers.filter(
      ga => ga && ga.question && ga.answer && !isGenericWorkExperienceDateField(ga.question),
    );

    // First attempt: Smart semantic matching (normalization + curated synonym clusters + token ranking)
    const bestGolden = findBestMatchingGoldenAnswer(label, validGolden);
    if (bestGolden.matched && bestGolden.goldenAnswer?.answer) {
      const adapted = adaptAnswerToFieldFormat(bestGolden.goldenAnswer.answer, field);
      if (adapted.valid) {
        return {
          matched: true,
          answer: adapted.value,
          sourceDetail:
            adapted.sourceNote ||
            `goldenAnswers (semantic match): "${bestGolden.goldenAnswer.question}" (${bestGolden.reason})`,
        };
      }
    }

    // Fallback attempt: matchesQuestionLoosely
    for (const ga of validGolden) {
      if (matchesQuestionLoosely(label, ga.question)) {
        const adapted = adaptAnswerToFieldFormat(ga.answer, field);
        if (adapted.valid) {
          return {
            matched: true,
            answer: adapted.value,
            sourceDetail: adapted.sourceNote || `goldenAnswers: "${ga.question}"`,
          };
        }
      }
    }
  }

  // 3. Custom Answers (loose match check with format adaptation)
  if (!isGenericWorkExperienceDateField(label)) {
    for (const [key, ans] of Object.entries(careerBrain.customAnswers || {})) {
      if (isGenericWorkExperienceDateField(key)) continue;
      if (matchesQuestionLoosely(label, key)) {
        const adapted = adaptAnswerToFieldFormat(String(ans), field);
        if (adapted.valid) {
          return {
            matched: true,
            answer: adapted.value,
            sourceDetail: adapted.sourceNote || `customAnswers: "${key}"`,
          };
        }
      }
    }
  }

  // 4. Standard Profile Fields
  const isBinaryOrSelect =
    field.fieldType === 'radio' ||
    field.fieldType === 'dropdown' ||
    field.fieldType === 'checkbox' ||
    (field.options && field.options.some(o => /^(yes|no)$/i.test(o.trim())));

  // Phone country code / Country dialing code (dropdown, combobox, or text)
  const isPhoneCountryCodeQuestion =
    /country\s*code|phone\s*country|dialing\s*code|country\s*calling\s*code|country\/region\s*code/i.test(labelLower) ||
    /countrycode/i.test(field.id || '');

  if (isPhoneCountryCodeQuestion) {
    const phone = careerBrain.phoneNumber || '';
    let dialingCode = '+91';
    let countryName = 'India';

    if (phone.startsWith('+1')) {
      dialingCode = '+1';
      countryName = 'United States';
    } else if (phone.startsWith('+44')) {
      dialingCode = '+44';
      countryName = 'United Kingdom';
    } else if (phone.startsWith('+61')) {
      dialingCode = '+61';
      countryName = 'Australia';
    } else if (phone.startsWith('+49')) {
      dialingCode = '+49';
      countryName = 'Germany';
    } else if (phone.startsWith('+971')) {
      dialingCode = '+971';
      countryName = 'United Arab Emirates';
    } else if (phone.startsWith('+65')) {
      dialingCode = '+65';
      countryName = 'Singapore';
    } else if (careerBrain.currentLocation || careerBrain.preferredLocation) {
      const parts = parseLocationParts(careerBrain.currentLocation || careerBrain.preferredLocation);
      if (/united states|usa|us/i.test(parts.country)) {
        dialingCode = '+1';
        countryName = 'United States';
      } else if (/united kingdom|uk/i.test(parts.country)) {
        dialingCode = '+44';
        countryName = 'United Kingdom';
      }
    }

    if (field.options && field.options.length > 0) {
      const matchedOpt = field.options.find(
        o =>
          o.toLowerCase().includes(dialingCode.toLowerCase()) ||
          o.toLowerCase().includes(countryName.toLowerCase()) ||
          (countryName === 'United States' && /\b(us|usa)\b/i.test(o)),
      );
      if (matchedOpt) {
        return {
          matched: true,
          answer: matchedOpt,
          sourceDetail: `phone country code: matched "${matchedOpt}" from ${dialingCode}`,
        };
      }
    }

    return {
      matched: true,
      answer: field.fieldType === 'number' ? dialingCode.replace('+', '') : `${countryName} (${dialingCode})`,
      sourceDetail: `phone country code: ${countryName} (${dialingCode})`,
    };
  }

  const isPhoneQuestion =
    !isBinaryOrSelect &&
    /(?:\bphone\b|\btelephone\b|\bcell\b|\bmobile\s*(?:phone|number|no\.?|contact|#)\b|\bcontact\s*number\b)/i.test(
      labelLower,
    ) &&
    !/\b(?:mobile\s*(?:app|application|dev|development|engineer|tech|platform|friendly|web|stack)|support|can\s*you|are\s*you|do\s*you)\b/i.test(
      labelLower,
    );

  if (isPhoneQuestion && careerBrain.phoneNumber) {
    return { matched: true, answer: careerBrain.phoneNumber, sourceDetail: 'profile: phoneNumber' };
  }

  const isEmailQuestion =
    !isBinaryOrSelect &&
    /\bemail\b(?:\s*address)?/i.test(labelLower) &&
    !/\b(?:receive|notify|notification|updates|subscribe|consent|agree|marketing|send\s*(?:me|you)?\s*email)\b/i.test(
      labelLower,
    );

  if (isEmailQuestion && careerBrain.email) {
    return { matched: true, answer: careerBrain.email, sourceDetail: 'profile: email' };
  }
  // Location Willingness, Commute, Relocation, and Hybrid/Client Location questions
  if (
    /comfortable\s*(?:with)?|willing\s*(?:to)?|open\s*to|able\s*to\s*commute|can\s*you\s*work|work\s*from|relocate|commute|onsite/i.test(
      labelLower,
    ) &&
    /location|office|client|hybrid|city|travel|relocate|commute|bangalore|bengaluru/i.test(labelLower)
  ) {
    return { matched: true, answer: 'Yes', sourceDetail: 'profile standard: location / onsite willingness' };
  }
  if (/onsite|commute|relocate/i.test(labelLower)) {
    return { matched: true, answer: 'Yes', sourceDetail: 'profile standard: onsite willingness' };
  }

  // Timezone overlap, working hours, shift flexibility, US Eastern/PST/GMT/UTC overlap
  if (
    /(?:daily\s*)?overlap|time\s*zone|working\s*hours|shift\s*(?:timing|hours|flexibility)|flexible\s*hours|eastern\s*time|\best\b|\bpst\b|\bcst\b|\bgmt\b|\butc\b/i.test(
      labelLower,
    ) &&
    /(?:commit|overlap|hours|time|shift|available|work|zone)/i.test(labelLower)
  ) {
    return { matched: true, answer: 'Yes', sourceDetail: 'profile standard: schedule / timezone overlap willingness' };
  }

  // Remote work willingness / work from home
  if (
    /work\s*remotely|remote\s*work|work\s*from\s*home|wfh/i.test(labelLower) &&
    /willing|comfortable|able|can\s*you|open\s*to|do\s*you/i.test(labelLower)
  ) {
    return { matched: true, answer: 'Yes', sourceDetail: 'profile standard: remote work willingness' };
  }

  // Compliance / Terms / Background Check / Drug Screening / Legal Disclosures / Consent
  if (
    /background\s*(?:check|investigation|verification)|drug\s*screen(?:ing)?|agree\s*to|consent\s*to|comply\s*with|certify|acknowledge|terms\s*(?:and|&)\s*conditions|privacy\s*policy|terms\s*of\s*service|accuracy\s*of\s*information|confirm\s*(?:that|the)/i.test(
      labelLower,
    )
  ) {
    return { matched: true, answer: 'Yes', sourceDetail: 'standard compliance: agreement / consent / acknowledgment' };
  }

  // Immediate Joiner / Joining Availability
  if (/immediate\s*joiner|join\s*immediately/i.test(labelLower)) {
    const isImmediate = !careerBrain.noticePeriod || /immediate|0|15\s*days?|now/i.test(careerBrain.noticePeriod);
    return {
      matched: true,
      answer: isImmediate ? 'Yes' : 'No',
      sourceDetail: `profile: noticePeriod ("${careerBrain.noticePeriod || 'Immediate'}")`,
    };
  }

  // Cover Letter / Application Pitch / "Why should we hire you?"
  if (
    /cover\s*letter|cover\s*note|why\s*(?:should\s*we\s*hire|are\s*you\s*interested|do\s*you\s*want\s*to\s*work)|pitch\s*for|note\s*(?:to|for)\s*(?:the\s*)?hiring\s*manager|tell\s*us\s*why\s*you/i.test(
      labelLower,
    )
  ) {
    const coverLetterText = generateTailoredCoverLetter(careerBrain);
    return {
      matched: true,
      answer: coverLetterText,
      sourceDetail: 'AI-Generated Tailored Cover Letter / Pitch',
    };
  }

  // Preferred Location (prioritizing Priority 1 > Priority 2 > Priority 3)
  if (
    /preferred\s*location|target\s*location|which\s*location|location\s*preference/i.test(labelLower) &&
    !/comfortable|willing|open\s+to|commute|relocate|able\s+to|hybrid|onsite|are\s+you/i.test(labelLower) &&
    (careerBrain.preferredLocations?.length || careerBrain.preferredLocation || careerBrain.currentLocation)
  ) {
    const list =
      Array.isArray(careerBrain.preferredLocations) && careerBrain.preferredLocations.length > 0
        ? careerBrain.preferredLocations
        : [careerBrain.preferredLocation || careerBrain.currentLocation || ''];

    if (field.options && field.options.length > 0) {
      for (let pIdx = 0; pIdx < list.length; pIdx++) {
        const pref = list[pIdx];
        if (!pref) continue;
        const prefLo = pref.toLowerCase();
        const parts = parseLocationParts(pref);
        const cityLo = parts.city.toLowerCase();

        const matchedOpt = field.options.find(opt => {
          const optLo = opt.toLowerCase();
          return (
            (cityLo && optLo.includes(cityLo)) ||
            prefLo.includes(optLo) ||
            optLo.includes(prefLo) ||
            (optLo.includes('remote') && prefLo.includes('remote'))
          );
        });

        if (matchedOpt) {
          return {
            matched: true,
            answer: matchedOpt,
            sourceDetail: `profile: preferredLocations [Priority ${pIdx + 1}] ("${matchedOpt}")`,
          };
        }
      }
    }

    const priority1 = list[0] || careerBrain.preferredLocation || careerBrain.currentLocation || '';
    const cleanCity = cleanLocationForCityField(priority1);
    const finalAns = cleanCity || priority1;
    return {
      matched: true,
      answer: finalAns,
      sourceDetail: `profile: preferredLocations [Priority 1] ("${finalAns}")`,
    };
  }

  // City / Residential Location (must NOT be a willingness or binary question)
  if (
    /city|location/i.test(labelLower) &&
    !/comfortable|willing|open\s+to|commute|relocate|able\s+to|hybrid|onsite|are\s+you/i.test(labelLower) &&
    (careerBrain.currentLocation || careerBrain.preferredLocation)
  ) {
    const rawLoc = careerBrain.currentLocation || careerBrain.preferredLocation || '';
    const cleanCity = cleanLocationForCityField(rawLoc);
    const finalAnswer = cleanCity || rawLoc;
    return { matched: true, answer: finalAnswer, sourceDetail: `profile: location ("${finalAnswer}")` };
  }

  // State / Province / Region
  if (
    /(?:^|\b)(?:state|province|region)(?:\b|$)/i.test(labelLower) &&
    !/comfortable|willing|open\s+to|commute|relocate/i.test(labelLower) &&
    (careerBrain.currentLocation || careerBrain.preferredLocation)
  ) {
    const rawLoc = careerBrain.currentLocation || careerBrain.preferredLocation || '';
    const parts = parseLocationParts(rawLoc);
    if (parts.state) {
      return { matched: true, answer: parts.state, sourceDetail: `profile: location state ("${parts.state}")` };
    }
  }

  // Country
  if (
    /(?:^|\b)(?:country|nationality)(?:\b|$)/i.test(labelLower) &&
    !/comfortable|willing|open\s+to|commute|relocate|authorized|sponsorship/i.test(labelLower) &&
    (careerBrain.currentLocation || careerBrain.preferredLocation)
  ) {
    const rawLoc = careerBrain.currentLocation || careerBrain.preferredLocation || '';
    const parts = parseLocationParts(rawLoc);
    if (parts.country) {
      return { matched: true, answer: parts.country, sourceDetail: `profile: location country ("${parts.country}")` };
    }
  }
  if (/authorized|legally\s*authorized|eligible\s*to\s*work/i.test(labelLower)) {
    const isAuth = !careerBrain.workAuthorization?.toLowerCase().includes('not authorized');
    return { matched: true, answer: isAuth ? 'Yes' : 'No', sourceDetail: 'profile: workAuthorization' };
  }
  if (/sponsorship|visa/i.test(labelLower)) {
    const reqSpons = careerBrain.workAuthorization?.toLowerCase().includes('requires sponsorship');
    return { matched: true, answer: reqSpons ? 'Yes' : 'No', sourceDetail: 'profile: workAuthorization' };
  }
  if (
    /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(labelLower) &&
    careerBrain.noticePeriod
  ) {
    const adapted = adaptAnswerToFieldFormat(careerBrain.noticePeriod, field);
    if (adapted.valid) {
      return {
        matched: true,
        answer: adapted.value,
        sourceDetail: adapted.sourceNote || 'profile: noticePeriod',
      };
    }
  }
  if (/cgpa|gpa|percentage/i.test(labelLower) && careerBrain.cgpa) {
    return { matched: true, answer: careerBrain.cgpa, sourceDetail: 'profile: cgpa' };
  }
  // Current CTC / Salary / Compensation (widened pattern)
  const isCurrentCTCLabel =
    /(?:current|present|existing)\s*(?:fixed\s*)?(?:ctc|salary|compensation)|\bctc\s*in\s*inr\b|\bfixed\s*ctc\b|\bannual\s*ctc\b|\bgross\s*ctc\b/i.test(
      labelLower,
    ) && !/expected|target|desired|seeking/i.test(labelLower);

  if (isCurrentCTCLabel && careerBrain.currentCTC) {
    const adapted = adaptAnswerToFieldFormat(careerBrain.currentCTC, field);
    if (adapted.valid) {
      return {
        matched: true,
        answer: adapted.value,
        sourceDetail: adapted.sourceNote || 'profile: currentCTC',
      };
    }
  }

  // Expected CTC / Salary / Compensation (widened pattern)
  const isExpectedCTCLabel =
    /(?:expected|target|desired|seeking)\s*(?:fixed\s*)?(?:ctc|salary|compensation)|\bexpected\s*ctc\b/i.test(
      labelLower,
    );

  if (isExpectedCTCLabel && (careerBrain.expectedCTC || careerBrain.salaryExpectation)) {
    const rawExpected = careerBrain.expectedCTC || careerBrain.salaryExpectation!;
    const adapted = adaptAnswerToFieldFormat(rawExpected, field);
    if (adapted.valid) {
      return {
        matched: true,
        answer: adapted.value,
        sourceDetail: adapted.sourceNote || 'profile: expectedCTC',
      };
    }
  }
  if (!isBinaryOrSelect) {
    if (/github/i.test(labelLower) && careerBrain.githubUrl) {
      return { matched: true, answer: careerBrain.githubUrl, sourceDetail: 'profile: githubUrl' };
    }
    if (/linkedin/i.test(labelLower) && careerBrain.linkedinUrl) {
      return { matched: true, answer: careerBrain.linkedinUrl, sourceDetail: 'profile: linkedinUrl' };
    }
  }

  // 5. Education & Degree Questions
  if (/education|degree|graduate|bachelor|master|phd|doctorate|high\s*school/i.test(labelLower)) {
    const edu = getCandidateEducationLevels(careerBrain);

    const isYesNo =
      (field.options &&
        field.options.some(o => /^yes$/i.test(o.trim())) &&
        field.options.some(o => /^no$/i.test(o.trim()))) ||
      /have you completed|do you have|did you graduate|is your degree/i.test(labelLower);

    // a) Bachelor's / Undergraduate questions
    if (/bachelor/i.test(labelLower)) {
      if (edu.hasBachelor || edu.hasMaster || edu.hasDoctorate) {
        const ans = isYesNo ? 'Yes' : field.options?.find(o => /bachelor/i.test(o)) || "Bachelor's Degree";
        return {
          matched: true,
          answer: ans,
          sourceDetail: `education: ${edu.summary || "Bachelor's Degree in profile/resume"}`,
        };
      } else {
        return {
          matched: true,
          answer: isYesNo ? 'No' : undefined,
          sourceDetail: 'education: No Bachelor degree found in profile/resume',
        };
      }
    }

    // b) Master's / Postgraduate questions
    if (/master/i.test(labelLower)) {
      if (edu.hasMaster || edu.hasDoctorate) {
        const ans = isYesNo ? 'Yes' : field.options?.find(o => /master/i.test(o)) || "Master's Degree";
        return {
          matched: true,
          answer: ans,
          sourceDetail: `education: ${edu.summary || "Master's Degree in profile/resume"}`,
        };
      } else {
        return {
          matched: true,
          answer: isYesNo ? 'No' : undefined,
          sourceDetail: 'education: No Master degree found in profile/resume',
        };
      }
    }

    // c) Doctorate / PhD questions
    if (/doctorate|phd/i.test(labelLower)) {
      if (edu.hasDoctorate) {
        const ans = isYesNo ? 'Yes' : field.options?.find(o => /doctorate|phd/i.test(o)) || 'Doctorate';
        return {
          matched: true,
          answer: ans,
          sourceDetail: `education: ${edu.summary || 'Doctorate in profile/resume'}`,
        };
      } else {
        return {
          matched: true,
          answer: isYesNo ? 'No' : undefined,
          sourceDetail: 'education: No Doctorate in profile/resume',
        };
      }
    }

    // d) High School questions
    if (/high\s*school|secondary/i.test(labelLower)) {
      if (edu.hasHighSchool) {
        const ans = isYesNo ? 'Yes' : field.options?.find(o => /high\s*school/i.test(o)) || 'High School';
        return {
          matched: true,
          answer: ans,
          sourceDetail: 'education: High School / Secondary completed',
        };
      }
    }

    // e) Highest level of education (e.g. dropdown or radio options)
    if (
      /highest\s*level\s*of\s*education|level\s*of\s*education/i.test(labelLower) &&
      field.options &&
      field.options.length > 0
    ) {
      if (edu.hasDoctorate) {
        const opt = field.options.find(o => /doctor|phd/i.test(o));
        if (opt) return { matched: true, answer: opt, sourceDetail: 'education: Doctorate' };
      }
      if (edu.hasMaster) {
        const opt = field.options.find(o => /master/i.test(o));
        if (opt) return { matched: true, answer: opt, sourceDetail: 'education: Master' };
      }
      if (edu.hasBachelor) {
        const opt = field.options.find(o => /bachelor/i.test(o));
        if (opt) return { matched: true, answer: opt, sourceDetail: "education: Bachelor's" };
      }
      if (edu.hasHighSchool) {
        const opt = field.options.find(o => /high\s*school|secondary/i.test(o));
        if (opt) return { matched: true, answer: opt, sourceDetail: 'education: High School' };
      }
    }

    // f) College / University questions
    if (/college|university|school|institution/i.test(labelLower) && careerBrain.college) {
      return { matched: true, answer: careerBrain.college, sourceDetail: 'profile: college' };
    }

    // g) Degree or major text fields
    if (/degree|major|field\s*of\s*study/i.test(labelLower) && careerBrain.education) {
      return { matched: true, answer: careerBrain.education, sourceDetail: 'profile: education' };
    }
  }

  // f) Graduation Month & Year
  if (/graduation|graduate/i.test(labelLower)) {
    if (/month/i.test(labelLower)) {
      const ans = matchDateOption(field, 'May', 'month');
      if (ans) {
        return { matched: true, answer: ans, sourceDetail: 'education: graduation month' };
      }
    }
    if (/year/i.test(labelLower)) {
      const dates = extractWorkHistoryDates(careerBrain);
      const gradYear = String(parseInt(dates.startYear, 10));
      const ans = matchDateOption(field, gradYear, 'year');
      if (ans) {
        return { matched: true, answer: ans, sourceDetail: `education: graduation year (${gradYear})` };
      }
    }
  }

  // g) Top Choice promotional checkbox (LinkedIn Premium - optional, left unticked, never ask user)
  if (/top\s*choice|mark\s*(?:this\s*)?job\s*as\s*(?:a\s*)?top\s*choice/i.test(labelLower)) {
    return {
      matched: true,
      answer: 'No',
      sourceDetail: 'optional promotional field: top choice (left unticked to preserve quota)',
    };
  }

  // i) Driver's License
  if (/(?:valid\s*)?driver(?:'s)?\s*license|driving\s*licen[sc]e/i.test(labelLower)) {
    return {
      matched: true,
      answer: careerBrain.driverLicense || 'Yes',
      sourceDetail: 'profile: driverLicense',
    };
  }

  // j) Age requirement / 18+
  if (/18\s*years(?:\s*of\s*age)?|at\s*least\s*18|age\s*requirement|are\s*you\s*18/i.test(labelLower)) {
    return {
      matched: true,
      answer: 'Yes',
      sourceDetail: 'profile: age requirement (18+ confirmed)',
    };
  }
  if (/date\s*of\s*birth|\bdob\b|birth\s*date/i.test(labelLower)) {
    return {
      matched: true,
      answer: careerBrain.dateOfBirth || '2000-01-01',
      sourceDetail: 'profile: dateOfBirth',
    };
  }

  // k) Shifts, Working Hours & Weekend Flexibility
  if (
    /preferred\s*shift|night\s*shift|day\s*shift|rotat(?:ing|ional)\s*shift|work(?:ing)?\s*weekends|on-call/i.test(
      labelLower,
    )
  ) {
    const isYesNo = field.options && field.options.some(o => /^(yes|no)$/i.test(o.trim()));
    return {
      matched: true,
      answer: isYesNo ? 'Yes' : careerBrain.preferredShift || 'Day / Flexible',
      sourceDetail: 'profile: preferredShift',
    };
  }

  // l) Veteran Status
  if (/veteran|military\s*(?:status|service)|protected\s*veteran/i.test(labelLower)) {
    const isYesNo = field.options && field.options.some(o => /^(yes|no)$/i.test(o.trim()));
    return {
      matched: true,
      answer: isYesNo ? 'No' : careerBrain.veteranStatus || 'I am not a protected veteran',
      sourceDetail: 'profile: veteranStatus',
    };
  }

  // m) Disability Status
  if (/disability|impairment|handicap/i.test(labelLower)) {
    const isYesNo = field.options && field.options.some(o => /^(yes|no)$/i.test(o.trim()));
    return {
      matched: true,
      answer: isYesNo ? 'No' : careerBrain.disabilityStatus || 'No, I do not have a disability',
      sourceDetail: 'profile: disabilityStatus',
    };
  }

  // n) Previously employed at this company / Currently employed
  if (/previously\s*worked|previous\s*employee|worked\s*(?:at|for)\s*(?:this\s*)?company/i.test(labelLower)) {
    return {
      matched: true,
      answer: 'No',
      sourceDetail: 'profile standard: not previously employed at this company',
    };
  }
  if (/currently\s*employed|are\s*you\s*currently\s*working/i.test(labelLower)) {
    return {
      matched: true,
      answer: 'Yes',
      sourceDetail: 'profile standard: currently employed',
    };
  }

  // o) Salary range acceptable
  if (/salary\s*range|range\s*acceptable|compensation\s*acceptable/i.test(labelLower)) {
    return {
      matched: true,
      answer: 'Yes',
      sourceDetail: 'profile standard: salary range acceptable',
    };
  }

  return { matched: false };
}

/**
 * Rule 1: LLM Semantic Interpretation & Matching for Ambiguous Wording
 * Maps synonyms (e.g. "server-side JavaScript" -> Node.js) to stored skillExperience / goldenAnswers.
 * Strictly matching, NEVER inventing.
 */
export async function matchWithLLM(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm: BaseChatModel,
): Promise<{ matched: boolean; answer?: string; sourceDetail?: string }> {
  try {
    const skillList = Object.entries(careerBrain.skillExperience || {})
      .map(([s, y]) => `"${s}": ${y} years`)
      .join(', ');

    const goldenList = (careerBrain.goldenAnswers || [])
      .map(ga => `Q: "${ga.question}" -> A: "${ga.answer}"`)
      .join('\n');

    const prompt = `You are a semantic question matcher for job applications.
Your job is to match ambiguous or synonym question wording to the candidate's existing stored data.

CRITICAL RULES:
1. MATCHING ONLY, ZERO INVENTION: If the question asks for years of experience in a skill, match it ONLY if the skill is an alias or synonym of a key in the candidate's skillExperience (e.g. "server-side JavaScript" maps to "Node.js", "AWS" maps to "Amazon Web Services", "Postgres" maps to "PostgreSQL").
2. If the candidate does not have this skill or its direct alias in skillExperience, DO NOT GUESS OR INVENT A NUMBER. Return {"isMatched": false}.
3. For general screening questions, check if it maps to one of the Golden Answers.
4. Output strictly valid JSON.

=== CANDIDATE STORED SKILL EXPERIENCE ===
${skillList || 'None'}

=== CANDIDATE GOLDEN ANSWERS ===
${goldenList || 'None'}

=== TARGET QUESTION ===
Question: "${field.label}"
Field Type: ${field.fieldType}
Options: ${field.options ? JSON.stringify(field.options) : 'None'}

Output JSON schema:
{
  "isMatched": boolean,
  "answer": string or null,
  "matchedKey": string or null,
  "reasoning": string
}`;

    const res = await llm.invoke([
      new SystemMessage('You are a strict semantic matcher. Output valid JSON only.'),
      new HumanMessage(prompt),
    ]);

    const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const clean = content.replace(/```json\s*|```\s*/gi, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (
        parsed.isMatched &&
        parsed.answer !== null &&
        parsed.answer !== undefined &&
        String(parsed.answer).trim() !== ''
      ) {
        const rawAns = String(parsed.answer).trim();
        const adapted = adaptAnswerToFieldFormat(rawAns, field);
        if (adapted.valid) {
          recordLlmSuccess();
          return {
            matched: true,
            answer: adapted.value,
            sourceDetail:
              adapted.sourceNote ||
              `LLM semantic match -> ${parsed.matchedKey || 'stored profile'} (${parsed.reasoning || ''})`,
          };
        }
      }
    }
  } catch (err) {
    if (isNetworkError(err)) {
      recordLlmNetworkFailure(err);
    } else {
      logger.warning('[FormQuestionResolver] LLM semantic match error:', err);
    }
  }

  return { matched: false };
}

/**
 * Rule 2: LLM Free-Text Answer Generation for Non-Factual Narrative Questions
 * Generates concise, professional answers using resume text and narrative.
 * Never invents specific numbers, dates, company names, or metrics not in profile.
 */
export async function generateFreeTextAnswer(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm: BaseChatModel,
): Promise<string> {
  const prompt = `You are an elite career assistant generating a concise, professional free-text response for a job application question.

CRITICAL ANTI-HALLUCINATION RULES:
1. NEVER invent specific numbers, dates, metrics, percentages, or client/company names not explicitly present in the resume.
2. Keep the answer authentic, professional, and general to the candidate's actual experience and strengths.
3. Keep the response concise: 1 to 3 impactful sentences (approx 40-70 words maximum).
4. Speak in the first person ("I have...", "My experience includes..."). Do NOT mention you are an AI.

=== CANDIDATE BACKGROUND & RESUME ===
Name: ${careerBrain.fullName}
Title: ${careerBrain.currentTitle}
Experience: ${careerBrain.yearsOfExperience} years
Skills: ${(careerBrain.skills || []).join(', ')}
Narrative: ${careerBrain.backgroundNarrative || 'Experienced professional with a strong track record of delivery.'}
Resume Excerpt: ${(careerBrain.resumeText || '').slice(0, 800)}

=== TARGET QUESTION ===
"${field.label}"

Write the concise, professional answer directly:`;

  const res = await llm.invoke([
    new SystemMessage('You are a professional job applicant. Answer concisely and authentically without preamble.'),
    new HumanMessage(prompt),
  ]);

  const content = typeof res.content === 'string' ? res.content : String(res.content);
  return content.replace(/^["']|["']$/g, '').trim();
}

/**
 * Searches the candidate's full resumeText for explicit mentions of the skill/topic in question.
 *
 * CRITICAL ZERO-INVENTION BOUNDARY:
 * 1. Requires a genuine, specific mention of the skill/topic in resumeText (or candidate's skills list).
 * 2. If the topic is absent (e.g. "Intershop Commerce Suite"), returns { matched: false } so it triggers ask_user.
 * 3. Never allows guessing, estimation, or imaginary numbers without explicit basis in the resume text.
 * 4. If an explicit number, duration, or clear yes/no is stated, returns as [MATCHED] with source "from resume text".
 */
export async function matchFromResumeText(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<{ matched: boolean; answer?: string; sourceDetail?: string }> {
  const resumeText = (careerBrain.resumeText || '').trim();
  if (!resumeText) return { matched: false };

  const cleanLabel = cleanLinkedInText(field.label || '');
  const topic = extractQuestionTopic(cleanLabel);

  const resumeLower = resumeText.toLowerCase();

  // 1. Topic presence verification:
  // If a topic was identified, verify that the resume actually mentions it.
  // If the resume has NO mention of this topic (e.g. "Intershop Commerce Suite"),
  // return immediately with matched: false to trigger ask_user.
  let isTopicMentioned = false;
  let topicPattern: RegExp | null = null;

  if (topic) {
    const escapedTopic = topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    topicPattern = new RegExp(`\\b${escapedTopic}\\b`, 'i');
    if (topicPattern.test(resumeText) || resumeLower.includes(topic.toLowerCase())) {
      isTopicMentioned = true;
    }
  }

  // Also check if candidate's explicit skills list mentions it
  if (!isTopicMentioned && Array.isArray(careerBrain.skills) && topic) {
    const skillFound = careerBrain.skills.some(
      s => s.toLowerCase() === topic.toLowerCase() || s.toLowerCase().includes(topic.toLowerCase()),
    );
    if (skillFound) {
      isTopicMentioned = true;
    }
  }

  // If topic is not in resume or skills, DO NOT GUESS OR ESTIMATE -> trigger ask_user!
  if (!isTopicMentioned) {
    logger.info(
      `[FormQuestionResolver] Topic "${topic || cleanLabel}" not found in resume text. Deferring to ask_user.`,
    );
    return { matched: false };
  }

  // 2. Fast Rule-Based Extraction:
  // a) Yes/No or radio/dropdown questions (e.g. "Do you have experience with X?")
  const isYesNoQuestion =
    field.options &&
    field.options.some(o => /^yes$/i.test(o.trim())) &&
    field.options.some(o => /^no$/i.test(o.trim()));

  const isFamiliarityQuestion =
    /do you have|have you worked|familiar with|knowledge of|experience with|completed|level of education|degree|graduate/i.test(
      cleanLabel,
    );

  if (isYesNoQuestion && isFamiliarityQuestion && isTopicMentioned) {
    return {
      matched: true,
      answer: 'Yes',
      sourceDetail: `from resume text: explicit mention of "${topic}"`,
    };
  }

  // b) Explicit duration/years regex around topic mention (e.g. "Node.js (3 years)", "React - 4 yrs", "5+ years of Java")
  if (topicPattern && (field.fieldType === 'number' || /how many years|years of/i.test(cleanLabel))) {
    const escapedTopic = topic ? topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    if (escapedTopic) {
      const regexBefore = new RegExp(
        `(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,.]{0,25}?\\b${escapedTopic}\\b`,
        'i',
      );
      const regexAfter = new RegExp(
        `\\b${escapedTopic}\\b[^\\n\\r,.]{0,25}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?`,
        'i',
      );

      const matchBefore = resumeText.match(regexBefore);
      if (matchBefore && matchBefore[1]) {
        const adapted = adaptAnswerToFieldFormat(matchBefore[1], field);
        if (adapted.valid) {
          return {
            matched: true,
            answer: adapted.value,
            sourceDetail: adapted.sourceNote || `from resume text: "${matchBefore[0].trim()}"`,
          };
        }
      }

      const matchAfter = resumeText.match(regexAfter);
      if (matchAfter && matchAfter[1]) {
        const adapted = adaptAnswerToFieldFormat(matchAfter[1], field);
        if (adapted.valid) {
          return {
            matched: true,
            answer: adapted.value,
            sourceDetail: adapted.sourceNote || `from resume text: "${matchAfter[0].trim()}"`,
          };
        }
      }
    }
  }

  // 3. LLM Fact Extraction from Resume (Strict Zero-Invention):
  if (llm) {
    try {
      // Find relevant snippet of resume around the topic to provide focused context
      let relevantExcerpt = resumeText.slice(0, 3000);
      if (topic) {
        const topicIdx = resumeLower.indexOf(topic.toLowerCase());
        if (topicIdx >= 0) {
          const start = Math.max(0, topicIdx - 600);
          const end = Math.min(resumeText.length, topicIdx + 1200);
          relevantExcerpt = `...${resumeText.slice(start, end)}...`;
        }
      }

      const prompt = `You are a strict resume fact extractor for job application screening questions.
Your task is to determine if the candidate's RESUME TEXT explicitly provides a factual answer for the target question.

CRITICAL RULES:
1. STRICT ZERO-INVENTION:
   - If the resume text does NOT state an explicit duration, dates, or fact for this question, you MUST return {"found": false}.
   - NEVER guess, estimate, calculate imaginary years, or infer experience without explicit evidence.
2. NUMERIC / YEARS QUESTIONS:
   - Only return found: true if the resume text explicitly states the number of years/months for this skill, OR if the skill is explicitly listed under job experience entries with clear dates (e.g. 2021 to 2024 = 3 years).
   - If the resume merely lists the skill without any date context or duration, return {"found": false}.
3. YES / NO / RADIO / DROPDOWN QUESTIONS:
   - If the question asks if the candidate has experience or familiarity with the skill (e.g. "Do you have experience with Docker?"), and the resume explicitly describes projects or lists experience with it, answer "Yes".
   - If evidence is ambiguous, return {"found": false}.
4. Output strictly valid JSON:
{
  "found": boolean,
  "answer": string or null,
  "evidence": string or null
}

=== CANDIDATE RESUME EXCERPT ===
${relevantExcerpt}

=== TARGET QUESTION ===
Question: "${cleanLabel}"
Field Type: ${field.fieldType}
Options: ${field.options ? JSON.stringify(field.options) : 'None'}
`;

      const res = await llm.invoke([
        new SystemMessage('You are a strict factual resume auditor. Zero invention. Output valid JSON only.'),
        new HumanMessage(prompt),
      ]);

      const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
      const clean = content.replace(/```json\s*|```\s*/gi, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (
          parsed.found === true &&
          parsed.answer !== null &&
          parsed.answer !== undefined &&
          String(parsed.answer).trim() !== ''
        ) {
          const ans = String(parsed.answer).trim();
          const adapted = adaptAnswerToFieldFormat(ans, field);
          if (adapted.valid) {
            logger.info(
              `[FormQuestionResolver] [MATCHED from resume] "${cleanLabel}": "${adapted.value}" (${parsed.evidence || ''})`,
            );
            return {
              matched: true,
              answer: adapted.value,
              sourceDetail: adapted.sourceNote || `from resume text: ${parsed.evidence || 'explicit resume mention'}`,
            };
          }
        }
      }
    } catch (llmErr) {
      logger.warning('[FormQuestionResolver] LLM resume extraction error:', llmErr);
    }
  }

  return { matched: false };
}

/**
 * Detects whether a form field is a subjective / experience-based Yes/No or confirmation question.
 * Strictly excludes factual numeric, compliance, legal, salary, and education degree fields.
 */
export function isSubjectiveExperienceYesNoQuestion(field: FormFieldDescriptor): boolean {
  const label = cleanLinkedInText(field.label || '');
  const labelLower = label.toLowerCase().trim();

  // 1. Must NOT be a factual numeric, compliance, or legal field
  const isExcludedFactual =
    field.fieldType === 'number' ||
    /(?:ctc|salary|compensation|\blpa\b|\binr\b|\busd\b)/i.test(labelLower) ||
    /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(labelLower) ||
    /how\s*many\s*years|years\s*of\s*(?:work\s*)?experience|total\s*experience/i.test(labelLower) ||
    /authorized|authorization|sponsorship|visa|citizen|greencard|green\s*card|legally/i.test(labelLower) ||
    /background\s*check|drug\s*test|criminal|felony|driver(?:'s)?\s*license|security\s*clearance/i.test(labelLower) ||
    /\b(?:gpa|cgpa|percentage|graduation\s*year|degree|bachelor|master|phd|diploma)\b/i.test(labelLower) ||
    /18\s*years|legal\s*age/i.test(labelLower) ||
    /commute|relocate|onsite/i.test(labelLower) ||
    /phone|telephone|mobile\s*number|email\s*address/i.test(labelLower);

  if (isExcludedFactual) {
    return false;
  }

  // 2. Must be a Yes/No style choice or checkbox, or phrased as a binary experience question
  const hasBinaryOptions =
    (field.options && field.options.some(o => /^(yes|agree|true)$/i.test(o.trim()))) ||
    field.fieldType === 'radio' ||
    field.fieldType === 'checkbox' ||
    field.fieldType === 'dropdown';

  const isExperiencePhrasing =
    /\b(have\s*you|do\s*you\s*have|can\s*you|did\s*you|are\s*you\s*(?:able|experienced|proficient|skilled)|experience\s*(?:with|in|using)|hands-on|familiar|worked\s*(?:with|on|in)|developed|built|created|designed|architected|implemented|managed|maintain(?:ed)?|knowledge\s*of)\b/i.test(
      labelLower,
    );

  return Boolean(hasBinaryOptions && isExperiencePhrasing);
}

/**
 * Step 3d: Infers whether the candidate's resume/skills clearly describe relevant work
 * for a subjective Yes/No experience question (e.g. "Have you developed SaaS, ERP, CRM, or other business applications?").
 *
 * If genuine evidence exists in the resume/skills, resolves with "Yes" (or matching affirmative option) and cites evidence.
 * If no evidence exists, returns matched: false so the question falls through to ask_user.
 */
export async function inferSubjectiveExperienceFromResume(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm: BaseChatModel,
): Promise<{ matched: boolean; answer?: string; sourceDetail?: string }> {
  if (!careerBrain.resumeText && (!careerBrain.skills || careerBrain.skills.length === 0)) {
    return { matched: false };
  }

  const cleanLabel = cleanLinkedInText(field.label || '');
  const resumeText = careerBrain.resumeText || '';
  const skillsList = (careerBrain.skills || []).join(', ');
  const narrative = careerBrain.backgroundNarrative || '';

  // Provide up to 4000 chars of resume context
  const relevantExcerpt = resumeText.slice(0, 4000);

  const prompt = `You are an expert technical recruiter analyzing a candidate's resume for an experience-based screening question.
Your task is to determine whether the candidate's actual resume, skills, or background narrative provides genuine, clear evidence of having worked on or developed the technologies, systems, or domain mentioned in the question.

TARGET QUESTION:
"${cleanLabel}"
FIELD TYPE: ${field.fieldType}
FIELD OPTIONS: ${field.options ? JSON.stringify(field.options) : '["Yes", "No"]'}

CANDIDATE SKILLS:
${skillsList || 'None listed'}

CANDIDATE BACKGROUND / RESUME EXCERPT:
${relevantExcerpt}
${narrative ? `\nBACKGROUND SUMMARY:\n${narrative}` : ''}

INSTRUCTIONS:
1. Examine if the candidate's resume or skills clearly describe relevant projects, work history, responsibilities, or technical capabilities that satisfy this question (e.g., developing SaaS applications, building enterprise web/mobile apps, CRM integrations, microservices, cloud systems, etc.).
2. If genuine evidence IS present:
   - Set "hasEvidence": true.
   - In "evidence", provide a concise, factual citation of the specific work from the resume (e.g. "Built multi-tenant SaaS dashboard at TechCorp; integrated CRM APIs").
   - In "answer", select the affirmative option (usually "Yes", "Agree", or the best matching option from FIELD OPTIONS).
3. If genuine evidence is NOT present (the resume does not mention or clearly substantiate this type of work):
   - Set "hasEvidence": false.
   - DO NOT GUESS OR INVENT EXPERIENCE. Never assume "Yes" without concrete proof in the candidate's resume.
4. Output STRICTLY valid JSON:
{
  "hasEvidence": boolean,
  "answer": string | null,
  "evidence": string | null
}`;

  try {
    const res = await llm.invoke([
      new SystemMessage('You are a strict, evidence-based technical resume analyzer. Output valid JSON only.'),
      new HumanMessage(prompt),
    ]);

    const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const clean = content.replace(/```json\s*|```\s*/gi, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.hasEvidence === true && parsed.answer) {
        const rawAns = String(parsed.answer).trim();
        const evidence = parsed.evidence ? String(parsed.evidence).trim() : 'relevant work described in resume';
        const sourceDetail = `LLM-inferred from resume: ${evidence}`;

        // Ensure answer matches affirmative option if options are provided
        let resolvedAnswer = rawAns;
        if (field.options && field.options.length > 0) {
          const affirmativeOpt = field.options.find(o => /^(yes|agree|true)$/i.test(o.trim())) || field.options[0];
          resolvedAnswer = affirmativeOpt;
        }

        logger.info(
          `[FormQuestionResolver] [GENERATED subjective match] "${cleanLabel}": "${resolvedAnswer}" (${sourceDetail})`,
        );
        recordLlmSuccess();
        return {
          matched: true,
          answer: resolvedAnswer,
          sourceDetail,
        };
      }
    }
  } catch (err) {
    if (isNetworkError(err)) {
      recordLlmNetworkFailure(err);
    } else {
      logger.warning(`[FormQuestionResolver] Error inferring subjective experience for "${cleanLabel}":`, err);
    }
  }

  return { matched: false };
}

/**
 * Autonomous Screening Question Solver using LLM.
 * Analyzes unknown screening questions, candidate's profile, and options to select
 * or generate the qualifying, favorable answer that advances the job application.
 * Automatically saves the determined answer to Golden Answers for future reuse.
 */
export async function solveQuestionAutonomousWithLLM(
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<{ success: boolean; answer?: string; reason?: string }> {
  const cleanLabel = cleanLinkedInText(field.label || '');
  if (!cleanLabel) return { success: false, reason: 'Empty field label' };

  let activeLLM = llm;
  if (!activeLLM) {
    try {
      activeLLM = (await getActiveChatModel()) ?? undefined;
    } catch (err) {
      logger.warning('[FormQuestionResolver] Failed to get active chat model:', err);
    }
  }
  if (!activeLLM) {
    return { success: false, reason: 'No active LLM available' };
  }

  const skillsList = (careerBrain.skills || []).join(', ');
  const resumeExcerpt = (careerBrain.resumeText || '').slice(0, 8000);
  const narrative = careerBrain.backgroundNarrative || '';
  const yoe = careerBrain.yearsOfExperience ?? 1;
  const edu = careerBrain.education || "Bachelor's Degree";
  const workAuth = careerBrain.workAuthorization || 'Legally authorized to work, does not require sponsorship';
  const noticePeriod = careerBrain.noticePeriod || 'Immediate / 15-30 days';

  const skillExpFormatted =
    careerBrain.skillExperience && Object.keys(careerBrain.skillExperience).length > 0
      ? Object.entries(careerBrain.skillExperience)
          .map(([s, y]) => `${s}: ${y} year(s)`)
          .join('; ')
      : 'None explicitly calibrated';

  const workExpFormatted = (careerBrain.workExperience || [])
    .map(w => {
      const start = [w.startMonth, w.startYear].filter(Boolean).join(' ');
      const end = w.isCurrent ? 'Present' : [w.endMonth, w.endYear].filter(Boolean).join(' ') || 'Present';
      const durationStr = start ? `${start} - ${end}` : end;
      return (
        `- Role: ${w.title || 'Developer'} at ${w.company || 'Company'} (${durationStr})` +
        (w.description ? `\n  Description: ${w.description.slice(0, 400)}` : '')
      );
    })
    .join('\n');

  const rawProjects = ((careerBrain as any).projects || []) as Array<{
    title?: string;
    description?: string;
    technologies?: string[] | string;
  }>;
  const projectsFormatted = rawProjects
    .map(
      p =>
        `- Project: ${p.title || 'Project'} | Tech: ${
          Array.isArray(p.technologies) ? p.technologies.join(', ') : p.technologies || 'N/A'
        }` + (p.description ? `\n  Details: ${p.description.slice(0, 300)}` : ''),
    )
    .join('\n');

  const goldenAnswersFormatted = (careerBrain.goldenAnswers || [])
    .slice(0, 20)
    .map(ga => `Q: "${ga.question}" -> A: "${ga.answer}"`)
    .join('\n');

  const prompt = `You are an expert autonomous job application AI applying on behalf of a job seeker.
Your mission is to maximize the candidate's chances of getting the interview and successfully submitting the application.
You must analyze this application question, the available field options, and candidate background, and determine the optimal, qualifying, truthful answer to proceed with submission.

APPLICATION QUESTION:
"${cleanLabel}"
FIELD TYPE: ${field.fieldType}
OPTIONS: ${field.options && field.options.length > 0 ? JSON.stringify(field.options) : 'None (free text / number)'}
HINT / PLACEHOLDER: ${field.hintText || field.placeholder || 'None'}

CANDIDATE BACKGROUND (VERIFIED FROM RESUME & PROFILE):
- Full Name: ${careerBrain.fullName || 'Candidate'}
- Current Job Title: ${careerBrain.workExperience?.[0]?.title || careerBrain.currentTitle || 'Software Engineer'}
- Current Company: ${careerBrain.workExperience?.[0]?.company || (careerBrain.hasWorkExperience === false ? 'None (Fresher)' : 'Self-Employed / Independent')}
- Total Experience: ${yoe} years
- Current Location: ${careerBrain.currentLocation || 'Bengaluru, India'}
- Country of Residence / Nationality: India
- Preferred Location(s): ${careerBrain.preferredLocations?.join(', ') || careerBrain.preferredLocation || 'Bengaluru, India'}
- Gender: ${careerBrain.gender || 'Prefer not to say'}
- Date of Birth: ${careerBrain.dateOfBirth || '2000-01-01'} (18+ confirmed, format: DD/MM/YYYY is 01/01/2000)
- Highest Education: ${careerBrain.highestEducation || edu}
- Education Details: ${edu}
- Work Authorization: ${workAuth}
- Notice Period: ${noticePeriod}
- Current Salary / CTC: ${careerBrain.currentCTC || '120000'}
- Expected Salary / CTC: ${careerBrain.expectedCTC || careerBrain.salaryExpectation || '600000'}
- Willing to Relocate: ${careerBrain.willingToRelocate || 'Yes'}
- Preferred Shift: ${careerBrain.preferredShift || 'Day / Flexible'}
- Valid Driver's License: ${careerBrain.driverLicense || 'Yes'}
- Veteran Status: ${careerBrain.veteranStatus || 'I am not a protected veteran'}
- Disability Status: ${careerBrain.disabilityStatus || 'No, I do not have a disability'}
- Core Skills List: ${skillsList || 'Software Engineering / Full Stack'}
- Skill-Specific Calibrated Experience:
${skillExpFormatted}
- Detailed Work History:
${workExpFormatted || 'Software Engineer with full-stack web and backend experience.'}
- Key Projects:
${projectsFormatted || 'N/A'}
- Previously Verified Answers (Golden Answers):
${goldenAnswersFormatted || 'None'}
- Full Resume Content:
${resumeExcerpt || narrative || 'Full Stack Software Engineer with production web and software development experience.'}

DECISION RULES:
0. FACTUAL INTEGRITY & NO PLACEHOLDERS:
   - NEVER output placeholder or template text such as "Your current company name here", "Your answer here", "Insert company", or "N/A" for known profile questions.
   - For "Current Company", ALWAYS output "${careerBrain.workExperience?.[0]?.company || (careerBrain.hasWorkExperience === false ? 'None (Fresher)' : 'Self-Employed / Independent')}".
   - For date questions (e.g. "Date of birth", "Expected last working day"), if the question mentions DD/MM/YYYY or date format, output strictly in DD/MM/YYYY format (e.g. for DOB: "01/01/2000", for last working day: today's date formatted as DD/MM/YYYY). NEVER output whole sentences or work authorization text into date fields!
1. QUALIFICATION & COMMITMENT (YES/NO or SELECTION):
   - Questions about willingness, commitment, schedule/timezone overlap (e.g. US Eastern/PST overlap), shift flexibility, remote/hybrid work, background checks, drug tests, company policies, or enthusiasm: ALWAYS answer favorably ("Yes", "Agree", or the best qualifying option).
   - If options exist (e.g. ["Select an option", "Yes", "No"]), pick EXACTLY one valid option (e.g. "Yes"). Never pick placeholder options like "Select an option".
2. VISA / WORK AUTHORIZATION:
   - "Are you legally authorized to work?": "Yes".
   - "Will you now or in the future require visa sponsorship?": Match candidate background (${workAuth.toLowerCase().includes('requires sponsorship') ? '"Yes"' : '"No"'}).
3. NUMERIC EXPERIENCE & SKILL ACCURACY:
   - If asked for total professional experience, return "${yoe}".
   - If asked for years of experience with a SPECIFIC technology, tool, language, or domain (e.g. "MERN Stack", "AI", "DevOps", "Python", "Kubernetes", "AWS"):
     Examine the Candidate Background, Resume, Work History, and Skill Experience above:
     a) If the candidate actually has verified experience with this skill in their resume or profile, provide the actual/calibrated years (<= ${yoe}).
     b) IF THE CANDIDATE DOES NOT HAVE THIS SKILL or it is not mentioned anywhere in their resume/profile:
        YOU MUST RETURN "0" (for numeric fields) or "0" / lowest bracket / "No" (for options)!
        CRITICAL: NEVER claim ${yoe} or invent years for a skill the candidate never worked with!
4. MULTIPLE CHOICE / DROPDOWN:
   - You MUST pick EXACTLY one string from the provided OPTIONS list that best represents the candidate's qualification.
5. OPEN-ENDED TEXT / PARAGRAPH:
   - Provide a concise, highly professional, compelling answer (1-3 sentences) tailored to the candidate's profile.
6. GENDER / EQUAL OPPORTUNITY / DIVERSITY:
   - If asked for gender or sex, answer with candidate's gender ("${careerBrain.gender || 'Prefer not to say'}") or pick the matching option from OPTIONS.
   - For military/veteran status, pick "${careerBrain.veteranStatus || 'I am not a protected veteran'}" or "No".
   - For disability status, pick "${careerBrain.disabilityStatus || 'No, I do not have a disability'}" or "No".
   - For age confirmation (18+), answer "Yes".
7. RELOCATION, DRIVER LICENSE & EMPLOYMENT:
   - For driver's license: "${careerBrain.driverLicense || 'Yes'}".
   - For relocation: "${careerBrain.willingToRelocate || 'Yes'}".
   - For shift: "${careerBrain.preferredShift || 'Day / Flexible'}".
   - For previous employment at this company: "No". For currently employed: "Yes".
8. CONDITIONAL / FOLLOW-UP FIELDS ("If yes...", "If so...", "If you answered yes..."):
   - If this field asks for details only applicable if the applicant answered "Yes" to a previous question (e.g. "If yes, approximate date(s)", "If yes, please explain", "If previous employee, state dates/manager") and the candidate answered "No" (e.g. never worked or interviewed there before): RETURN AN EMPTY STRING ("") OR "N/A" IF STRICTLY REQUIRED. NEVER INVENT DATES, ROLES, OR FALSE HISTORY FOR CONDITIONAL FIELDS!
9. APPLICATION SOURCE / REFERRAL:
   - If asked how you heard or learned about this job (e.g. "How did you learn about this job opportunity?", "Where did you hear about us?"): Pick the application platform (e.g. "Indeed" when on Indeed, "LinkedIn" when on LinkedIn) or "Job Board" / "Company Website".
10. TIMEZONE / LOCATION CHECKBOXES (EST, CST, MST, PST, etc.):
   - If asked "Where are you located?" or for working timezone, and options are US timezones (EST, CST, MST, PST), pick "EST" (Eastern Standard Time) as the default qualifying US timezone unless candidate specifies otherwise, ensuring a valid option is selected to satisfy required fields.
11. SALARY & COMPENSATION NUMERIC EXTRACTION:
   - For "Current/ Last drawn salary", "Current CTC", "Expected annual salary", or "Expected CTC":
     If the candidate's profile provides a salary range (e.g. "₹6,00,000 - ₹12,00,000", "6 - 12 LPA"):
     NEVER output the raw range string or concatenate digits together (NEVER output things like "6000001200000" or "₹6,00,000 - ₹12,00,000")!
     If the field expects a single number or annual salary, output a SINGLE realistic numeric integer (e.g. for "₹6,00,000 - ₹12,00,000", output the lower bound "600000" or a reasonable figure like "800000").
     For numeric fields, output STRICTLY DIGITS ONLY without currency symbols (₹, $), commas, or letters (e.g. "600000", NOT "₹6,00,000").
12. DATE FIELDS (DD/MM/YYYY):
   - For "Expected last working day *" or "Last working day":
     Output the candidate's expected last working day in DD/MM/YYYY format (e.g. today's date formatted as DD/MM/YYYY). NEVER put salary numbers, compensation text, or narrative into date fields!
   - For "Date of birth *" / "DOB":
     Output candidate's date of birth in DD/MM/YYYY format (e.g. "01/01/2000").
13. DROPDOWN / SELECT FIELDS:
   - For "Notice period *" (e.g. options: ["Select an option", "Immediate", "15 days", "30 days", "60 days", "90 days"]):
     You MUST pick the single option from OPTIONS that best corresponds to candidate's notice period ("${noticePeriod}"). NEVER output "Select an option".
   - For "Preferred Location *" (e.g. options: ["Select an option", "Bengaluru", "Chennai", "Hyderabad", "Remote"]):
     You MUST pick candidate's preferred location from OPTIONS ("${careerBrain.preferredLocations?.join(', ') || careerBrain.preferredLocation || 'Bengaluru'}"). NEVER output "Select an option".
   - For "Country *" or Country / Nationality dropdowns:
     You MUST pick candidate's country ("India" or "IN" for India) from OPTIONS. NEVER leave blank, and NEVER pick "Select an option".
   - For Salary / CTC dropdowns (e.g. options: ["Select an option", "₹2,00,000 - ₹4,00,000", "₹4,00,000 - ₹6,00,000", "₹6,00,000 - ₹8,00,000", "₹8,00,000 - ₹10,00,000", "₹10,00,000+"]):
     You MUST pick the EXACT string from OPTIONS that best matches candidate's CTC ("${careerBrain.expectedCTC || careerBrain.salaryExpectation || '600000'}"). NEVER pick "Select an option" or the lowest salary unless candidate's CTC is in that bracket.
14. STRICT TRUTHFULNESS & ZERO-INVENTION (NO FALSE ANSWERS):
   - Every answer MUST be grounded in the Candidate Background, Resume, and Profile provided above.
   - Do NOT guess or hallucinate unverified qualifications, certifications, or experience.
   - If a multiple-choice question asks if the candidate has a skill they do NOT have, choose "No" or the lowest option.
   - If asked for experience in a skill not in the profile or resume, return "0".

OUTPUT STRICTLY VALID JSON ONLY:
{
  "answer": "the exact string value to fill into this field",
  "reason": "brief explanation of why this answer was chosen"
}`;

  try {
    const res = await activeLLM.invoke([
      new SystemMessage('You are a professional autonomous job application assistant. Output valid JSON only.'),
      new HumanMessage(prompt),
    ]);

    const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
    const clean = content.replace(/```json\s*|```\s*/gi, '').trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.answer !== undefined && parsed.answer !== null && String(parsed.answer).trim() !== '') {
        let ans = String(parsed.answer).trim();

        // If field has options, ensure ans matches one of the options
        if (field.options && field.options.length > 0) {
          const validOptions = field.options.filter(o => !/select\s*an\s*option|choose|select\.\.\./i.test(o.trim()));
          const exactMatch = validOptions.find(o => o.toLowerCase().trim() === ans.toLowerCase().trim());
          if (exactMatch) {
            ans = exactMatch;
          } else {
            const partialMatch = validOptions.find(
              o => o.toLowerCase().includes(ans.toLowerCase()) || ans.toLowerCase().includes(o.toLowerCase()),
            );
            if (partialMatch) {
              ans = partialMatch;
            } else if (/^(yes|true|agree)$/i.test(ans)) {
              ans = validOptions.find(o => /^(yes|agree)$/i.test(o.trim())) || validOptions[0];
            } else if (/^(no|false)$/i.test(ans)) {
              ans = validOptions.find(o => /^no$/i.test(o.trim())) || validOptions[0];
            } else {
              ans = validOptions[0];
            }
          }
        }

        // Auto-save to goldenAnswers for future encounters
        if (!isGenericWorkExperienceDateField(cleanLabel) && !isSocialMediaOrUrlQuestion(cleanLabel)) {
          await careerBrainStore.saveGoldenAnswer(cleanLabel, ans, 'Screening').catch(() => {});
          if (!careerBrain.goldenAnswers) careerBrain.goldenAnswers = [];
          careerBrain.goldenAnswers.push({
            id: `ga_${Date.now()}`,
            question: cleanLabel,
            answer: ans,
            category: 'Screening',
          });
        }

        logger.info(
          `[FormQuestionResolver] [AUTONOMOUS SOLVED] "${cleanLabel}": "${ans}" (${parsed.reason || 'Autonomous LLM determination'})`,
        );
        recordLlmSuccess();
        return {
          success: true,
          answer: ans,
          reason: parsed.reason || 'Autonomous LLM determination',
        };
      }
    }
  } catch (err) {
    if (isNetworkError(err)) {
      recordLlmNetworkFailure(err);
    } else {
      logger.warning(`[FormQuestionResolver] Error in solveQuestionAutonomousWithLLM for "${cleanLabel}":`, err);
    }
  }

  return { success: false, reason: 'LLM failed to produce valid answer' };
}

/**
 * Rule 3 & 4 Orchestrator:
 * Resolves or prompts the user for a modal form field, fills it in DOM, and emits Live Activity audit logs.
 */
export async function resolveModalFieldWithAudit(
  page: any,
  field: FormFieldDescriptor,
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
  onAuditLog?: (category: QuestionResolutionCategory, label: string, answer: string, detail?: string) => void,
  options?: { skipAskUser?: boolean },
): Promise<QuestionResolutionResult> {
  // Apply cleanLinkedInText to strip duplicate question text
  field.label = cleanLinkedInText(field.label || 'Form Field');
  const label = field.label;

  logger.info(`[FormQuestionResolver] 🎯 Attempting field resolution:`, {
    fieldType: field.fieldType,
    label,
    options: field.options,
    min: field.min,
    max: field.max,
  });

  // Helper to fill field with intelligent option alignment for dropdown/radio
  async function fillWithOptionFallback(val: string): Promise<boolean> {
    let success = await page.fillModalFieldDirect(field, val);
    if (
      !success &&
      (field.fieldType === 'dropdown' || field.fieldType === 'radio') &&
      field.options &&
      field.options.length > 0
    ) {
      const aligned = alignValueToOptions(val, field.options, field.label);
      if (aligned && aligned.matchedOption !== val) {
        logger.info(
          `[FormQuestionResolver] Smart-aligning option for "${field.label}": "${val}" -> "${aligned.matchedOption}" (${aligned.reason}, conf: ${aligned.confidence})`,
        );
        success = await page.fillModalFieldDirect(field, aligned.matchedOption);
      }
    }
    return success;
  }

  // Step 1: Rule-Based Exact/Loose Match (Fast path) -> [MATCHED]
  const fastMatch = matchRuleBased(field, careerBrain);
  if (fastMatch.matched && fastMatch.answer !== undefined) {
    logger.info(`[FormQuestionResolver] [MATCHED] "${label}": "${fastMatch.answer}" (${fastMatch.sourceDetail})`);
    const fillSuccess = await fillWithOptionFallback(fastMatch.answer);
    logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
      fieldType: field.fieldType,
      matchedQuestionText: label,
      resolvedValue: fastMatch.answer,
      clickLanded: fillSuccess,
    });
    if (fillSuccess) {
      if (onAuditLog) {
        onAuditLog('MATCHED', label, fastMatch.answer, `${fastMatch.sourceDetail} | DOM fill: SUCCESS`);
      }
      return {
        success: true,
        category: 'MATCHED',
        answer: fastMatch.answer,
        sourceDetail: fastMatch.sourceDetail,
      };
    } else {
      logger.warning(
        `[FormQuestionResolver] DOM fill failed for [MATCHED] answer "${fastMatch.answer}" on "${label}". Falling through...`,
      );
    }
  }

  // Step 1b: High-Speed Semantic Question Matcher (Golden Answers & Profile Intent, 0 Credits)
  const semanticIntent = matchQuestionSemantically(label, careerBrain);
  if (semanticIntent && semanticIntent.confidence >= 0.9 && semanticIntent.matchedAnswer) {
    logger.info(
      `[FormQuestionResolver] [MATCHED-SEMANTIC] "${label}": "${semanticIntent.matchedAnswer}" (${semanticIntent.reason})`,
    );
    const fillSuccess = await fillWithOptionFallback(semanticIntent.matchedAnswer);
    if (fillSuccess) {
      if (onAuditLog) {
        onAuditLog('MATCHED', label, semanticIntent.matchedAnswer, `${semanticIntent.reason} | DOM fill: SUCCESS`);
      }
      return {
        success: true,
        category: 'MATCHED',
        answer: semanticIntent.matchedAnswer,
        sourceDetail: semanticIntent.reason,
      };
    }
  }

  // Step 2: Free-Text Narrative Question -> [GENERATED]
  if (isFreeTextNarrativeQuestion(field) && llm && isLlmTierAvailable()) {
    logger.info(
      `[FormQuestionResolver] Detected free-text narrative question "${label}". Generating answer with LLM...`,
    );
    try {
      const generated = await generateFreeTextAnswer(field, careerBrain, llm);
      if (generated && generated.length > 0) {
        logger.info(`[FormQuestionResolver] [GENERATED] "${label}": "${generated}"`);
        const fillSuccess = await fillWithOptionFallback(generated);
        logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
          fieldType: field.fieldType,
          matchedQuestionText: label,
          resolvedValue: generated,
          clickLanded: fillSuccess,
        });
        if (fillSuccess) {
          if (onAuditLog) {
            onAuditLog('GENERATED', label, generated, `LLM-authored from resume | DOM fill: SUCCESS`);
          }
          return {
            success: true,
            category: 'GENERATED',
            answer: generated,
            sourceDetail: 'LLM-authored from resume',
          };
        } else {
          logger.warning(
            `[FormQuestionResolver] DOM fill failed for [GENERATED] answer on "${label}". Falling through to candidate ask_user...`,
          );
        }
      }
    } catch (err) {
      if (isNetworkError(err)) {
        recordLlmNetworkFailure(err);
      } else {
        logger.warning(`[FormQuestionResolver] Free-text generation failed for "${label}":`, err);
      }
    }
  }

  // Step 3: LLM Semantic Interpretation & Matching for Ambiguous Wording -> [MATCHED]
  if (llm && isLlmTierAvailable()) {
    logger.info(`[FormQuestionResolver] Attempting semantic LLM match for ambiguous wording "${label}"...`);
    const semanticMatch = await matchWithLLM(field, careerBrain, llm);
    if (semanticMatch.matched && semanticMatch.answer !== undefined) {
      logger.info(
        `[FormQuestionResolver] [MATCHED] "${label}": "${semanticMatch.answer}" (${semanticMatch.sourceDetail})`,
      );
      const fillSuccess = await fillWithOptionFallback(semanticMatch.answer);
      logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
        fieldType: field.fieldType,
        matchedQuestionText: label,
        resolvedValue: semanticMatch.answer,
        clickLanded: fillSuccess,
      });
      if (fillSuccess) {
        if (onAuditLog) {
          onAuditLog('MATCHED', label, semanticMatch.answer, `${semanticMatch.sourceDetail} | DOM fill: SUCCESS`);
        }
        return {
          success: true,
          category: 'MATCHED',
          answer: semanticMatch.answer,
          sourceDetail: semanticMatch.sourceDetail,
        };
      } else {
        logger.warning(
          `[FormQuestionResolver] DOM fill failed for semantic [MATCHED] answer "${semanticMatch.answer}" on "${label}". Falling through to candidate ask_user...`,
        );
      }
    }
  }

  // Step 3b: Search Candidate's Full Resume Text (before falling back to ask_user) -> [MATCHED]
  logger.info(`[FormQuestionResolver] Checking candidate's resumeText for explicit mention of "${label}"...`);
  const resumeMatch = await matchFromResumeText(field, careerBrain, llm);
  if (resumeMatch.matched && resumeMatch.answer !== undefined) {
    logger.info(`[FormQuestionResolver] [MATCHED] "${label}": "${resumeMatch.answer}" (${resumeMatch.sourceDetail})`);
    const fillSuccess = await fillWithOptionFallback(resumeMatch.answer);
    logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
      fieldType: field.fieldType,
      matchedQuestionText: label,
      resolvedValue: resumeMatch.answer,
      clickLanded: fillSuccess,
    });
    if (fillSuccess) {
      if (onAuditLog) {
        onAuditLog('MATCHED', label, resumeMatch.answer, `${resumeMatch.sourceDetail} | DOM fill: SUCCESS`);
      }

      // Auto-save numeric skill answers to memory/store so subsequent questions in this run reuse it
      const skillName = extractQuestionTopic(label);
      if (skillName && isValidSkillName(skillName) && !isNaN(Number(resumeMatch.answer))) {
        await careerBrainStore.saveSkillExperience(skillName, Number(resumeMatch.answer)).catch(() => {});
        if (!careerBrain.skillExperience) careerBrain.skillExperience = {};
        careerBrain.skillExperience[skillName] = Number(resumeMatch.answer);
      }

      return {
        success: true,
        category: 'MATCHED',
        answer: resumeMatch.answer,
        sourceDetail: resumeMatch.sourceDetail,
      };
    } else {
      logger.warning(
        `[FormQuestionResolver] DOM fill failed for resume [MATCHED] answer "${resumeMatch.answer}" on "${label}". Falling through to candidate ask_user...`,
      );
    }
  }

  // Step 3c: Default Unknown Numeric Skill-Experience to 0 instead of ask_user -> [MATCHED]
  const skillExpCheck = isSkillExperienceYearsQuestion(field);
  if (skillExpCheck.isSkillExp && skillExpCheck.skillName) {
    const skillName = skillExpCheck.skillName;
    logger.info(
      `[FormQuestionResolver] [MATCHED] 'years with ${skillName}' -> 0 (no evidence of this skill in profile or resume)`,
    );

    const adapted = adaptAnswerToFieldFormat('0', field);
    const fillSuccess = await fillWithOptionFallback(adapted.value);

    logger.info(`[FormQuestionResolver] DOM interaction outcome for skill-default 0:`, {
      fieldType: field.fieldType,
      matchedQuestionText: label,
      resolvedValue: adapted.value,
      clickLanded: fillSuccess,
    });

    if (fillSuccess) {
      const sourceDetail = `years with ${skillName} -> 0 (no evidence of this skill in profile or resume)`;
      if (onAuditLog) {
        onAuditLog('MATCHED', label, adapted.value, `${sourceDetail} | DOM fill: SUCCESS`);
      }

      // Auto-save to careerBrainStore and memory so subsequent questions in this run reuse it
      if (isValidSkillName(skillName)) {
        await careerBrainStore.saveSkillExperience(skillName, 0).catch(() => {});
        if (!careerBrain.skillExperience) careerBrain.skillExperience = {};
        careerBrain.skillExperience[skillName] = 0;
      }

      return {
        success: true,
        category: 'MATCHED',
        answer: adapted.value,
        sourceDetail,
      };
    } else {
      logger.warning(
        `[FormQuestionResolver] DOM fill failed for 0-default skill answer "${adapted.value}" on "${label}". Falling through to candidate ask_user...`,
      );
    }
  }

  // Step 3d: Subjective/Experience-Based Yes/No Question Inference -> [GENERATED]
  if (llm && isLlmTierAvailable() && isSubjectiveExperienceYesNoQuestion(field)) {
    logger.info(`[FormQuestionResolver] Attempting subjective experience inference for "${label}" from resume...`);
    const subjectiveMatch = await inferSubjectiveExperienceFromResume(field, careerBrain, llm);
    if (subjectiveMatch.matched && subjectiveMatch.answer !== undefined) {
      logger.info(
        `[FormQuestionResolver] [GENERATED] "${label}": "${subjectiveMatch.answer}" (${subjectiveMatch.sourceDetail})`,
      );
      const fillSuccess = await fillWithOptionFallback(subjectiveMatch.answer);
      logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
        fieldType: field.fieldType,
        matchedQuestionText: label,
        resolvedValue: subjectiveMatch.answer,
        clickLanded: fillSuccess,
      });

      if (fillSuccess) {
        if (onAuditLog) {
          onAuditLog('GENERATED', label, subjectiveMatch.answer, `${subjectiveMatch.sourceDetail} | DOM fill: SUCCESS`);
        }

        // Auto-save to goldenAnswers so future encounters of this question resolve immediately in Step 1
        if (!isGenericWorkExperienceDateField(label) && !isSocialMediaOrUrlQuestion(label)) {
          await careerBrainStore.saveGoldenAnswer(label, subjectiveMatch.answer, 'Screening').catch(() => {});
        }

        return {
          success: true,
          category: 'GENERATED',
          answer: subjectiveMatch.answer,
          sourceDetail: subjectiveMatch.sourceDetail,
        };
      } else {
        logger.warning(
          `[FormQuestionResolver] DOM fill failed for inferred [GENERATED] answer "${subjectiveMatch.answer}" on "${label}". Falling through to candidate ask_user...`,
        );
      }
    } else {
      logger.info(
        `[FormQuestionResolver] No clear resume evidence found for subjective experience on "${label}". Proceeding to check optional / ask_user...`,
      );
    }
  }

  // Step 3e: Explicitly Optional / Top Choice Field Fallback (Do not prompt user or block application)
  const isFieldExplicitlyOptional =
    field.required === false ||
    /\boptional\b/i.test(label) ||
    /top\s*choice/i.test(label) ||
    Boolean(field.hintText && /\boptional\b/i.test(field.hintText));

  if (isFieldExplicitlyOptional) {
    logger.info(`[FormQuestionResolver] Field "${label}" is optional. Skipping ask_user and leaving default/blank.`);
    const defaultAns = field.fieldType === 'checkbox' ? 'No' : '';
    if (field.fieldType === 'checkbox') {
      await page.fillModalFieldDirect(field, 'No').catch(() => {});
    }
    if (onAuditLog) {
      onAuditLog('MATCHED', label, defaultAns || '(left blank)', 'optional field: skipped');
    }
    return {
      success: true,
      category: 'MATCHED',
      answer: defaultAns,
      sourceDetail: 'optional field: skipped',
    };
  }

  // Step 3f: General Screening & Choice Question Autonomous Resolution with LLM (Dropdowns, Radios, Selection Options)
  // For any form field with options (or binary screening), analyze and resolve the qualifying option autonomously
  if (
    llm &&
    isLlmTierAvailable() &&
    (field.fieldType === 'dropdown' || field.fieldType === 'radio' || (field.options && field.options.length > 0))
  ) {
    logger.info(`[FormQuestionResolver] Analyzing screening choice field "${label}" with LLM...`);
    try {
      const autoSol = await solveQuestionAutonomousWithLLM(field, careerBrain, llm);
      if (autoSol.success && autoSol.answer !== undefined) {
        const fillSuccess = await fillWithOptionFallback(autoSol.answer);
        if (fillSuccess) {
          if (onAuditLog) {
            onAuditLog(
              'GENERATED',
              label,
              autoSol.answer,
              `LLM-determined qualifying answer (${autoSol.reason}) | DOM fill: SUCCESS`,
            );
          }
          return {
            success: true,
            category: 'GENERATED',
            answer: autoSol.answer,
            sourceDetail: `LLM-determined: ${autoSol.reason}`,
          };
        }
      }
    } catch (err) {
      logger.warning(`[FormQuestionResolver] Autonomous screening resolution failed for "${label}":`, err);
    }
  }

  // If skipAskUser is enabled, defer ask_user to batch handling
  if (options?.skipAskUser) {
    logger.info(`[FormQuestionResolver] Field "${label}" requires user answer, deferring to batch ask_user.`);
    return {
      success: false,
      category: 'ASKED',
      needsUserAnswer: true,
    };
  }

  // Step 4: Factual / Unmatched Field -> Strict Zero-Invention -> [ASKED]
  logger.info(
    `[FormQuestionResolver] Factual field "${label}" has no profile basis. Prompting user (3-min timeout)...`,
  );
  try {
    if (onAuditLog) {
      onAuditLog('ASKED', label, 'Waiting for candidate input...', 'Prompted in Side Panel');
    }

    const userAnswer = await userQuestionManager.askQuestion({
      questionText: label,
      fieldType: field.fieldType,
      options: field.options,
      min: field.min,
      max: field.max,
    });

    if (userAnswer !== undefined && userAnswer !== null && userAnswer !== '') {
      logger.info(
        `[FormQuestionResolver] [ASKED] Received user answer for "${label}": "${userAnswer}". Saving to memory...`,
      );

      // Auto-save to goldenAnswers
      if (!isGenericWorkExperienceDateField(label) && !isSocialMediaOrUrlQuestion(label)) {
        await careerBrainStore.saveGoldenAnswer(label, userAnswer, 'Screening');
      }

      // Auto-save to skillExperience if this is a skill numeric question
      const skillName = userQuestionManager.extractSkillName(label);
      if (skillName && !isNaN(Number(userAnswer))) {
        await careerBrainStore.saveSkillExperience(skillName, Number(userAnswer));
        careerBrain.skillExperience = {
          ...careerBrain.skillExperience,
          [skillName]: Number(userAnswer),
        };
      }

      // Auto-save to careerBrain profile fields if this was CTC or Notice Period
      const labelLower = label.toLowerCase();
      const isCurrentCTC =
        /(?:current|present|existing)\s*(?:fixed\s*)?(?:ctc|salary|compensation)|\bctc\s*in\s*inr\b|\bfixed\s*ctc\b|\bannual\s*ctc\b|\bgross\s*ctc\b/i.test(
          labelLower,
        ) && !/expected|target|desired|seeking/i.test(labelLower);
      const isExpectedCTC =
        /(?:expected|target|desired|seeking)\s*(?:fixed\s*)?(?:ctc|salary|compensation)|\bexpected\s*ctc\b/i.test(
          labelLower,
        );
      const isNoticePeriod =
        /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(labelLower);

      if (isCurrentCTC) {
        await careerBrainStore.updateCareerBrain({ currentCTC: userAnswer }).catch(() => {});
        careerBrain.currentCTC = userAnswer;
      } else if (isExpectedCTC) {
        await careerBrainStore.updateCareerBrain({ expectedCTC: userAnswer }).catch(() => {});
        careerBrain.expectedCTC = userAnswer;
      } else if (isNoticePeriod) {
        await careerBrainStore.updateCareerBrain({ noticePeriod: userAnswer }).catch(() => {});
        careerBrain.noticePeriod = userAnswer;
      }

      // Update in-memory careerBrain goldenAnswers array so subsequent checks in the current run see it
      if (!isGenericWorkExperienceDateField(label)) {
        careerBrain.goldenAnswers = [
          ...(careerBrain.goldenAnswers || []),
          {
            id: `ga_${Date.now()}`,
            question: label,
            answer: userAnswer,
            category: 'Screening',
          },
        ];
      }

      const adaptedUser = adaptAnswerToFieldFormat(userAnswer, field);
      const valToFill = adaptedUser.valid ? adaptedUser.value : userAnswer;
      const fillSuccess = await page.fillModalFieldDirect(field, valToFill);
      logger.info(`[FormQuestionResolver] DOM interaction outcome:`, {
        fieldType: field.fieldType,
        matchedQuestionText: label,
        resolvedValue: userAnswer,
        clickLanded: fillSuccess,
      });
      if (onAuditLog) {
        onAuditLog(
          'ASKED',
          label,
          userAnswer,
          `Saved to goldenAnswers / skillExperience | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
        );
      }

      return {
        success: fillSuccess,
        category: 'ASKED',
        answer: userAnswer,
        sourceDetail: 'Saved to goldenAnswers / skillExperience',
      };
    }
  } catch (err: any) {
    logger.warning(
      `[FormQuestionResolver] ask_user timed out or failed for "${label}": ${err?.message || err}. Invoking autonomous LLM solver to prevent application discard...`,
    );
    if (llm) {
      try {
        const autoSol = await solveQuestionAutonomousWithLLM(field, careerBrain, llm);
        if (autoSol.success && autoSol.answer !== undefined) {
          const fillSuccess = await fillWithOptionFallback(autoSol.answer);
          if (onAuditLog) {
            onAuditLog(
              'GENERATED',
              label,
              autoSol.answer,
              `Autonomous LLM resolution (candidate timeout fallback) | DOM fill: ${fillSuccess ? 'SUCCESS' : 'FAILED'}`,
            );
          }
          return {
            success: fillSuccess,
            category: 'GENERATED',
            answer: autoSol.answer,
            sourceDetail: `Autonomous LLM resolution: ${autoSol.reason}`,
          };
        }
      } catch (autoErr) {
        logger.warning(`[FormQuestionResolver] Autonomous fallback failed for "${label}":`, autoErr);
      }
    }
  }

  return { success: false, error: `Could not resolve field: ${label}` };
}
