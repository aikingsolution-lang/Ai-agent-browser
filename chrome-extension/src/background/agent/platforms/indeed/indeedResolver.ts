// chrome-extension/src/background/agent/platforms/indeed/indeedResolver.ts
import { type ICareerBrain, parseLocationParts } from '@extension/storage';
import { alignValueToOptions, matchQuestionSemantically } from '../../intelligence';

export interface IIndeedAnswerResult {
  value: string;
  confidence: number;
  source: 'profile' | 'golden_answer' | 'default';
}

/**
 * Matches a candidate's salary (or range) to the best matching dropdown option.
 * Handles Indian Lakhs/LPA formats (e.g. 6-10 LPA, 6,00,000 - 10,00,000, 800000)
 * as well as standard annual/monthly salary options.
 */
export function matchSalaryToOptions(salaryOrRange: string, options: string[]): string | null {
  if (!options || options.length === 0) return null;

  // Filter out placeholder options
  const validOpts = options.filter(o => !/select\s*an\s*option|choose\s*an\s*option|^--|^\s*$/i.test(o.trim()));
  if (validOpts.length === 0) return null;

  // 1. Try direct string inclusion first
  const cleanSal = salaryOrRange.trim().toLowerCase();
  const directMatch = validOpts.find(o => o.toLowerCase().includes(cleanSal) || cleanSal.includes(o.toLowerCase()));
  if (directMatch) return directMatch;

  // 2. Extract candidate numeric target (in annual currency units)
  const parseCandidateSalary = (str: string): { min: number; max: number; target: number } => {
    const s = str.trim().toLowerCase();
    const isLPA = s.includes('lpa') || s.includes('lakh') || s.includes('lac');

    // Check for range: e.g. "6 - 10" or "6,00,000 - 10,00,000"
    const rangeMatch = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/i);
    if (rangeMatch) {
      let min = parseFloat(rangeMatch[1].replace(/,/g, ''));
      let max = parseFloat(rangeMatch[2].replace(/,/g, ''));
      if (isLPA || (min <= 100 && max <= 100)) {
        min *= 100000;
        max *= 100000;
      }
      return { min, max, target: Math.round((min + max) / 2) };
    }

    // Single number
    const numMatch = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/);
    if (numMatch) {
      let val = parseFloat(numMatch[1].replace(/,/g, ''));
      if (isLPA || val <= 100) {
        val *= 100000;
      }
      return { min: val, max: val, target: val };
    }

    return { min: 600000, max: 600000, target: 600000 };
  };

  const cand = parseCandidateSalary(salaryOrRange);

  // Parse each option's numeric range
  const parseOptionSalary = (opt: string): { min: number; max: number } => {
    const o = opt.toLowerCase();
    const isLPA = o.includes('lpa') || o.includes('lakh') || o.includes('lac');
    const isMonthly = o.includes('month') || o.includes('/mo') || o.includes('per month');

    // Check range: e.g. "₹2,00,000 - ₹4,00,000"
    const range = o.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/i);
    if (range) {
      let rawMin = parseFloat(range[1].replace(/,/g, ''));
      let rawMax = parseFloat(range[2].replace(/,/g, ''));
      if (isMonthly) {
        rawMin *= 12;
        rawMax *= 12;
      } else if (isLPA || (rawMin <= 100 && rawMax <= 100)) {
        rawMin *= 100000;
        rawMax *= 100000;
      }
      return { min: rawMin, max: rawMax };
    }

    // Plus range: e.g. "₹10,00,000+"
    const plus = o.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*\+/);
    if (plus) {
      let rawMin = parseFloat(plus[1].replace(/,/g, ''));
      if (isMonthly) {
        rawMin *= 12;
      } else if (isLPA || rawMin <= 100) {
        rawMin *= 100000;
      }
      return { min: rawMin, max: Infinity };
    }

    // Single number
    const single = o.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/);
    if (single) {
      let rawVal = parseFloat(single[1].replace(/,/g, ''));
      if (isMonthly) {
        rawVal *= 12;
      } else if (isLPA || rawVal <= 100) {
        rawVal *= 100000;
      }
      return { min: rawVal, max: rawVal };
    }

    return { min: 0, max: 0 };
  };

  let bestOpt: string | null = null;
  let bestScore = -Infinity;

  for (const opt of validOpts) {
    const oRange = parseOptionSalary(opt);
    if (oRange.min === 0 && oRange.max === 0) continue;

    // Direct containment: candidate target is inside option range
    if (cand.target >= oRange.min && cand.target <= oRange.max) {
      return opt;
    }

    // Range overlap
    const overlapMin = Math.max(cand.min, oRange.min);
    const overlapMax = Math.min(cand.max, oRange.max);
    if (overlapMin <= overlapMax && overlapMax > 0) {
      const overlapSize = overlapMax - overlapMin;
      if (overlapSize > bestScore) {
        bestScore = overlapSize;
        bestOpt = opt;
      }
    }
  }

  if (bestOpt) return bestOpt;

  // If no overlap, pick closest option
  let closestOpt: string | null = null;
  let minDiff = Infinity;
  for (const opt of validOpts) {
    const oRange = parseOptionSalary(opt);
    if (oRange.min === 0 && oRange.max === 0) continue;
    const mid = oRange.max === Infinity ? oRange.min : (oRange.min + oRange.max) / 2;
    const diff = Math.abs(mid - cand.target);
    if (diff < minDiff) {
      minDiff = diff;
      closestOpt = opt;
    }
  }

  return closestOpt || validOpts[0];
}

/**
 * Resolves screening questions and form fields commonly found in Indeed Apply forms.
 */
function computeInitialAnswer(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date',
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

  // 4. Company Name / Employer / Organization Name
  if (
    q.includes('current company') ||
    q.includes('present company') ||
    q.includes('current employer') ||
    q.includes('company name') ||
    q.includes('employer name') ||
    q.includes('organization name') ||
    q.includes('organisation name') ||
    q.includes('name of company') ||
    q.includes('name of employer') ||
    q.includes('name of organization') ||
    q === 'company' ||
    q === 'employer' ||
    q === 'organization' ||
    q === 'organisation' ||
    q === 'workplace' ||
    q === 'business name' ||
    /\b(?:current|present|previous|most recent)\s+(?:company|employer|organization|workplace)\b/i.test(q)
  ) {
    const rawCompany = primaryExp?.company || (careerBrain.hasWorkExperience === false ? 'None' : 'Self-Employed');
    const cleanCompany = /here|your\s*company|name\s*here/i.test(rawCompany)
      ? careerBrain.hasWorkExperience === false
        ? 'None'
        : 'Self-Employed'
      : rawCompany;
    return { value: cleanCompany, confidence: 0.98, source: 'profile' };
  }

  // 5. Work Experience Dates & Timeline
  if (
    q.includes('from month') ||
    q.includes('start month') ||
    (q.includes('month') && (q.includes('start') || /\bfrom\b/i.test(q)))
  ) {
    const startMonth = primaryExp?.startMonth || 'January';
    if (options.length > 0) {
      const opt = options.find(o => o.toLowerCase().startsWith(startMonth.toLowerCase().slice(0, 3)));
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: startMonth, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('from year') ||
    q.includes('start year') ||
    (q.includes('year') && (q.includes('start') || /\bfrom\b/i.test(q)))
  ) {
    const startYear = primaryExp?.startYear || String(new Date().getFullYear() - 1);
    if (options.length > 0) {
      const opt = options.find(o => o.includes(startYear));
      return { value: opt || options[0], confidence: 0.9, source: 'profile' };
    }
    return { value: startYear, confidence: 0.9, source: 'profile' };
  }

  if (
    q.includes('to month') ||
    q.includes('end month') ||
    (q.includes('month') && (q.includes('end') || /\bto\b/i.test(q)))
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
    (q.includes('year') && (q.includes('end') || /\bto\b/i.test(q)))
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
  if (
    q.includes('how many years') ||
    q.includes('years of experience') ||
    q.includes('experience do you have') ||
    q.includes('experience with') ||
    q.includes('worked with') ||
    q.includes('working with') ||
    q.includes('total year') ||
    q.includes('experiance') ||
    q.includes('total experience')
  ) {
    const isGenericTotal =
      /\b(?:total|overall|all)\s*(?:years?|yrs?)?\s*(?:of)?\s*(?:work|professional)?\s*experi[ea]nce\b/i.test(q) ||
      /\bhow\s*many\s*(?:years?|yrs?)\s*(?:of)?\s*(?:total|overall|work|professional)?\s*experi[ea]nce\b/i.test(q) ||
      /\btotal\s*experi[ea]nce\b/i.test(q) ||
      /\bexperi[ea]nce\s*in\s*years\b/i.test(q) ||
      /^(?:total\s*)?(?:work\s*)?experi[ea]nce\s*(?:\(in\s*years?\))?[:?*]?$/i.test(q);

    if (isGenericTotal) {
      const yoe = String(careerBrain.yearsOfExperience ?? 1);
      if (options.length > 0) {
        const opt = options.find(o => o.includes(yoe));
        return { value: opt || options[0], confidence: 0.95, source: 'profile' };
      }
      return { value: yoe, confidence: 0.95, source: 'profile' };
    }

    if (careerBrain.skillExperience) {
      for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
        if (q.includes(skill.toLowerCase())) {
          if (options.length > 0) {
            const opt = options.find(o => o.includes(String(yrs)));
            return { value: opt || options[0], confidence: 0.95, source: 'profile' };
          }
          return { value: String(yrs), confidence: 0.95, source: 'profile' };
        }
      }
    }

    // Check if skill is mentioned in candidate's skills list or resume text
    const candidateSkills = (careerBrain.skills || []).map(s => s.toLowerCase());
    const hasSkillInProfile = candidateSkills.some(s => s.length > 2 && q.includes(s));

    if (hasSkillInProfile) {
      const yoe = String(careerBrain.yearsOfExperience ?? 1);
      if (options.length > 0) {
        const opt = options.find(o => o.includes(yoe));
        return { value: opt || options[0], confidence: 0.85, source: 'profile' };
      }
      return { value: yoe, confidence: 0.85, source: 'profile' };
    }

    // Skill not found in skillExperience or skills:
    // Do NOT invent experience! Return 0 with low confidence (0.2) so LLM verifies with full resume context.
    const fallbackZero =
      options.length > 0 ? options.find(o => /\b0\b|none|never|less than/i.test(o)) || options[0] : '0';
    return { value: fallbackZero, confidence: 0.2, source: 'default' };
  }

  // 7. Names
  if (q.includes('first name') || q.includes('given name')) {
    const first = (careerBrain.fullName || '').split(' ')[0] || '';
    return { value: first, confidence: first ? 0.95 : 0.1, source: 'profile' };
  }
  if (q.includes('last name') || q.includes('surname') || q.includes('family name')) {
    const parts = (careerBrain.fullName || '').split(' ').filter(Boolean);
    const last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    return { value: last, confidence: last ? 0.95 : 0.1, source: 'profile' };
  }
  if (q.includes('full name') || q === 'name') {
    return { value: careerBrain.fullName || '', confidence: careerBrain.fullName ? 0.95 : 0.1, source: 'profile' };
  }

  // 7.5 Gender / Sex / Identity
  if (q.includes('gender') || q === 'sex' || q.includes('gender identity')) {
    const candidateGender = careerBrain.gender || 'Prefer not to say';
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
    const rawLoc = careerBrain.currentLocation || careerBrain.preferredLocation || 'Bengaluru, Karnataka, India';
    const parts = parseLocationParts(rawLoc);

    // Specific State check
    if (q.includes('state') && !q.includes('united states') && parts.state) {
      if (options.length > 0) {
        const stateOpt = options.find(o => o.toLowerCase().includes(parts.state!.toLowerCase()));
        if (stateOpt) return { value: stateOpt, confidence: 0.95, source: 'profile' };
      }
      return { value: parts.state, confidence: 0.95, source: 'profile' };
    }

    // Specific Country check
    if (
      q === 'country' ||
      q === 'country *' ||
      q.includes('country') ||
      q.includes('nationality') ||
      q.includes('country of residence') ||
      q.includes('what country')
    ) {
      const candidateCountry =
        (careerBrain as any).country ||
        (parts.country && !/karnataka|maharashtra|tamil nadu|delhi|telangana|kerala|uttar pradesh/i.test(parts.country)
          ? parts.country
          : '') ||
        (rawLoc.toLowerCase().includes('india') ? 'India' : '') ||
        (careerBrain.phoneNumber?.startsWith('+91') ? 'India' : '') ||
        (careerBrain.currentLocation?.toLowerCase().includes('india') ? 'India' : '') ||
        (careerBrain.preferredLocations?.some(l => l.toLowerCase().includes('india')) ? 'India' : '') ||
        'India';

      if (options.length > 0) {
        const countryOpt = options.find(o => {
          const lo = o.toLowerCase().trim();
          if (/select\s*an?\s*option|choose\s*an?\s*option|select\s*a\s*country|^--$|^\s*$/i.test(lo)) return false;
          return (
            lo === candidateCountry.toLowerCase() ||
            lo === 'in' ||
            lo === 'india (in)' ||
            lo === 'in - india' ||
            lo.startsWith('india') ||
            lo.includes('india')
          );
        });
        if (countryOpt) return { value: countryOpt, confidence: 0.99, source: 'profile' };
      }
      return { value: candidateCountry, confidence: 0.99, source: 'profile' };
    }

    if (options.length > 0) {
      // 1. Check candidate's prioritized preferred locations in priority order
      const prefList =
        Array.isArray(careerBrain.preferredLocations) && careerBrain.preferredLocations.length > 0
          ? careerBrain.preferredLocations
          : [careerBrain.preferredLocation || rawLoc];

      for (let pIdx = 0; pIdx < prefList.length; pIdx++) {
        const pref = prefList[pIdx];
        if (!pref) continue;
        const prefLo = pref.toLowerCase();
        const pParts = parseLocationParts(pref);
        const cityLo = pParts.city.toLowerCase();

        const matchedOpt = options.find(o => {
          const oLo = o.toLowerCase();
          return (
            (cityLo && oLo.includes(cityLo)) ||
            prefLo.includes(oLo) ||
            oLo.includes(prefLo) ||
            (oLo.includes('remote') && prefLo.includes('remote'))
          );
        });
        if (matchedOpt) {
          return { value: matchedOpt, confidence: 0.95 - pIdx * 0.05, source: 'profile' };
        }
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
      value: rawLoc,
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
      value: careerBrain.college || '',
      confidence: careerBrain.college ? 0.9 : 0.2,
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
  // 11.0 Expected Last Working Day / Start Date (DD/MM/YYYY) (CHECK BEFORE SALARY to prevent matching 'expected')
  if (
    q.includes('last working day') ||
    q.includes('last working date') ||
    q.includes('expected last working') ||
    q.includes('end date of current employment')
  ) {
    const today = new Date();
    const d = String(today.getDate()).padStart(2, '0');
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const y = String(today.getFullYear());
    const formattedDate = `${d}/${m}/${y}`;
    return { value: formattedDate, confidence: 0.99, source: 'profile' };
  }

  // 11. Salary / Notice Period / Compensation
  if (q.includes('salary range') || q.includes('range acceptable') || q.includes('compensation acceptable')) {
    if (options.length > 0) {
      const yesOpt = options.find(o => o.toLowerCase().startsWith('yes'));
      return { value: yesOpt || options[0], confidence: 0.95, source: 'profile' };
    }
    return { value: 'Yes', confidence: 0.95, source: 'profile' };
  }
  if (
    q.includes('current salary') ||
    q.includes('current ctc') ||
    q.includes('current compensation') ||
    q.includes('last drawn salary') ||
    q.includes('current/ last drawn')
  ) {
    const raw = careerBrain.currentCTC || '120000';
    if (options.length > 0) {
      const matched = matchSalaryToOptions(raw, options);
      if (matched) return { value: matched, confidence: 0.98, source: 'profile' };
    }
    const clean = (() => {
      const s = String(raw).trim();
      const isLPA = /lpa|lakh|lac/i.test(s);
      const rangeMatch = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/i);
      if (rangeMatch) {
        let n = parseFloat(rangeMatch[1].replace(/,/g, ''));
        if (isLPA || n <= 100) n *= 100000;
        return String(Math.round(n));
      }
      const numOnly = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/);
      if (numOnly) {
        let n = parseFloat(numOnly[1].replace(/,/g, ''));
        if (isLPA || n <= 100) n *= 100000;
        return String(Math.round(n));
      }
      return '120000';
    })();
    return {
      value: clean,
      confidence: 0.95,
      source: 'profile',
    };
  }
  if (
    q.includes('expected annual salary') ||
    q.includes('expected salary') ||
    q.includes('expected ctc') ||
    q.includes('salary') ||
    q.includes('compensation') ||
    q.includes('ctc') ||
    q.includes('pay') ||
    (q.includes('expected') &&
      (q.includes('remuneration') || q.includes('package') || q.includes('annual') || q.includes('inr')))
  ) {
    const raw = careerBrain.expectedCTC || careerBrain.salaryExpectation || '600000';
    if (options.length > 0) {
      const matched = matchSalaryToOptions(raw, options);
      if (matched) return { value: matched, confidence: 0.98, source: 'profile' };
    }
    const clean = (() => {
      const s = String(raw).trim();
      const isLPA = /lpa|lakh|lac/i.test(s);
      const rangeMatch = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)\s*(?:-|to)\s*([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/i);
      if (rangeMatch) {
        let n = parseFloat(rangeMatch[1].replace(/,/g, ''));
        if (isLPA || n <= 100) n *= 100000;
        return String(Math.round(n));
      }
      const numOnly = s.match(/([0-9]+(?:,[0-9]+)*(?:\.[0-9]+)?)/);
      if (numOnly) {
        let n = parseFloat(numOnly[1].replace(/,/g, ''));
        if (isLPA || n <= 100) n *= 100000;
        return String(Math.round(n));
      }
      return '600000';
    })();
    return {
      value: clean,
      confidence: 0.95,
      source: 'profile',
    };
  }
  if (
    q.includes('notice period') ||
    q.includes('availability') ||
    q.includes('how soon') ||
    q.includes('when can you start')
  ) {
    const np = careerBrain.noticePeriod || 'Immediate';
    if (options.length > 0) {
      const npLo = np.toLowerCase();
      const match =
        options.find(o => o.toLowerCase().includes(npLo) || npLo.includes(o.toLowerCase())) ||
        options.find(o => {
          const lo = o.toLowerCase();
          return (
            lo.includes('immediate') ||
            lo.includes('15') ||
            lo.includes('serving') ||
            lo.includes('1 month') ||
            lo.includes('less than')
          );
        });
      return { value: match || options[0], confidence: 0.98, source: 'profile' };
    }
    return {
      value: np,
      confidence: 0.95,
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
    const rawDob = careerBrain.dateOfBirth || '2000-01-01';
    let formattedDob = '01/01/2000';
    const ymd = rawDob.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (ymd) {
      formattedDob = `${ymd[3].padStart(2, '0')}/${ymd[2].padStart(2, '0')}/${ymd[1]}`;
    } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDob)) {
      formattedDob = rawDob;
    }
    if (q.includes('year') && !q.includes('date')) {
      const year = rawDob.split(/[-/]/)[0] || '2000';
      return { value: year, confidence: 0.95, source: 'profile' };
    }
    return { value: formattedDob, confidence: 0.99, source: 'profile' };
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

  // 11.6 Previous Employment & Current Employment (specifically with this company/employer)
  if (
    q.includes('previous employee') ||
    q.includes('worked for this company') ||
    q.includes('employed by this company') ||
    q.includes('worked here before') ||
    q.includes('previously employed by') ||
    /(?:previously|prior|formerly)\s+(?:worked|employed)\s+(?:for|at)\s+(?:this|our|the)\s+company/i.test(q) ||
    /(?:previously|prior|formerly)\s+(?:worked|employed)\s+here\b/i.test(q)
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

  // For text inputs: Return candidate title or empty string.
  return { value: careerBrain.currentTitle || '', confidence: 0.3, source: 'default' };
}

/**
 * Resolves screening questions and form fields commonly found in Indeed Apply forms.
 * Validates the chosen answer against available DOM options.
 */
export function resolveIndeedQuestion(
  questionText: string,
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'select' | 'checkbox' | 'date',
  options: string[] = [],
  careerBrain: ICareerBrain,
): IIndeedAnswerResult {
  if (
    !questionText ||
    /answer these questions|questions from the employer|fields marked with|report the job/i.test(questionText)
  ) {
    return { value: '', confidence: 0.1, source: 'default' };
  }

  // 1. Compute profile rule-based answer first for deterministic profile fields
  const computed = computeInitialAnswer(questionText, fieldType, options, careerBrain);
  if (computed.confidence >= 0.9) {
    if (options.length > 0 && computed.value) {
      const aligned = alignValueToOptions(computed.value, options, questionText);
      if (aligned) {
        return {
          value: aligned.matchedOption,
          confidence: Math.max(computed.confidence, aligned.confidence),
          source: computed.source,
        };
      }
    }
    return computed;
  }

  // 2. Check high-speed semantic matcher for golden answers
  const semantic = matchQuestionSemantically(questionText, careerBrain);
  if (semantic && semantic.confidence >= 0.88 && semantic.matchedAnswer) {
    if (options.length > 0) {
      const aligned = alignValueToOptions(semantic.matchedAnswer, options, questionText);
      if (aligned) {
        return {
          value: aligned.matchedOption,
          confidence: Math.max(semantic.confidence, aligned.confidence),
          source: 'golden_answer',
        };
      }
    }
    return {
      value: semantic.matchedAnswer,
      confidence: semantic.confidence,
      source: 'golden_answer',
    };
  }

  // 3. Option alignment for fallback
  if (options.length > 0 && computed.value) {
    const aligned = alignValueToOptions(computed.value, options, questionText);
    if (aligned) {
      return {
        value: aligned.matchedOption,
        confidence: computed.confidence,
        source: computed.source,
      };
    }
  }

  return computed;
}
