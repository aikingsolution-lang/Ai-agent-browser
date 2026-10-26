// chrome-extension/src/background/agent/intelligence/answerGuard.ts

import { alignValueToOptions } from './smartOptionAligner';

export interface AnswerGuardResult {
  valid: boolean;
  value: string;
  reason?: string;
  wasConverted?: boolean;
  sourceNote?: string;
}

export interface GuardFieldDescriptor {
  id?: string;
  label?: string;
  fieldType?: string;
  options?: string[];
  isTextArea?: boolean;
  placeholder?: string;
  hintText?: string;
  min?: number;
  max?: number;
  [key: string]: any;
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
];

/**
 * Universal Answer Guard across LinkedIn, Indeed, and Naukri.
 * Validates that an answer strictly matches the expected field type and format before DOM injection:
 * 1. Reject empty or whitespace-only answers.
 * 2. Reject long prose / multi-sentence text in non-textarea fields (salary, name, skill, number, short text).
 * 3. Reject non-numeric answers in numeric/decimal fields.
 * 4. Reject dropdown/radio answers that do not match available options (no invented defaults).
 * 5. Reject invalid date formats for date/month/year fields.
 */
export function validateAnswerForField(
  rawAnswer: string | number | undefined | null,
  field: GuardFieldDescriptor,
): AnswerGuardResult {
  // 1. Empty / null check
  if (rawAnswer === undefined || rawAnswer === null) {
    return { valid: false, value: '', reason: 'Answer is undefined or null' };
  }

  const answer = String(rawAnswer).trim();
  if (!answer) {
    return { valid: false, value: '', reason: 'Answer is empty or whitespace-only' };
  }

  const labelLower = (field.label || '').toLowerCase();
  const hintLower = `${field.hintText || ''} ${field.placeholder || ''}`.toLowerCase();
  const combinedContext = `${labelLower} ${hintLower}`;
  const isTextArea = Boolean(field.isTextArea || field.fieldType === 'textarea');

  // Check for multi-sentence or prose structure
  const hasMultipleSentences =
    /[\r\n]/.test(answer) || /[.!?]\s+[A-Za-z0-9]/.test(answer) || answer.split(/[.!?]+\s+/).filter(Boolean).length > 1;

  // 2. Prose Guard: Non-textarea fields must reject long prose answers
  const isShortOrRestrictedField =
    field.fieldType === 'number' ||
    field.fieldType === 'radio' ||
    field.fieldType === 'checkbox' ||
    field.fieldType === 'select' ||
    field.fieldType === 'dropdown' ||
    field.fieldType === 'date' ||
    /\b(?:salary|ctc|compensation|pay|package|lakhs?|lpa|inr|stipend)\b/i.test(labelLower) ||
    /\b(?:how\s*many|years\s*of|experience|yoe)\b/i.test(labelLower) ||
    /\b(?:notice\s*period|joining\s*time|availability)\b/i.test(labelLower) ||
    /\b(?:first\s*name|last\s*name|full\s*name|name)\b/i.test(labelLower) ||
    /\b(?:phone|mobile|cell|contact\s*number)\b/i.test(labelLower) ||
    /\b(?:skill|skills|tool|tools|technology)\b/i.test(labelLower) ||
    /\b(?:location|city|country|postal|zip|state|pincode)\b/i.test(labelLower);

  if (!isTextArea) {
    if (isShortOrRestrictedField) {
      if (answer.length > 40 || hasMultipleSentences) {
        return {
          valid: false,
          value: '',
          reason: `Rejected long prose (${answer.length} chars / sentences) for short/restricted field "${field.label}"`,
        };
      }
    } else {
      // General single-line input field
      if (hasMultipleSentences || answer.length > 120) {
        return {
          valid: false,
          value: '',
          reason: `Rejected multi-sentence prose for single-line input field "${field.label}"`,
        };
      }
    }
  }

  // 3. Dropdown / Select / Radio: Must match one of the available options
  const isChoiceField =
    field.fieldType === 'dropdown' ||
    field.fieldType === 'select' ||
    field.fieldType === 'radio' ||
    (Array.isArray(field.options) && field.options.length > 0 && field.fieldType !== 'text');

  if (isChoiceField && Array.isArray(field.options) && field.options.length > 0) {
    const validOptions = field.options
      .map(o => (typeof o === 'string' ? o.trim() : String(o || '').trim()))
      .filter(o => o && !/^(?:select\s*(?:an\s*)?option|choose(?:\s*an\s*option)?|--\s*select\s*--|\.\.\.)$/i.test(o));

    if (validOptions.length > 0) {
      // Direct exact case-insensitive match
      const exactMatch = validOptions.find(o => o.toLowerCase() === answer.toLowerCase());
      if (exactMatch) {
        return { valid: true, value: exactMatch, wasConverted: exactMatch !== answer };
      }

      // Boolean Yes/No matching
      const isYes = /^(?:yes|true|y|1)$/i.test(answer);
      const isNo = /^(?:no|false|n|0)$/i.test(answer);
      if (isYes || isNo) {
        const yesOpt = validOptions.find(o => /^yes\b|^i agree\b|^agree\b/i.test(o));
        const noOpt = validOptions.find(o => /^no\b|^i disagree\b|^disagree\b/i.test(o));
        if (isYes && yesOpt) {
          return { valid: true, value: yesOpt, wasConverted: yesOpt !== answer };
        }
        if (isNo && noOpt) {
          return { valid: true, value: noOpt, wasConverted: noOpt !== answer };
        }
      }

      // Semantic/smart option aligner
      const aligned = alignValueToOptions(answer, validOptions, combinedContext);
      if (aligned && aligned.matchedOption && aligned.confidence >= 0.7) {
        return {
          valid: true,
          value: aligned.matchedOption,
          wasConverted: aligned.matchedOption !== answer,
          sourceNote: `Option aligned: "${aligned.matchedOption}" (${aligned.reason})`,
        };
      }

      return {
        valid: false,
        value: '',
        reason: `Answer "${answer}" does not match any available option in [${validOptions.slice(0, 5).join(', ')}]`,
      };
    }
  }

  // 4. Date Fields (Month / Year / Full Date)
  const isMonthField =
    (/\b(?:from|start|to|end)?\s*month\b|\bmonth\s+(?:of\s+)?(?:from|start|to|end)\b/i.test(labelLower) ||
      /^(?:start|from|end|to)\s*month$/i.test(labelLower)) &&
    !/how\s*many|notice\s*period|ctc|salary/i.test(labelLower);

  const isYearField =
    (/\b(?:from|start|to|end)?\s*year\b|\byear\s+(?:of\s+)?(?:from|start|to|end)\b/i.test(labelLower) ||
      /^(?:start|from|end|to)\s*year$/i.test(labelLower)) &&
    !/how\s*many|years\s*of|notice\s*period|ctc|salary/i.test(labelLower);

  const isFullDateField =
    field.fieldType === 'date' ||
    (/\b(?:date\s+of\s+birth|dob|birth\s+date|start\s+date|end\s+date|joining\s+date|available\s+date)\b/i.test(
      labelLower,
    ) &&
      !/how\s*many|notice\s*period/i.test(labelLower));

  if (isMonthField) {
    const cleanMonth = answer.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isNumMonth = /^\d{1,2}$/.test(cleanMonth) && parseInt(cleanMonth, 10) >= 1 && parseInt(cleanMonth, 10) <= 12;
    const isNameMonth = MONTH_NAMES.includes(cleanMonth);
    if (isNumMonth || isNameMonth) {
      return { valid: true, value: answer, wasConverted: false };
    }
    return { valid: false, value: '', reason: `Invalid month value "${answer}"` };
  }

  if (isYearField) {
    const cleanYear = answer.replace(/\D/g, '');
    if (/^(?:19|20)\d{2}$/.test(cleanYear)) {
      return { valid: true, value: cleanYear, wasConverted: cleanYear !== answer };
    }
    return { valid: false, value: '', reason: `Invalid year value "${answer}"` };
  }

  if (isFullDateField) {
    const ddmmyyyy = answer.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    const yyyymmdd = answer.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (ddmmyyyy || yyyymmdd) {
      return { valid: true, value: answer, wasConverted: false };
    }
    return { valid: false, value: '', reason: `Invalid date format "${answer}" (expected DD/MM/YYYY or YYYY-MM-DD)` };
  }

  // 5. Numeric / Decimal fields
  const isNumericField =
    field.fieldType === 'number' ||
    /whole\s*number|only\s*(?:whole\s*)?numbers|digits?\s*only|decimal\s*number|larger\s*than|greater\s*than/i.test(
      combinedContext,
    ) ||
    /example:\s*\d+/i.test(hintLower);

  const isNoticePeriod = /notice\s*period|how\s*soon\s*can\s*you\s*start|availability\s*to\s*join|joining\s*time/i.test(
    labelLower,
  );

  const isSalaryQuestion =
    /(?:current|present|existing|fixed|annual|expected|target|desired|seeking)?\s*(?:ctc|salary|compensation)\b/i.test(
      labelLower,
    );

  const isExpQuestion =
    /\b(?:how\s*many\s*years|years\s*of|years\s*with|\(in\s*years?\)|number\s*of\s*years)\b/i.test(labelLower) ||
    /\b(?:years?\s*of\s*experience|total\s*years)\b/i.test(hintLower);

  if (isNumericField || isNoticePeriod || isSalaryQuestion || (isExpQuestion && !isTextArea)) {
    // If answer contains NO digits and is not a convertible word like "Immediate", reject
    if (!/\d/.test(answer) && !/^(?:immediate|immediately|now|none)$/i.test(answer)) {
      return {
        valid: false,
        value: '',
        reason: `Non-numeric answer "${answer}" rejected for numeric/salary/experience field "${field.label}"`,
      };
    }

    // Notice period conversion
    if (isNoticePeriod) {
      if (/^(?:immediate|immediately|now|none|0|0\s*days?)$/i.test(answer)) {
        const minVal = field.min;
        const requiresGreaterThanZero =
          (minVal !== undefined && minVal > 0) || /larger\s+than\s+0|greater\s+than\s+0/i.test(combinedContext);
        const val = requiresGreaterThanZero ? '1' : '0';
        return { valid: true, value: val, wasConverted: true };
      }
      const numMatch = answer.match(/\d+(?:\.\d+)?/);
      if (numMatch) {
        return { valid: true, value: numMatch[0], wasConverted: numMatch[0] !== answer };
      }
    }

    // Salary / CTC conversion
    if (isSalaryQuestion) {
      const expectsLPA =
        /\bin\s*lpa\b|\blpa\b|\bin\s*lakhs?\b|\blacs?\b/i.test(labelLower) ||
        /example:\s*\d{1,2}(?:\.\d+)?\b/i.test(hintLower);

      // Check "X LPA" or "X Lakhs"
      const lpaMatch = answer.match(/^₹?\s*(?:rs\.?)?\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:lpa|lakhs?|lacs?|l)\b/i);
      if (lpaMatch) {
        const num = parseFloat(lpaMatch[1].replace(/,/g, ''));
        const finalVal = expectsLPA ? String(num) : String(Math.round(num * 100000));
        return { valid: true, value: finalVal, wasConverted: true };
      }

      // Check pure numbers or currency
      const cleanedNum = answer.replace(/[₹$,\s]|(?:rs\.?)|(?:inr)/gi, '');
      const parsed = parseFloat(cleanedNum);
      if (!isNaN(parsed) && /^\d+(?:\.\d+)?$/.test(cleanedNum)) {
        if (expectsLPA) {
          const lpa = parsed > 100 ? parsed / 100000 : parsed;
          return { valid: true, value: String(lpa), wasConverted: true };
        } else {
          const inr = parsed <= 100 ? Math.round(parsed * 100000) : Math.round(parsed);
          return { valid: true, value: String(inr), wasConverted: true };
        }
      }

      // Range extraction: take first number
      const firstNum = answer.match(/(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)/);
      if (firstNum) {
        const parsedRange = parseFloat(firstNum[1].replace(/,/g, ''));
        if (!isNaN(parsedRange) && parsedRange > 0) {
          if (expectsLPA) {
            const lpa = parsedRange > 100 ? parsedRange / 100000 : parsedRange;
            return { valid: true, value: String(lpa), wasConverted: true };
          } else {
            const inr = parsedRange <= 100 ? Math.round(parsedRange * 100000) : Math.round(parsedRange);
            return { valid: true, value: String(inr), wasConverted: true };
          }
        }
      }

      return { valid: false, value: '', reason: `Could not parse numeric salary from "${answer}"` };
    }

    // Experience extraction (e.g. "3 years" -> "3")
    if (isExpQuestion) {
      const expMatch = answer.match(/(\d+(?:\.\d+)?)/);
      if (expMatch) {
        const requiresWhole = /whole\s*number/i.test(combinedContext);
        const num = parseFloat(expMatch[1]);
        const finalVal = requiresWhole ? String(Math.round(num)) : expMatch[1];
        return { valid: true, value: finalVal, wasConverted: finalVal !== answer };
      }
      return { valid: false, value: '', reason: `Could not parse numeric experience from "${answer}"` };
    }

    // General numeric field
    if (isNumericField) {
      const cleanDigits = answer.replace(/[,\s]/g, '');
      if (/^-?\d+(?:\.\d+)?$/.test(cleanDigits)) {
        return { valid: true, value: cleanDigits, wasConverted: cleanDigits !== answer };
      }
      const numExtract = answer.match(/(\d+(?:\.\d+)?)/);
      if (numExtract) {
        return { valid: true, value: numExtract[1], wasConverted: true };
      }
      return { valid: false, value: '', reason: `Numeric field received non-numeric value "${answer}"` };
    }
  }

  // 6. URL Fields
  const isUrlField =
    /\b(?:website|portfolio|github|linkedin|profile\s*link|url)\b/i.test(labelLower) && !isNumericField;
  if (isUrlField) {
    let cleanUrl = answer.trim();
    if (
      !/^https?:\/\//i.test(cleanUrl) &&
      /^[a-zA-Z0-9][-a-zA-Z0-9+&@#/%?=~_|!:,.;]*\.[a-zA-Z]{2,}(?:[-a-zA-Z0-9+&@#/%=~_|]*)?$/i.test(cleanUrl)
    ) {
      cleanUrl = `https://${cleanUrl}`;
      return { valid: true, value: cleanUrl, wasConverted: true };
    }
    return { valid: true, value: cleanUrl, wasConverted: cleanUrl !== answer };
  }

  return { valid: true, value: answer, wasConverted: false };
}
