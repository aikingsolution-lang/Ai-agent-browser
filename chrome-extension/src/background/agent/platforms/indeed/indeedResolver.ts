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
function computeInitialAnswer(
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

  // 0.1 Conditional Follow-Up Fields (e.g. "If yes, approximate date(s):", "If yes, please explain", "If previous employee...")
  const isConditionalIfYes =
    /^(?:if\s+(?:yes|so|applicable|checked|other)|if\s+you\s+(?:answered\s+yes|are|have|were))\b/i.test(q) ||
    /\bif\s+yes\b/i.test(q);
  if (isConditionalIfYes) {
    // If the applicant answered "No" to previous interview/employment questions, this MUST remain blank!
    return { value: '', confidence: 0.99, source: 'profile' };
  }

  // 0.2 Job Source / "How did you learn about this job opportunity?" / Referral Source
  if (
    q.includes('how did you learn') ||
    q.includes('how did you hear') ||
    q.includes('where did you hear') ||
    q.includes('where did you find') ||
    q.includes('how did you find out') ||
    q.includes('source of application') ||
    q.includes('referral source') ||
    q.includes('hear about this opportunity') ||
    q.includes('learn about this job') ||
    q.includes('hear about this role') ||
    q.includes('hear about this job')
  ) {
    if (options.length > 0) {
      const indeedOpt = options.find(o => o.toLowerCase().includes('indeed'));
      if (indeedOpt) return { value: indeedOpt, confidence: 0.99, source: 'profile' };
      const jobBoardOpt = options.find(o => /job\s*board|online|internet|website/i.test(o));
      if (jobBoardOpt) return { value: jobBoardOpt, confidence: 0.95, source: 'profile' };
      return { value: options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Indeed', confidence: 0.99, source: 'profile' };
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

  // 7.5 Gender / Sex / Identity
  if (q.includes('gender') || q === 'sex' || q.includes('gender identity')) {
    const candidateGender = careerBrain.gender || 'Male';
    if (options.length > 0) {
      const match = options.find(
        o =>
          o.toLowerCase() === candidateGender.toLowerCase() || o.toLowerCase().includes(candidateGender.toLowerCase()),
      );
      return { value: match || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: candidateGender, confidence: 0.95, source: 'profile' };
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
    q.includes('country') ||
    q.includes('where are you located') ||
    q.includes('where do you live') ||
    q.includes('timezone') ||
    q.includes('time zone')
  ) {
    if (options.length > 0) {
      // 1. Check if options match candidate location or country
      const loc = (careerBrain.currentLocation || careerBrain.preferredLocation || 'Bengaluru, India').toLowerCase();
      const matchedOpt = options.find(o => {
        const oLo = o.toLowerCase();
        return loc.includes(oLo) || oLo.includes('india') || oLo.includes('bengaluru') || oLo.includes('remote');
      });
      if (matchedOpt) {
        return { value: matchedOpt, confidence: 0.95, source: 'profile' };
      }

      // 2. Check if options are timezones (EST, CST, MST, PST, etc.)
      const isTimezoneOptions = options.some(o => {
        const oLo = o.toLowerCase().trim();
        return (
          ['est', 'cst', 'mst', 'pst', 'edt', 'cdt', 'mdt', 'pdt', 'gmt', 'utc', 'ist'].includes(oLo) ||
          oLo.includes('eastern') ||
          oLo.includes('central') ||
          oLo.includes('mountain') ||
          oLo.includes('pacific')
        );
      });
      if (isTimezoneOptions) {
        const estOpt = options.find(o => {
          const oLo = o.toLowerCase();
          return oLo.includes('est') || oLo.includes('eastern');
        });
        return { value: estOpt || options[0], confidence: 0.98, source: 'profile' };
      }

      return { value: options[0], confidence: 0.4, source: 'profile' };
    }

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
    const candidateEdu = (careerBrain.highestEducation || careerBrain.education || "Bachelor's Degree").toLowerCase();
    if (options.length > 0) {
      const matched = options.find(o => {
        const lo = o.toLowerCase();
        if (candidateEdu.includes('master') && lo.includes('master')) return true;
        if (
          (candidateEdu.includes('bachelor') || candidateEdu.includes('b.tech') || candidateEdu.includes('be')) &&
          lo.includes('bachelor')
        )
          return true;
        if (
          (candidateEdu.includes('doctor') || candidateEdu.includes('phd')) &&
          (lo.includes('doctor') || lo.includes('phd'))
        )
          return true;
        return false;
      });
      return { value: matched || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: careerBrain.highestEducation || "Bachelor's Degree", confidence: 0.9, source: 'profile' };
  }

  // 11. Salary / Notice Period / Compensation
  if (q.includes('salary range') || q.includes('range acceptable') || q.includes('compensation acceptable')) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('current salary') || q.includes('current ctc') || q.includes('current compensation')) {
    return {
      value: careerBrain.currentCTC || '₹6,00,000',
      confidence: 0.9,
      source: 'profile',
    };
  }
  if (
    q.includes('salary') ||
    q.includes('compensation') ||
    q.includes('ctc') ||
    q.includes('pay') ||
    q.includes('expected')
  ) {
    return {
      value: careerBrain.expectedCTC || careerBrain.salaryExpectation || '₹10,00,000',
      confidence: 0.85,
      source: 'profile',
    };
  }
  if (
    q.includes('notice period') ||
    q.includes('availability') ||
    q.includes('how soon') ||
    q.includes('when can you start')
  ) {
    return {
      value: careerBrain.noticePeriod || 'Immediate',
      confidence: 0.9,
      source: 'profile',
    };
  }

  // 11.2 Age Confirmation & Date of Birth
  if (
    q.includes('18 years') ||
    q.includes('18 or older') ||
    q.includes('at least 18') ||
    q.includes('age requirement') ||
    q.includes('are you 18')
  ) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.98, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.98, source: 'profile' };
  }
  if (q.includes('date of birth') || q.includes('birth date') || q === 'dob' || q.includes('birth year')) {
    const dob = careerBrain.dateOfBirth || '2000-01-01';
    if (q.includes('year') && !q.includes('date')) {
      const year = dob.split(/[-/]/)[0] || '2000';
      return { value: year, confidence: 0.9, source: 'profile' };
    }
    return { value: dob, confidence: 0.9, source: 'profile' };
  }

  // 11.3 Driver's License
  if (
    q.includes('driver') ||
    q.includes('driving license') ||
    q.includes("driver's license") ||
    q.includes('valid driver')
  ) {
    const val = careerBrain.driverLicense || 'Yes';
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: val, confidence: 0.95, source: 'profile' };
  }

  // 11.4 Shifts, Working Hours & Weekends
  if (
    q.includes('shift') ||
    q.includes('night shift') ||
    q.includes('day shift') ||
    q.includes('weekend') ||
    q.includes('on-call') ||
    q.includes('flexible hours')
  ) {
    const pref = careerBrain.preferredShift || 'Day / Flexible';
    if (options.length > 0) {
      const match = options.find(o => {
        const lo = o.toLowerCase();
        return lo.includes('day') || lo.includes('flex') || lo.includes('yes') || lo.includes('any');
      });
      return { value: match || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: pref, confidence: 0.9, source: 'profile' };
  }

  // 11.5 Background Check & Drug Screening
  if (
    q.includes('background check') ||
    q.includes('background investigation') ||
    q.includes('drug screen') ||
    q.includes('drug test')
  ) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.98, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.98, source: 'profile' };
  }

  // 11.6 Previous Employment & Current Employment
  if (
    q.includes('previously worked') ||
    q.includes('previous employee') ||
    q.includes('worked for this company') ||
    q.includes('employed by this company')
  ) {
    if (options.length > 0) {
      const noOpt = options.find(o => o.toLowerCase().startsWith('no'));
      return { value: noOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'No', confidence: 0.95, source: 'profile' };
  }
  if (q.includes('currently employed') || q.includes('are you currently working')) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.95, source: 'profile' };
  }

  // 11.7 Diversity: Veteran Status & Disability
  if (q.includes('veteran') || q.includes('military service') || q.includes('protected veteran')) {
    const vet = careerBrain.veteranStatus || 'I am not a protected veteran';
    if (options.length > 0) {
      const match = options.find(o => {
        const lo = o.toLowerCase();
        return lo.includes('not a protected') || lo.includes('not a veteran') || lo.startsWith('no');
      });
      return { value: match || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: vet, confidence: 0.95, source: 'profile' };
  }
  if (q.includes('disability') || q.includes('handicap') || q.includes('impairment')) {
    const dis = careerBrain.disabilityStatus || 'No, I do not have a disability';
    if (options.length > 0) {
      const match = options.find(o => {
        const lo = o.toLowerCase();
        return (
          lo.includes('no, i do not') ||
          lo.includes("don't have") ||
          lo.includes('not have a disability') ||
          lo === 'no' ||
          lo.startsWith('no')
        );
      });
      return { value: match || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: dis, confidence: 0.95, source: 'profile' };
  }

  // 12. Smart Golden Answers Lookup (Exact & Loose Matching)
  if (Array.isArray(careerBrain.goldenAnswers) && careerBrain.goldenAnswers.length > 0) {
    for (const ga of careerBrain.goldenAnswers) {
      if (!ga.question || !ga.answer) continue;
      const gaQ = ga.question.toLowerCase().trim();
      // Match exact substring or multi-token overlap
      if (q.includes(gaQ) || gaQ.includes(q)) {
        if (options.length > 0) {
          const ansLo = ga.answer.toLowerCase();
          const optMatch = options.find(o => o.toLowerCase() === ansLo || o.toLowerCase().includes(ansLo));
          return { value: optMatch || ga.answer, confidence: 0.95, source: 'golden_answer' };
        }
        return { value: ga.answer, confidence: 0.95, source: 'golden_answer' };
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

/**
 * Resolves screening questions and form fields commonly found in Indeed Apply forms.
 * Validates the chosen answer against available DOM options.
 * If options are present and the chosen answer does not match any of them,
 * demotes confidence to 0.4 so the autonomous LLM can resolve the field with full context.
 */
export function resolveIndeedQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox',
  options: string[] = [],
  careerBrain: ICareerBrain,
): IIndeedAnswerResult {
  const result = computeInitialAnswer(questionText, fieldType, options, careerBrain);

  // Universal options validation:
  // If options were provided by the DOM, but our chosen value does NOT match ANY of the options,
  // we must lower confidence to 0.4 so LLM gets invoked to pick the exact right option!
  if (options.length > 0 && result.value) {
    const valLower = result.value.toLowerCase().trim();
    const matchesAny = options.some(opt => {
      const optLower = opt.toLowerCase().trim();
      return (
        optLower === valLower ||
        (valLower.length > 1 && optLower.includes(valLower)) ||
        (optLower.length > 1 && valLower.includes(optLower)) ||
        (valLower.startsWith('y') && optLower.startsWith('y')) ||
        (valLower.startsWith('n') && optLower.startsWith('n'))
      );
    });

    if (!matchesAny) {
      result.confidence = 0.4;
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      result.value = yesOpt || options[0];
    }
  }

  return result;
}
