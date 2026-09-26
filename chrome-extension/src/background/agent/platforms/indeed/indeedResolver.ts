// chrome-extension/src/background/agent/platforms/indeed/indeedResolver.ts
import type { ICareerBrain } from '@extension/storage';

export interface IIndeedAnswerResult {
  value: string;
  confidence: number;
  source: 'profile' | 'golden_answer' | 'default';
}

/**
 * Resolves screening questions commonly found in Indeed Apply forms.
 */
export function resolveIndeedQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select',
  options: string[] = [],
  careerBrain: ICareerBrain,
): IIndeedAnswerResult {
  const q = questionText.toLowerCase().trim();

  // 1. Work Authorization & Sponsorship
  if (q.includes('sponsorship') || q.includes('require sponsor') || q.includes('visa sponsor')) {
    if (options.length > 0) {
      const noOpt = options.find(o => o.toLowerCase().startsWith('no'));
      return { value: noOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'No', confidence: 0.95, source: 'profile' };
  }

  if (
    q.includes('authorized to work') ||
    q.includes('legally authorized') ||
    q.includes('work authorization') ||
    q.includes('eligible to work')
  ) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.95, source: 'profile' };
  }

  // 2. Commute & Relocation
  if (q.includes('commute') || q.includes('relocate') || q.includes('reliable transportation')) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.9, source: 'profile' };
  }

  // 3. Years of Experience (Skill or Overall)
  if (q.includes('how many years') || q.includes('years of experience') || q.includes('experience do you have')) {
    // Check specific skill
    if (careerBrain.skillExperience) {
      for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
        if (q.includes(skill.toLowerCase())) {
          if (options.length > 0) {
            const opt = options.find(o => o.includes(String(yrs)));
            return { value: opt || options[0], confidence: 0.9, source: 'profile' };
          }
          return { value: String(yrs), confidence: 0.9, source: 'profile' };
        }
      }
    }

    const yoe = String(careerBrain.yearsOfExperience ?? 0);
    if (options.length > 0) {
      const opt = options.find(o => o.includes(yoe));
      return { value: opt || options[0], confidence: 0.85, source: 'profile' };
    }
    return { value: yoe, confidence: 0.85, source: 'profile' };
  }

  // 4. Education Level
  if (q.includes('highest level of education') || q.includes('degree') || q.includes('level of education')) {
    const candidateEdu = (careerBrain.education || '').toLowerCase();
    if (options.length > 0) {
      let matched = options.find(o => {
        const lo = o.toLowerCase();
        if (candidateEdu.includes('master') && lo.includes('master')) return true;
        if (
          (candidateEdu.includes('bachelor') || candidateEdu.includes('b.tech') || candidateEdu.includes('be')) &&
          lo.includes('bachelor')
        )
          return true;
        return false;
      });
      return { value: matched || options[0], confidence: 0.85, source: 'profile' };
    }
    return { value: "Bachelor's Degree", confidence: 0.85, source: 'profile' };
  }

  // 5. Contact Info / City / Phone
  if (q.includes('phone') || q.includes('mobile')) {
    return { value: careerBrain.phoneNumber || '', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('city') || q.includes('location') || q.includes('postal') || q.includes('zip')) {
    return {
      value: careerBrain.currentLocation || careerBrain.preferredLocation || 'Remote',
      confidence: 0.9,
      source: 'profile',
    };
  }

  // 6. Golden Answers
  if (Array.isArray(careerBrain.goldenAnswers)) {
    for (const ga of careerBrain.goldenAnswers) {
      if (ga.question && q.includes(ga.question.toLowerCase())) {
        return { value: ga.answer, confidence: 0.85, source: 'golden_answer' };
      }
    }
  }

  // 7. Generic Defaults
  if (fieldType === 'number') {
    return { value: '1', confidence: 0.5, source: 'default' };
  }
  if (options.length > 0) {
    const yesOpt = options.find(o => o.toLowerCase() === 'yes' || o.toLowerCase().startsWith('yes'));
    return { value: yesOpt || options[0], confidence: 0.5, source: 'default' };
  }
  return { value: 'Yes', confidence: 0.5, source: 'default' };
}
