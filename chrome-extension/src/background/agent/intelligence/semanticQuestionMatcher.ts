import { type ICareerBrain, findBestMatchingGoldenAnswer } from '@extension/storage';

export type QuestionIntent =
  | 'WORK_AUTHORIZATION'
  | 'VISA_SPONSORSHIP'
  | 'NOTICE_PERIOD'
  | 'CURRENT_CTC'
  | 'EXPECTED_CTC'
  | 'WILLING_TO_RELOCATE'
  | 'WORK_MODE'
  | 'IMMEDIATE_JOINING'
  | 'BACKGROUND_CHECK'
  | 'HIGHEST_EDUCATION'
  | 'COMMUTE'
  | 'SKILL_EXPERIENCE'
  | 'CUSTOM_SCREENING';

export interface ISemanticMatchResult {
  intent: QuestionIntent;
  confidence: number;
  extractedSkill?: string;
  matchedAnswer?: string;
  source: 'profile' | 'golden_answer' | 'computed';
  reason: string;
}

/**
 * Normalizes question text to its fundamental semantic core.
 */
export function normalizeQuestionText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[?*!.:,;'"()[\]{}_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects the core intent of any screening question across LinkedIn, Indeed, and Naukri.
 */
export function detectQuestionIntent(questionText: string): { intent: QuestionIntent; extractedSkill?: string } {
  const norm = normalizeQuestionText(questionText);

  // 1. Work Authorization & Visa Sponsorship
  if (/sponsorship|sponsor\b|visa\s*support|require\s*(?:a\s*)?visa/i.test(norm)) {
    return { intent: 'VISA_SPONSORSHIP' };
  }
  if (
    /authorized\s*to\s*work|work\s*authorization|legally\s*authorized|eligible\s*to\s*work|legal\s*right\s*to\s*work|right\s*to\s*work/i.test(
      norm,
    )
  ) {
    return { intent: 'WORK_AUTHORIZATION' };
  }

  // 2. Notice Period & Availability
  if (/immediate(?:ly)?\s*(?:join|start|available)|start\s*immediately|join\s*immediately/i.test(norm)) {
    return { intent: 'IMMEDIATE_JOINING' };
  }
  if (
    /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time|days\s*to\s*join|notice\s*duration/i.test(
      norm,
    )
  ) {
    return { intent: 'NOTICE_PERIOD' };
  }

  // 3. Compensation & CTC
  if (
    /(?:expected|target|desired|seeking)\s*(?:fixed\s*)?(?:ctc|salary|compensation|package)|\bexpected\s*ctc\b|\bsalary\s*expectation\b/i.test(
      norm,
    )
  ) {
    return { intent: 'EXPECTED_CTC' };
  }
  if (
    /(?:current|present|existing)\s*(?:fixed\s*)?(?:ctc|salary|compensation|package)|\bcurrent\s*ctc\b|\bfixed\s*ctc\b|\bannual\s*ctc\b/i.test(
      norm,
    )
  ) {
    return { intent: 'CURRENT_CTC' };
  }

  // 4. Relocation & Work Mode
  if (/willing\s*to\s*relocate|open\s*to\s*relocat|ready\s*to\s*relocat|comfortable\s*relocat|relocation/i.test(norm)) {
    return { intent: 'WILLING_TO_RELOCATE' };
  }
  if (/work\s*from\s*office|hybrid|on\s*site|remote\s*or\s*hybrid|office\s*based|in\s*person/i.test(norm)) {
    return { intent: 'WORK_MODE' };
  }

  // 5. Commute & Background Check
  if (/commute|travel\s*to\s*office|commute\s*to\s*(?:the\s*)?location/i.test(norm)) {
    return { intent: 'COMMUTE' };
  }
  if (/background\s*(?:check|verification|investigation)|bgv\b|consent\s*to\s*verification/i.test(norm)) {
    return { intent: 'BACKGROUND_CHECK' };
  }

  // 6. Education
  if (
    /highest\s*(?:level\s*of\s*)?education|highest\s*degree|qualification\s*level|highest\s*qualification/i.test(norm)
  ) {
    return { intent: 'HIGHEST_EDUCATION' };
  }

  // 7. Skill Experience extraction e.g. "How many years of experience do you have in React?"
  const skillMatch = norm.match(
    /(?:years|experience)\s*(?:of\s*)?(?:hands\s*on\s*)?(?:experience\s*)?(?:with|in|using)\s+([a-z0-9#+.\s-]+?)(?:\s+do\s+you\s+have|\s*\?|$)/i,
  );
  if (skillMatch && skillMatch[1]) {
    const rawSkill = skillMatch[1].trim();
    if (rawSkill.length >= 2 && rawSkill.length <= 30) {
      return { intent: 'SKILL_EXPERIENCE', extractedSkill: rawSkill };
    }
  }

  return { intent: 'CUSTOM_SCREENING' };
}

/**
 * High-Speed Semantic Question Matcher
 * Resolves questions against Candidate Career Brain & Golden Answers at 0 LLM cost.
 */
export function matchQuestionSemantically(
  questionText: string,
  careerBrain: ICareerBrain,
): ISemanticMatchResult | null {
  const { intent, extractedSkill } = detectQuestionIntent(questionText);

  // Check Golden Answers first using smart semantic matching
  if (Array.isArray(careerBrain.goldenAnswers)) {
    const validGolden = careerBrain.goldenAnswers.filter(ga => ga && ga.question && ga.answer);
    const bestMatch = findBestMatchingGoldenAnswer(questionText, validGolden);
    if (bestMatch.matched && bestMatch.goldenAnswer) {
      return {
        intent,
        confidence: bestMatch.similarity,
        matchedAnswer: bestMatch.goldenAnswer.answer,
        source: 'golden_answer',
        reason: `Semantic match with saved Golden Answer: "${bestMatch.goldenAnswer.question}" (${bestMatch.reason})`,
      };
    }
  }

  // Fallback to profile attributes based on semantic intent
  switch (intent) {
    case 'WORK_AUTHORIZATION':
      return {
        intent,
        confidence: 0.96,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Legally authorized to work in candidate country',
      };

    case 'VISA_SPONSORSHIP':
      return {
        intent,
        confidence: 0.96,
        matchedAnswer: 'No',
        source: 'profile',
        reason: 'Candidate does not require visa sponsorship',
      };

    case 'NOTICE_PERIOD': {
      const np = careerBrain.noticePeriod || 'Immediate';
      return {
        intent,
        confidence: 0.95,
        matchedAnswer: np,
        source: 'profile',
        reason: `Matched candidate notice period: "${np}"`,
      };
    }

    case 'CURRENT_CTC': {
      const ctc = careerBrain.currentCTC || careerBrain.salaryExpectation || '';
      if (ctc) {
        return {
          intent,
          confidence: 0.94,
          matchedAnswer: ctc,
          source: 'profile',
          reason: `Matched candidate current CTC: "${ctc}"`,
        };
      }
      break;
    }

    case 'EXPECTED_CTC': {
      const ctc = careerBrain.expectedCTC || careerBrain.salaryExpectation || '';
      if (ctc) {
        return {
          intent,
          confidence: 0.94,
          matchedAnswer: ctc,
          source: 'profile',
          reason: `Matched candidate expected CTC: "${ctc}"`,
        };
      }
      break;
    }

    case 'WILLING_TO_RELOCATE':
      return {
        intent,
        confidence: 0.92,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Candidate willing to relocate for relevant roles',
      };

    case 'WORK_MODE':
      return {
        intent,
        confidence: 0.92,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Flexible with hybrid/on-site working arrangements',
      };

    case 'IMMEDIATE_JOINING':
      return {
        intent,
        confidence: 0.94,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Available to start immediately',
      };

    case 'BACKGROUND_CHECK':
      return {
        intent,
        confidence: 0.98,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Consent to standard background check',
      };

    case 'HIGHEST_EDUCATION': {
      const edu = careerBrain.highestEducation || careerBrain.education || "Bachelor's Degree";
      return {
        intent,
        confidence: 0.92,
        matchedAnswer: edu,
        source: 'profile',
        reason: `Extracted highest education: "${edu}"`,
      };
    }

    case 'COMMUTE':
      return {
        intent,
        confidence: 0.95,
        matchedAnswer: 'Yes',
        source: 'profile',
        reason: 'Comfortable with daily commute',
      };

    case 'SKILL_EXPERIENCE': {
      if (extractedSkill && careerBrain.skillExperience) {
        const normSkill = extractedSkill.toLowerCase();
        for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
          if (normSkill.includes(skill.toLowerCase()) || skill.toLowerCase().includes(normSkill)) {
            return {
              intent,
              confidence: 0.95,
              extractedSkill: skill,
              matchedAnswer: String(yrs),
              source: 'profile',
              reason: `Matched skill experience for ${skill}: ${yrs} years`,
            };
          }
        }
      }
      // If skill not explicitly listed, fallback to candidate total years of experience
      const defaultYrs = careerBrain.yearsOfExperience ?? 3;
      return {
        intent,
        confidence: 0.82,
        extractedSkill,
        matchedAnswer: String(defaultYrs),
        source: 'computed',
        reason: `Inferred experience from overall profile: ${defaultYrs} years`,
      };
    }
  }

  return null;
}
