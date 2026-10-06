// chrome-extension/src/background/agent/intelligence/smartOptionAligner.ts

export interface IOptionAlignmentResult {
  matchedOption: string;
  confidence: number;
  reason: string;
}

/**
 * Parses numeric ranges from options like "2 - 4 years", "3-5 yrs", "5+ years", "₹10,00,001 - ₹15,00,000"
 */
function parseOptionNumericRange(opt: string): { min: number; max: number } | null {
  const clean = opt.toLowerCase().replace(/,/g, '').trim();

  // Pattern: "5+ years", "10+ years", "more than 5 years"
  const plusMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:\+|plus|\s*years?\s*or\s*more|and\s*above)/i);
  if (plusMatch) {
    const val = parseFloat(plusMatch[1]);
    return { min: val, max: 999 };
  }

  // Pattern: "less than 1 year", "under 1 year"
  const lessMatch = clean.match(/(?:less\s*than|under|<)\s*(\d+(?:\.\d+)?)/i);
  if (lessMatch) {
    const val = parseFloat(lessMatch[1]);
    return { min: 0, max: val };
  }

  // Pattern: "2 - 4 years", "2 to 4", "2-4"
  const rangeMatch = clean.match(/(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    return { min, max };
  }

  // Single number
  const singleMatch = clean.match(/^(\d+(?:\.\d+)?)$/);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]);
    return { min: val, max: val };
  }

  return null;
}

/**
 * Universal Smart Option Aligner
 * Maps any candidate value or semantic answer to the exact matching DOM option
 * across LinkedIn, Indeed, and Naukri dropdowns, radios, and selection pills.
 */
export function alignValueToOptions(
  desiredVal: string | number | undefined | null,
  options: string[],
  contextHint?: string,
): IOptionAlignmentResult | null {
  if (desiredVal === undefined || desiredVal === null || !options || options.length === 0) {
    return null;
  }

  const rawVal = String(desiredVal).trim();
  if (!rawVal) return null;

  const normVal = rawVal.toLowerCase();
  const hintLower = (contextHint || '').toLowerCase();

  // 1. Exact match (case-insensitive)
  for (const opt of options) {
    if (opt.trim().toLowerCase() === normVal) {
      return { matchedOption: opt, confidence: 1.0, reason: 'Exact case-insensitive match' };
    }
  }

  // 2. Affirmative / Negative Boolean alignment
  const isAffirmative = /^(yes|true|y|agree|authorized|eligible|willing|immediate|available)$/i.test(normVal);
  const isNegative = /^(no|false|n|disagree|requires|unauthorized|not willing|decline)$/i.test(normVal);

  if (isAffirmative || isNegative) {
    const targetIsYes = isAffirmative;
    // Prefer clean "Yes" / "No" first
    for (const opt of options) {
      const optClean = opt.trim().toLowerCase();
      if (targetIsYes && (optClean === 'yes' || optClean === 'i agree' || optClean === 'agree')) {
        return { matchedOption: opt, confidence: 0.98, reason: 'Affirmative direct match' };
      }
      if (!targetIsYes && (optClean === 'no' || optClean === 'i disagree' || optClean === 'disagree')) {
        return { matchedOption: opt, confidence: 0.98, reason: 'Negative direct match' };
      }
    }

    // Next, look for options starting with Yes / No or conveying affirmative/negative
    for (const opt of options) {
      const optClean = opt.trim().toLowerCase();
      if (targetIsYes) {
        if (
          optClean.startsWith('yes') ||
          optClean.includes('authorized') ||
          optClean.includes('citizen') ||
          optClean.includes('willing to') ||
          optClean.includes('i am legally authorized') ||
          optClean.includes('without sponsorship')
        ) {
          return { matchedOption: opt, confidence: 0.92, reason: 'Affirmative descriptive match' };
        }
      } else {
        if (
          optClean.startsWith('no') ||
          optClean.includes('do not') ||
          optClean.includes('will require sponsorship') ||
          optClean.includes('not willing') ||
          optClean.includes('cannot')
        ) {
          return { matchedOption: opt, confidence: 0.92, reason: 'Negative descriptive match' };
        }
      }
    }
  }

  // 3. Notice Period Alignment
  const isNoticeContext =
    hintLower.includes('notice') ||
    hintLower.includes('joining') ||
    hintLower.includes('how soon') ||
    hintLower.includes('availability') ||
    /immediate|15\s*days?|30\s*days?|1\s*month|60\s*days?|2\s*months?|90\s*days?|3\s*months?/i.test(normVal);

  if (isNoticeContext) {
    const isImmediateOr15 = /immediate|0\s*days?|less than 15|15\s*days?/i.test(normVal);
    const is30Or1Month = /30\s*days?|1\s*month/i.test(normVal);
    const is60Or2Months = /60\s*days?|2\s*months?/i.test(normVal);
    const is90Or3Months = /90\s*days?|3\s*months?/i.test(normVal);

    for (const opt of options) {
      const optL = opt.toLowerCase();
      if (
        isImmediateOr15 &&
        (optL.includes('immediate') ||
          optL.includes('15') ||
          optL.includes('0-15') ||
          optL.includes('less than 1 month'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Notice period: immediate/15 days match' };
      }
      if (
        is30Or1Month &&
        (optL.includes('30') || optL.includes('1 month') || optL.includes('15 to 30') || optL.includes('15-30'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Notice period: 1 month/30 days match' };
      }
      if (
        is60Or2Months &&
        (optL.includes('60') || optL.includes('2 month') || optL.includes('30 to 60') || optL.includes('30-60'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Notice period: 2 months/60 days match' };
      }
      if (
        is90Or3Months &&
        (optL.includes('90') || optL.includes('3 month') || optL.includes('more than 2 month') || optL.includes('60+'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Notice period: 3 months/90 days match' };
      }
    }
  }

  // 4. Education Level Semantic Alignment
  const isEducationContext =
    hintLower.includes('education') ||
    hintLower.includes('degree') ||
    hintLower.includes('qualification') ||
    /b\.?tech|b\.?e\.?|bca|b\.?sc|bachelor|m\.?tech|mca|m\.?sc|master|phd|diploma/i.test(normVal);

  if (isEducationContext) {
    const isBachelor = /b\.?tech|b\.?e\.?|bca|b\.?sc|bachelor|undergraduate|graduate/i.test(normVal);
    const isMaster = /m\.?tech|mca|m\.?sc|m\.?e\.?|master|postgraduate|post graduate/i.test(normVal);
    const isDoctorate = /ph\.?d|doctorate/i.test(normVal);
    const isDiploma = /diploma|vocational/i.test(normVal);

    for (const opt of options) {
      const optL = opt.toLowerCase();
      if (
        isBachelor &&
        (optL.includes('bachelor') ||
          optL.includes('undergraduate') ||
          optL.includes('graduate') ||
          optL.includes('b.tech') ||
          optL.includes('b.e'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Education: Bachelor/Undergraduate match' };
      }
      if (
        isMaster &&
        (optL.includes('master') ||
          optL.includes('postgraduate') ||
          optL.includes('post graduate') ||
          optL.includes('m.tech') ||
          optL.includes('mca'))
      ) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Education: Master/Postgraduate match' };
      }
      if (isDoctorate && (optL.includes('phd') || optL.includes('doctorate'))) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Education: Doctorate match' };
      }
      if (isDiploma && optL.includes('diploma')) {
        return { matchedOption: opt, confidence: 0.95, reason: 'Education: Diploma match' };
      }
    }
  }

  // 5. Numeric / Experience Years & Range Alignment
  const numericValMatch = normVal.match(/^(\d+(?:\.\d+)?)/);
  if (numericValMatch) {
    const num = parseFloat(numericValMatch[1]);

    if (num === 0) {
      // Find 0 / None / Less than 1
      const zeroOpt = options.find(
        o =>
          /^(0|0\s*years?|none|no experience|less than 1\s*year?|0\s*-\s*1)$/i.test(o.trim()) ||
          o.trim().toLowerCase().startsWith('0') ||
          o.trim().toLowerCase().includes('none'),
      );
      if (zeroOpt) {
        return { matchedOption: zeroOpt, confidence: 0.95, reason: 'Numeric zero/none match' };
      }
    }

    // Check if options contain ranges (e.g. "1 - 3 years", "3 - 5 years")
    for (const opt of options) {
      const range = parseOptionNumericRange(opt);
      if (range) {
        if (num >= range.min && num <= range.max) {
          return { matchedOption: opt, confidence: 0.92, reason: `Numeric range match [${range.min}-${range.max}]` };
        }
      }
    }

    // Check if options contain exact number token
    for (const opt of options) {
      const optClean = opt.trim();
      const regex = new RegExp(`(?:^|[^0-9])${num}(?:$|[^0-9])`);
      if (regex.test(optClean)) {
        return { matchedOption: opt, confidence: 0.88, reason: `Exact numeric token "${num}" match` };
      }
    }
  }

  // 6. Substring / Inclusion Matching
  for (const opt of options) {
    const optClean = opt.toLowerCase().trim();
    if (optClean.includes(normVal) || (normVal.length > 3 && normVal.includes(optClean))) {
      return { matchedOption: opt, confidence: 0.85, reason: 'Substring inclusion match' };
    }
  }

  // 7. Token Overlap / Jaccard Similarity Scoring
  const valTokens = new Set(
    normVal
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !['a', 'an', 'the', 'in', 'of', 'for', 'with', 'to'].includes(t)),
  );

  if (valTokens.size > 0) {
    let bestOption = options[0];
    let bestScore = 0;

    for (const opt of options) {
      const optTokens = new Set(
        opt
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(t => t.length > 1 && !['a', 'an', 'the', 'in', 'of', 'for', 'with', 'to'].includes(t)),
      );

      let common = 0;
      for (const t of valTokens) {
        if (optTokens.has(t)) common++;
      }

      const union = new Set([...valTokens, ...optTokens]).size;
      const score = union > 0 ? common / union : 0;

      if (score > bestScore) {
        bestScore = score;
        bestOption = opt;
      }
    }

    if (bestScore >= 0.3) {
      return {
        matchedOption: bestOption,
        confidence: Math.min(0.8, bestScore),
        reason: `Token overlap similarity (${Math.round(bestScore * 100)}%)`,
      };
    }
  }

  // Default fallback if no match found
  return {
    matchedOption: options[0],
    confidence: 0.3,
    reason: 'Default fallback (lowest confidence)',
  };
}
