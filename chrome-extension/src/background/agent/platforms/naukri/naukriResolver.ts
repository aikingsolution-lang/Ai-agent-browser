import { type ICareerBrain, parseLocationParts } from '@extension/storage';
import { alignValueToOptions, matchQuestionSemantically } from '../../intelligence';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

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
    let effNumericCtc = numericCtc;
    let resolvedConfidence = 0.95;
    let resolvedSource: 'profile' | 'default' = 'profile';

    if (effNumericCtc <= 0) {
      const yoe = careerBrain.yearsOfExperience ?? 3;
      const defaultLakhs = Math.max(5, Math.round(yoe * 3.5));
      effNumericCtc = defaultLakhs * 100000;
      resolvedConfidence = 0.85;
      resolvedSource = 'default';
    }

    if (isMonthly) {
      val = String(Math.round(effNumericCtc / 12));
    } else if (isLakhsPrompt) {
      if (effNumericCtc >= 1000) {
        val = String(Number((effNumericCtc / 100000).toFixed(2))).replace(/\.00$/, '');
      } else {
        val = String(effNumericCtc);
      }
    } else {
      val = String(effNumericCtc);
    }

    if (options.length > 0 && val) {
      const aligned = alignValueToOptions(val, options, questionText);
      if (aligned) val = aligned.matchedOption;
    }

    if (!val) {
      return { value: '10', confidence: 0.5, source: 'default' };
    }

    return { value: val, confidence: resolvedConfidence, source: resolvedSource };
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

/**
 * Uses LLM to answer questionnaire and screening questions on Naukri.com,
 * ensuring answers are strictly 1 word, 1 number, or an exact choice option,
 * with intelligent Lakhs conversion and option alignment.
 */
export async function resolveNaukriWithLLM(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox',
  options: string[] = [],
  careerBrain: ICareerBrain,
  llm: BaseChatModel,
  placeholder: string = '',
): Promise<{ success: boolean; answer: string }> {
  try {
    const qLower = questionText.toLowerCase();
    const isLakhsPrompt =
      qLower.includes('in lac') ||
      qLower.includes('in lakh') ||
      qLower.includes('lacs per annum') ||
      qLower.includes('lakhs per annum') ||
      qLower.includes('lpa') ||
      qLower.includes('lakhs') ||
      qLower.includes('lacs');

    const yoe = careerBrain.yearsOfExperience ?? 3;
    const defaultCtcLakhs = Math.max(3, Math.round(yoe * 2.5));
    const currentCtc = careerBrain.currentCTC || `${defaultCtcLakhs * 100000}`;
    const expectedCtc =
      careerBrain.expectedCTC || careerBrain.salaryExpectation || `${Math.round(defaultCtcLakhs * 1.5) * 100000}`;

    const systemPrompt = `You are an expert autonomous job application AI applying on Naukri.com.
Answer the recruiter's question accurately based on the candidate's profile.

RULES FOR THE OUTPUT:
1. OUTPUT FORMAT: Output ONLY the concise final answer — exactly ONE WORD, ONE NUMBER, or ONE EXACT OPTION from the options list.
   - NEVER output sentences, explanations, conversational filler, quotes, or markdown.
   - For radio / checkbox / dropdown options: Pick the EXACT matching option text from the provided OPTIONS list that qualifies the candidate best.
2. CTC / SALARY IN LAKHS:
   - If the question asks for CTC "in Lacs" or "in Lakhs" (e.g. "What is your current CTC in Lacs per annum?"):
     Output strictly the single numeric figure in Lakhs (e.g. "7" or "8" or "6.5"). NEVER output 700000 or full currency numbers!
3. EXPERIENCE:
   - For years of experience (total or skill-specific like AWS, DevOps), output only the numeric years (e.g. "${yoe}").
   - If options exist (e.g. ["6+", "Less than 6"]), choose the option matching the candidate.
4. NOTICE PERIOD:
   - If asking for days, output digits (e.g. "15" or "0"). Otherwise output "15 Days" or "Immediate".
5. QUALIFYING COMMITMENT:
   - For willingness to relocate, background check, shift flexibility, or mandatory requirements, always pick "Yes" or favorable choice.`;

    const userPrompt = `QUESTION: "${questionText}"
FIELD TYPE: ${fieldType}
OPTIONS: ${options.length > 0 ? JSON.stringify(options) : 'None (free text / number)'}
PLACEHOLDER: "${placeholder}"

CANDIDATE PROFILE:
- Full Name: ${careerBrain.fullName || 'Candidate'}
- Current Title: ${careerBrain.currentTitle || 'DevOps Engineer / Software Engineer'}
- Years of Experience: ${yoe}
- Current CTC: ${currentCtc}
- Expected CTC: ${expectedCtc}
- Notice Period: ${careerBrain.noticePeriod || '15 Days'}
- Location: ${careerBrain.currentLocation || 'Bengaluru, India'}
- Preferred Locations: ${careerBrain.preferredLocations?.join(', ') || careerBrain.preferredLocation || 'Bengaluru, Hyderabad, Remote'}
- Skills: ${(careerBrain.skills || []).join(', ') || 'AWS, DevOps, Docker, Kubernetes, CI/CD, Python'}
- Skill Experience: ${careerBrain.skillExperience ? JSON.stringify(careerBrain.skillExperience) : 'N/A'}
- Resume Summary: ${(careerBrain.resumeText || '').slice(0, 1500)}

FINAL ANSWER (one word, one number, or exact option):`;

    const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

    let raw = response.content.toString().trim();
    // Clean markdown, quotes, trailing punctuation
    raw = raw
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/\n.*$/s, '')
      .trim();

    // If options are provided, align strictly to one of the options
    if (options.length > 0) {
      const aligned = alignValueToOptions(raw, options, questionText);
      if (aligned) {
        return { success: true, answer: aligned.matchedOption };
      }
      const matched = options.find(
        o => o.toLowerCase() === raw.toLowerCase() || o.toLowerCase().includes(raw.toLowerCase()),
      );
      if (matched) {
        return { success: true, answer: matched };
      }
      return { success: true, answer: options[0] };
    }

    // If question asks for CTC in Lakhs, sanitize to pure Lakhs number
    if (isLakhsPrompt) {
      const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
      if (numMatch) {
        let num = parseFloat(numMatch[1]);
        if (num >= 1000) {
          num = Number((num / 100000).toFixed(2));
        }
        return { success: true, answer: String(num).replace(/\.00$/, '') };
      }
      return { success: true, answer: String(defaultCtcLakhs) };
    }

    // If fieldType is number, sanitize to digits only
    if (fieldType === 'number') {
      const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
      if (numMatch) {
        return { success: true, answer: numMatch[1] };
      }
    }

    return { success: true, answer: raw };
  } catch {
    return { success: false, answer: '' };
  }
}
