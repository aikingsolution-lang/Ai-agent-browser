// chrome-extension/src/background/agent/platforms/indeed/indeedResolver.ts
import type { ICareerBrain } from '@extension/storage';

export interface IIndeedAnswerResult {
  value: string;
  confidence: number;
  source: 'profile' | 'golden_answer' | 'default';
}

/**
 * Resolves screening questions and form fields commonly found in Indeed Apply forms.
 */
export function resolveIndeedQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox',
  options: string[] = [],
  careerBrain: ICareerBrain,
): IIndeedAnswerResult {
  const q = questionText.toLowerCase().trim();

  // Primary work experience helper
  const primaryExp =
    Array.isArray(careerBrain.workExperience) && careerBrain.workExperience.length > 0
      ? careerBrain.workExperience.find(item => item.isCurrent) || careerBrain.workExperience[0]
      : null;

  // 0. Consent, Policy, Terms, Acknowledgment & Equal Opportunity
  if (
    q.includes('consent') ||
    q.includes('agree') ||
    q.includes('policy') ||
    q.includes('terms') ||
    q.includes('acknowledge') ||
    q.includes('confirm') ||
    q.includes('disclaimer') ||
    q.includes('equal opportunity') ||
    q.includes('code of conduct')
  ) {
    if (options.length > 0) {
      const consentOpt = options.find(
        o =>
          o.toLowerCase().includes('consent') ||
          o.toLowerCase().includes('agree') ||
          o.toLowerCase().includes('yes') ||
          o.toLowerCase().includes('accept') ||
          o.toLowerCase().includes('acknowledge'),
      );
      return { value: consentOpt || options[0], confidence: 0.99, source: 'profile' };
    }
    return { value: 'I consent', confidence: 0.99, source: 'profile' };
  }

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

  // 3. Job Title / Designation / Role
  if (
    q.includes('job title') ||
    q.includes('title') ||
    q.includes('role') ||
    q.includes('designation') ||
    q.includes('position') ||
    q.includes('occupation')
  ) {
    const title = primaryExp?.title || careerBrain.currentTitle || 'Full Stack Developer';
    return { value: title, confidence: 0.95, source: 'profile' };
  }

  // 4. Company Name / Employer / Organization
  if (
    q.includes('company') ||
    q.includes('employer') ||
    q.includes('organization') ||
    q.includes('organisation') ||
    q.includes('workplace') ||
    q.includes('business name')
  ) {
    const company = primaryExp?.company || 'AI-King Solutions';
    return { value: company, confidence: 0.95, source: 'profile' };
  }

  // 5. Work Experience Dates & Timeline
  if (
    q.includes('from month') ||
    q.includes('start month') ||
    (q.includes('month') && (q.includes('start') || q.includes('from')))
  ) {
    const startMonth = primaryExp?.startMonth || 'August';
    if (options.length > 0) {
      const opt = options.find(o => o.toLowerCase().startsWith(startMonth.toLowerCase().slice(0, 3)));
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: startMonth, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('from year') ||
    q.includes('start year') ||
    (q.includes('year') && (q.includes('start') || q.includes('from')))
  ) {
    const startYear = primaryExp?.startYear || '2024';
    if (options.length > 0) {
      const opt = options.find(o => o.includes(startYear));
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: startYear, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('to month') ||
    q.includes('end month') ||
    (q.includes('month') && (q.includes('end') || q.includes('to')))
  ) {
    const endMonth = primaryExp?.isCurrent ? 'Present' : primaryExp?.endMonth || 'Present';
    if (options.length > 0) {
      const opt = options.find(
        o => o.toLowerCase().includes('present') || o.toLowerCase().startsWith(endMonth.toLowerCase().slice(0, 3)),
      );
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: endMonth, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('to year') ||
    q.includes('end year') ||
    (q.includes('year') && (q.includes('end') || q.includes('to')))
  ) {
    const endYear = primaryExp?.isCurrent
      ? String(new Date().getFullYear())
      : primaryExp?.endYear || String(new Date().getFullYear());
    if (options.length > 0) {
      const opt = options.find(o => o.includes(endYear) || o.toLowerCase().includes('present'));
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: endYear, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('currently work') ||
    q.includes('current role') ||
    q.includes('current job') ||
    q.includes('present')
  ) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.95, source: 'profile' };
  }

  // 6. Years of Experience (Skill or Overall)
  if (q.includes('how many years') || q.includes('years of experience') || q.includes('experience do you have')) {
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

    const yoe = String(careerBrain.yearsOfExperience ?? 1);
    if (options.length > 0) {
      const opt = options.find(o => o.includes(yoe));
      return { value: opt || options[0], confidence: 0.85, source: 'profile' };
    }
    return { value: yoe, confidence: 0.85, source: 'profile' };
  }

  // 7. Names
  if (q.includes('first name') || q.includes('given name')) {
    const first = (careerBrain.fullName || 'Mubasshir Ali').split(' ')[0];
    return { value: first, confidence: 0.95, source: 'profile' };
  }
  if (q.includes('last name') || q.includes('surname') || q.includes('family name')) {
    const last = (careerBrain.fullName || 'Mubasshir Ali').split(' ').slice(1).join(' ') || 'Ali';
    return { value: last, confidence: 0.95, source: 'profile' };
  }
  if (q.includes('full name') || q === 'name') {
    return { value: careerBrain.fullName || 'Mubasshir Ali', confidence: 0.95, source: 'profile' };
  }

  // 8. Contact Info / City / Phone / Email
  if (q.includes('email')) {
    return { value: careerBrain.email || '', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('phone') || q.includes('mobile') || q.includes('contact number')) {
    return { value: careerBrain.phoneNumber || '', confidence: 0.95, source: 'profile' };
  }
  if (
    q.includes('city') ||
    q.includes('location') ||
    q.includes('postal') ||
    q.includes('zip') ||
    q.includes('address') ||
    q.includes('state') ||
    q.includes('country')
  ) {
    return {
      value: careerBrain.currentLocation || careerBrain.preferredLocation || 'Bengaluru, India',
      confidence: 0.9,
      source: 'profile',
    };
  }

  // 9. Links & Social Profiles
  if (q.includes('github') || q.includes('git')) {
    return { value: careerBrain.githubUrl || 'https://github.com', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('linkedin')) {
    return { value: careerBrain.linkedinUrl || '', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('portfolio') || q.includes('website') || q.includes('link') || q.includes('url')) {
    return { value: careerBrain.portfolioUrl || careerBrain.githubUrl || '', confidence: 0.9, source: 'profile' };
  }

  // 10. Education Level & College
  if (q.includes('school') || q.includes('university') || q.includes('college')) {
    return {
      value: careerBrain.college || 'Maulana Abul Kalam Azad University of Technology',
      confidence: 0.9,
      source: 'profile',
    };
  }
  if (q.includes('highest level of education') || q.includes('degree') || q.includes('level of education')) {
    const candidateEdu = (careerBrain.education || '').toLowerCase();
    if (options.length > 0) {
      const matched = options.find(o => {
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

  // 11. Salary / Notice Period / Compensation
  if (
    q.includes('salary') ||
    q.includes('compensation') ||
    q.includes('ctc') ||
    q.includes('pay') ||
    q.includes('expected')
  ) {
    return {
      value: careerBrain.expectedCTC || careerBrain.salaryExpectation || 'Competitive',
      confidence: 0.85,
      source: 'profile',
    };
  }
  if (q.includes('notice period') || q.includes('availability') || q.includes('how soon')) {
    return {
      value: careerBrain.noticePeriod || 'Immediate',
      confidence: 0.9,
      source: 'profile',
    };
  }

  // 12. Golden Answers
  if (Array.isArray(careerBrain.goldenAnswers)) {
    for (const ga of careerBrain.goldenAnswers) {
      if (ga.question && q.includes(ga.question.toLowerCase())) {
        return { value: ga.answer, confidence: 0.85, source: 'golden_answer' };
      }
    }
  }

  // 13. Descriptions / Summary / Narrative
  if (
    q.includes('description') ||
    q.includes('summary') ||
    q.includes('cover letter') ||
    q.includes('headline') ||
    q.includes('about you')
  ) {
    return {
      value:
        careerBrain.backgroundNarrative ||
        'Experienced Full Stack Engineer passionate about building scalable, high-performance web applications.',
      confidence: 0.85,
      source: 'profile',
    };
  }

  // 14. Generic Defaults
  if (fieldType === 'number') {
    return { value: '1', confidence: 0.5, source: 'default' };
  }

  if (options.length > 0) {
    const yesOpt = options.find(o => o.toLowerCase() === 'yes' || o.toLowerCase().startsWith('yes'));
    return { value: yesOpt || options[0], confidence: 0.5, source: 'default' };
  }

  if (fieldType === 'radio' || fieldType === 'checkbox') {
    return { value: 'Yes', confidence: 0.5, source: 'default' };
  }

  // For text inputs: NEVER return "Yes"! Return sensible candidate title or blank.
  return { value: careerBrain.currentTitle || '', confidence: 0.3, source: 'default' };
}
