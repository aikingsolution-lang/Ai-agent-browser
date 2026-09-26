// chrome-extension/src/background/agent/platforms/naukri/naukriResolver.ts
import type { ICareerBrain } from '@extension/storage';

export interface INaukriAnswerResult {
  value: string;
  confidence: number;
  source: 'profile' | 'golden_answer' | 'default';
}

/**
 * Resolves a field or question on Naukri using candidate's Career Brain.
 */
export function resolveNaukriQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select',
  options: string[] = [],
  careerBrain: ICareerBrain,
): INaukriAnswerResult {
  const q = questionText.toLowerCase().trim();

  // 1. Notice Period
  if (q.includes('notice') || q.includes('joining') || q.includes('how soon') || q.includes('availability')) {
    const candidateNotice = (careerBrain.noticePeriod || 'Immediate').toLowerCase();

    if (options.length > 0) {
      // Find matching option
      let bestMatch = options[0];
      for (const opt of options) {
        const lowerOpt = opt.toLowerCase();
        if (
          candidateNotice.includes('immediate') &&
          (lowerOpt.includes('immediate') || lowerOpt.includes('15') || lowerOpt.includes('0'))
        ) {
          bestMatch = opt;
          break;
        }
        if ((candidateNotice.includes('15') || candidateNotice.includes('immediate')) && lowerOpt.includes('15')) {
          bestMatch = opt;
          break;
        }
        if (candidateNotice.includes('30') || candidateNotice.includes('1 month')) {
          if (lowerOpt.includes('30') || lowerOpt.includes('1 month')) {
            bestMatch = opt;
            break;
          }
        }
        if (candidateNotice.includes('60') || candidateNotice.includes('2 month')) {
          if (lowerOpt.includes('60') || lowerOpt.includes('2 month')) {
            bestMatch = opt;
            break;
          }
        }
        if (candidateNotice.includes('90') || candidateNotice.includes('3 month')) {
          if (lowerOpt.includes('90') || lowerOpt.includes('3 month')) {
            bestMatch = opt;
            break;
          }
        }
      }
      return { value: bestMatch, confidence: 0.95, source: 'profile' };
    }

    return { value: careerBrain.noticePeriod || 'Immediate', confidence: 0.9, source: 'profile' };
  }

  // 2. Current CTC / Salary
  if (
    q.includes('current ctc') ||
    q.includes('current annual') ||
    q.includes('current salary') ||
    (q.includes('current') && q.includes('ctc'))
  ) {
    const ctc = careerBrain.currentCTC || careerBrain.salaryExpectation || '0';
    const numericCtc = ctc.replace(/[^0-9.]/g, '');
    return { value: numericCtc || '0', confidence: 0.9, source: 'profile' };
  }

  // 3. Expected CTC / Salary
  if (
    q.includes('expected ctc') ||
    q.includes('expected annual') ||
    q.includes('expected salary') ||
    (q.includes('expected') && q.includes('ctc')) ||
    q.includes('salary expectation')
  ) {
    const expCtc = careerBrain.expectedCTC || careerBrain.salaryExpectation || '0';
    const numericCtc = expCtc.replace(/[^0-9.]/g, '');
    return { value: numericCtc || '0', confidence: 0.9, source: 'profile' };
  }

  // 4. Total Experience / Years of experience
  if (
    q.includes('total experience') ||
    q.includes('overall experience') ||
    (q.includes('experience') && (q.includes('years') || q.includes('yoe')))
  ) {
    const yoe = String(careerBrain.yearsOfExperience ?? 0);
    if (options.length > 0) {
      // Find matching range in options e.g. "0-1 Years", "1-3 Years"
      const num = careerBrain.yearsOfExperience ?? 0;
      const matched = options.find(opt => {
        const optLower = opt.toLowerCase();
        if (num === 0 && (optLower.includes('fresher') || optLower.includes('0'))) return true;
        return optLower.includes(String(num));
      });
      return { value: matched || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: yoe, confidence: 0.95, source: 'profile' };
  }

  // 5. Current Location / City
  if (q.includes('current location') || q.includes('current city') || q.includes('where do you live')) {
    const loc = careerBrain.currentLocation || careerBrain.preferredLocation || 'Bengaluru';
    return { value: loc, confidence: 0.9, source: 'profile' };
  }

  // 6. Skill Experience (e.g. "How many years in React?")
  if (careerBrain.skillExperience) {
    for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
      if (q.includes(skill.toLowerCase())) {
        return { value: String(yrs), confidence: 0.9, source: 'profile' };
      }
    }
  }

  // 7. Golden answers fallback
  if (Array.isArray(careerBrain.goldenAnswers)) {
    for (const ga of careerBrain.goldenAnswers) {
      if (ga.question && q.includes(ga.question.toLowerCase())) {
        return { value: ga.answer, confidence: 0.85, source: 'golden_answer' };
      }
    }
  }

  // 8. Default fallback
  if (fieldType === 'number') {
    return { value: '0', confidence: 0.5, source: 'default' };
  }
  if (options.length > 0) {
    return { value: options[0], confidence: 0.5, source: 'default' };
  }
  return { value: 'Yes', confidence: 0.5, source: 'default' };
}
