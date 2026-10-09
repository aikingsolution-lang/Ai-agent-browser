import { type ICareerBrain, parseLocationParts } from '@extension/storage';
import { alignValueToOptions, matchQuestionSemantically } from '../../intelligence';

export interface INaukriAnswerResult {
  value: string;
  confidence: number;
  source: 'profile' | 'golden_answer' | 'default';
}

/**
 * Matches a numeric value (e.g. years of experience, CTC) against option strings,
 * supporting ranges ("3-5"), thresholds ("6+", "more than 6"), and bounds ("Less than 6", "up to 5").
 */
export function matchNumericRangeOption(num: number, options: string[]): string | undefined {
  if (!options || options.length === 0) return undefined;

  // 1. Fresher / 0 check
  if (num === 0) {
    const fresherOpt = options.find(o => {
      const lo = o.toLowerCase();
      return lo.includes('fresher') || lo.includes('0 year') || lo === '0' || lo.includes('< 1');
    });
    if (fresherOpt) return fresherOpt;
  }

  // 2. Range match: "1-3", "3 - 5", "3 to 5"
  for (const opt of options) {
    const rangeMatch = opt.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
    if (rangeMatch) {
      const min = parseFloat(rangeMatch[1]);
      const max = parseFloat(rangeMatch[2]);
      if (!isNaN(min) && !isNaN(max) && num >= min && num <= max) {
        return opt;
      }
    }
  }

  // 3. Less than / Under / Below / Up to: "Less than 6", "< 6", "under 5"
  for (const opt of options) {
    const lessMatch = opt.match(/(?:less\s+than|under|below|fewer\s+than|upto|up\s+to|<)\s*(\d+(?:\.\d+)?)/i);
    if (lessMatch) {
      const limit = parseFloat(lessMatch[1]);
      if (!isNaN(limit)) {
        const isUpTo = /upto|up\s+to|<=\s*/i.test(opt);
        if (isUpTo ? num <= limit : num < limit) {
          return opt;
        }
      }
    }
  }

  // 4. Greater than / Plus: "6+", "6 +", "more than 6", "above 5"
  for (const opt of options) {
    const plusMatch = opt.match(/(\d+(?:\.\d+)?)\s*\+/);
    if (plusMatch) {
      const min = parseFloat(plusMatch[1]);
      if (!isNaN(min) && num >= min) {
        return opt;
      }
    }
    const greaterMatch = opt.match(/(?:more\s+than|greater\s+than|above|>)\s*(\d+(?:\.\d+)?)/i);
    if (greaterMatch) {
      const min = parseFloat(greaterMatch[1]);
      if (!isNaN(min) && num > min) {
        return opt;
      }
    }
  }

  // 5. Exact word match e.g. "3", "3 years"
  for (const opt of options) {
    const regex = new RegExp(`\\b${num}\\b`);
    if (regex.test(opt)) {
      return opt;
    }
  }

  return undefined;
}

/**
 * Resolves a field or question on Naukri using candidate's Career Brain.
 */
export function resolveNaukriQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox',
  options: string[] = [],
  careerBrain: ICareerBrain,
  placeholder: string = '',
): INaukriAnswerResult {
  const q = questionText.toLowerCase().trim();
  const p = placeholder.toLowerCase().trim();
  const combined = `${q} ${p}`.trim();

  const isLakhsPrompt =
    combined.includes('in lac') ||
    combined.includes('in lakh') ||
    combined.includes('lacs per annum') ||
    combined.includes('lakhs per annum') ||
    combined.includes('lpa') ||
    combined.includes('lakhs') ||
    combined.includes('lacs');

  // 1. High-speed semantic matcher
  const semantic = matchQuestionSemantically(questionText, careerBrain);
  if (semantic && semantic.confidence >= 0.88 && semantic.matchedAnswer) {
    let finalVal = semantic.matchedAnswer;
    if (isLakhsPrompt) {
      const numeric = Number(finalVal.replace(/[^0-9.]/g, ''));
      if (numeric >= 1000) {
        finalVal = String(Number((numeric / 100000).toFixed(2))).replace(/\.00$/, '');
      } else if (numeric > 0) {
        finalVal = String(numeric);
      }
    }
    const isDaysPrompt =
      fieldType === 'number' ||
      combined.includes('in days') ||
      combined.includes('(days)') ||
      combined.includes('days');

    if (
      isDaysPrompt &&
      (combined.includes('notice') || combined.includes('joining') || combined.includes('availability'))
    ) {
      const num = finalVal.replace(/[^0-9]/g, '');
      if (num) {
        finalVal = num;
      } else if (finalVal.toLowerCase().includes('immediate')) {
        finalVal = '0';
      }
    }
    if (options.length > 0) {
      const aligned = alignValueToOptions(finalVal, options, questionText);
      if (aligned) finalVal = aligned.matchedOption;
    }
    return {
      value: finalVal,
      confidence: semantic.confidence,
      source: semantic.source === 'golden_answer' ? 'golden_answer' : 'profile',
    };
  }

  // 1. Notice Period
  if (
    combined.includes('notice') ||
    combined.includes('joining') ||
    combined.includes('how soon') ||
    combined.includes('availability')
  ) {
    const candidateNotice = (careerBrain.noticePeriod || 'Immediate').toLowerCase();
    const isDaysRequest =
      fieldType === 'number' ||
      combined.includes('in days') ||
      combined.includes('(days)') ||
      combined.includes('days');

    let numericDays = '0';
    if (candidateNotice.includes('15')) numericDays = '15';
    else if (candidateNotice.includes('30') || candidateNotice.includes('1 month')) numericDays = '30';
    else if (candidateNotice.includes('60') || candidateNotice.includes('2 month')) numericDays = '60';
    else if (candidateNotice.includes('90') || candidateNotice.includes('3 month')) numericDays = '90';

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

    if (isDaysRequest) {
      return { value: numericDays, confidence: 0.95, source: 'profile' };
    }

    return { value: careerBrain.noticePeriod || 'Immediate', confidence: 0.9, source: 'profile' };
  }

  // 2. Current CTC / Salary
  if (
    combined.includes('current ctc') ||
    combined.includes('current annual') ||
    combined.includes('current salary') ||
    combined.includes('in-hand salary') ||
    (combined.includes('current') &&
      (combined.includes('ctc') || combined.includes('salary') || combined.includes('p/m'))) ||
    (combined.includes('ctc') && (isLakhsPrompt || combined.includes('per annum')))
  ) {
    const ctc = careerBrain.currentCTC || careerBrain.salaryExpectation || '';
    const numericCtc = ctc ? Number(ctc.replace(/[^0-9.]/g, '')) : 0;
    const isMonthly =
      combined.includes('p/m') ||
      combined.includes('per month') ||
      combined.includes('monthly') ||
      combined.includes('in-hand');

    let val = '';
    if (numericCtc > 0) {
      if (isMonthly) {
        val = String(Math.round(numericCtc / 12));
      } else if (isLakhsPrompt) {
        if (numericCtc >= 1000) {
          val = String(Number((numericCtc / 100000).toFixed(2))).replace(/\.00$/, '');
        } else {
          val = String(numericCtc);
        }
      } else {
        val = String(numericCtc);
      }
    }

    if (options.length > 0 && val) {
      const aligned = alignValueToOptions(val, options, questionText);
      if (aligned) val = aligned.matchedOption;
    }

    if (!val) {
      return { value: '', confidence: 0.2, source: 'default' };
    }

    return { value: val, confidence: 0.95, source: 'profile' };
  }

  // 3. Expected CTC / Salary
  if (
    combined.includes('expected ctc') ||
    combined.includes('expected annual') ||
    combined.includes('expected salary') ||
    (combined.includes('expected') &&
      (combined.includes('ctc') || combined.includes('salary') || combined.includes('p/m'))) ||
    combined.includes('salary expectation')
  ) {
    const expCtc = careerBrain.expectedCTC || careerBrain.salaryExpectation || '';
    const numericCtc = expCtc ? Number(expCtc.replace(/[^0-9.]/g, '')) : 0;
    const isMonthly = combined.includes('p/m') || combined.includes('per month') || combined.includes('monthly');

    let val = '';
    if (numericCtc > 0) {
      if (isMonthly) {
        val = String(Math.round(numericCtc / 12));
      } else if (isLakhsPrompt) {
        if (numericCtc >= 1000) {
          val = String(Number((numericCtc / 100000).toFixed(2))).replace(/\.00$/, '');
        } else {
          val = String(numericCtc);
        }
      } else {
        val = String(numericCtc);
      }
    }

    if (options.length > 0 && val) {
      const aligned = alignValueToOptions(val, options, questionText);
      if (aligned) val = aligned.matchedOption;
    }

    if (!val) {
      return { value: '', confidence: 0.2, source: 'default' };
    }

    return { value: val, confidence: 0.95, source: 'profile' };
  }

  // 4. Total Experience / Years of experience / Skill experience (e.g. "How many years of experience do you have in Aws Devops?")
  if (
    q.includes('total experience') ||
    q.includes('overall experience') ||
    q.includes('total year') ||
    q.includes('experiance') ||
    (q.includes('experience') && (q.includes('years') || q.includes('yoe') || q.includes('how many'))) ||
    /\b(?:total|overall)?\s*experi[ea]nce\b/i.test(q)
  ) {
    let expYears = careerBrain.yearsOfExperience ?? 1;

    // Check if question asks about a specific skill in skillExperience
    if (careerBrain.skillExperience) {
      for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
        const sLower = skill.toLowerCase();
        if (
          q.includes(sLower) ||
          (sLower.includes('aws') && q.includes('aws')) ||
          (sLower.includes('devops') && q.includes('devops'))
        ) {
          expYears = Number(yrs);
          break;
        }
      }
    }

    if (options.length > 0) {
      const matched = matchNumericRangeOption(expYears, options);
      if (matched) {
        return { value: matched, confidence: 0.95, source: 'profile' };
      }
      const aligned = alignValueToOptions(String(expYears), options, questionText);
      return { value: aligned ? aligned.matchedOption : options[0], confidence: 0.85, source: 'profile' };
    }

    return { value: String(expYears), confidence: 0.95, source: 'profile' };
  }

  // 5. Current / Preferred Location (with Priority 1 > Priority 2 > Priority 3)
  if (
    q.includes('current location') ||
    q.includes('preferred location') ||
    q.includes('current city') ||
    q.includes('where do you live') ||
    q.includes('location')
  ) {
    const prefList =
      Array.isArray(careerBrain.preferredLocations) && careerBrain.preferredLocations.length > 0
        ? careerBrain.preferredLocations
        : [careerBrain.preferredLocation || careerBrain.currentLocation || 'Bengaluru, Karnataka, India'];

    if (options.length > 0) {
      for (let pIdx = 0; pIdx < prefList.length; pIdx++) {
        const pref = prefList[pIdx];
        if (!pref) continue;
        const prefLo = pref.toLowerCase();
        const parts = parseLocationParts(pref);
        const matched = options.find(opt => {
          const oLo = opt.toLowerCase();
          return (
            prefLo.includes(oLo) ||
            oLo.includes(prefLo) ||
            (parts.city && oLo.includes(parts.city.toLowerCase())) ||
            (parts.state && oLo.includes(parts.state.toLowerCase()))
          );
        });
        if (matched) {
          return { value: matched, confidence: 0.95 - pIdx * 0.05, source: 'profile' };
        }
      }
      return { value: options[0], confidence: 0.5, source: 'profile' };
    }
    const loc = prefList[0] || 'Bengaluru, Karnataka, India';
    return { value: loc, confidence: 0.9, source: 'profile' };
  }

  // 6. Skill Experience (e.g. "How many years in React?")
  if (careerBrain.skillExperience) {
    for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
      if (q.includes(skill.toLowerCase())) {
        const numYrs = Number(yrs);
        if (options.length > 0) {
          const matched = matchNumericRangeOption(numYrs, options);
          if (matched) return { value: matched, confidence: 0.95, source: 'profile' };
          const aligned = alignValueToOptions(String(yrs), options, questionText);
          return { value: aligned ? aligned.matchedOption : options[0], confidence: 0.85, source: 'profile' };
        }
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
  const fallbackVal = fieldType === 'number' ? '0' : 'Yes';
  if (options.length > 0) {
    const aligned = alignValueToOptions(fallbackVal, options, questionText);
    return {
      value: aligned ? aligned.matchedOption : options[0],
      confidence: 0.5,
      source: 'default',
    };
  }
  return { value: fallbackVal, confidence: 0.5, source: 'default' };
}
