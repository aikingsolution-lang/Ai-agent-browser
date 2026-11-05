/**
 * Multi-choice checkbox questions on LinkedIn Easy Apply ("Which of the following have you
 * personally owned in your recent role?" with 6-8 options).
 *
 * Such a question needs a SET of options, chosen from the candidate's own data:
 *  - an option is selected only when the candidate's job titles, skills, work-history
 *    descriptions, resume or background narrative mention what the option claims;
 *  - exclusive options ("Only implementing designs provided by others", "None of the above")
 *    are never auto-selected and are never combined with any other option;
 *  - answers coming from saved answers or the AI are parsed into exact option strings, and the
 *    same contradiction rule is applied.
 */
import type { ICareerBrain } from '@extension/storage';

/** "Only …", "None of the above", "No …", "Not …", "I have not …" — a claim that excludes the rest. */
export function isExclusiveChoiceOption(option: string): boolean {
  const t = String(option || '')
    .trim()
    .toLowerCase();
  return (
    /^(?:only|none|not|never|no)\b/.test(t) ||
    /^i\s+(?:have\s+not|haven'?t|did\s+not|didn'?t|do\s+not|don'?t)\b/.test(t) ||
    /\bnone of (?:the|these) (?:above|options)\b/.test(t)
  );
}

export function normalizeChoiceText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Specific work activities an option can claim. Broad words ("build", "React", "components",
 * "code", "developers", "designs") are deliberately absent: they appear in almost every resume
 * and prove nothing on their own.
 */
interface Concept {
  id: string;
  /** Recognises the concept in the OPTION text. */
  option: RegExp;
  /** Evidence for the concept in the CANDIDATE's own text. */
  evidence: RegExp;
}

const CONCEPTS: Concept[] = [
  {
    id: 'features',
    option: /\bfeatures?\b/,
    evidence:
      /\b(?:features?|functionalit(?:y|ies)|modules?|end[- ]to[- ]end|user stor(?:y|ies)|workflows?|dashboards?)\b/,
  },
  {
    id: 'requirements',
    option: /\brequirements?\b|\bspecs?\b/,
    evidence:
      /\b(?:requirements?|specs?|specifications?|user stor(?:y|ies)|stakeholders?|clients?|business needs?|product managers?|product owners?)\b/,
  },
  {
    id: 'production',
    option: /\bproduction\b|\bprod\b|\blive\b/,
    evidence:
      /\b(?:production|prod|deploy(?:ed|ing|ment|ments|s)?|shipp(?:ed|ing)|releas(?:ed|es|ing)|go[- ]live|launch(?:ed|ing)?|live users?|ci ?\/ ?cd)\b/,
  },
  {
    id: 'reusable',
    option: /\breusable\b|\bre-usable\b|\bshared\b/,
    evidence:
      /\b(?:reusable|re-usable|component librar(?:y|ies)|design systems?|shared (?:ui )?components?|ui kits?|storybook|common components?)\b/,
  },
  {
    id: 'architecture',
    option: /\barchitect(?:ure|ural|ing|ed)?\b/,
    evidence:
      /\b(?:architect(?:ed|ing|ure|ural)?|system design|technical design|design decisions?|technical decisions?|micro[- ]?frontends?|monorepo)\b/,
  },
  {
    id: 'decisions',
    option: /\bdecisions?\b|\bdecid(?:e|ing)\b/,
    evidence:
      /\b(?:decisions?|decided|led|lead|leading|owned|ownership|chose|evaluated|proposed|drove|spearheaded|championed)\b/,
  },
  {
    id: 'performance',
    option: /\bperformance\b|\bspeed\b/,
    evidence:
      /\b(?:performance|optimi[sz](?:ed|ing|ation|ations)|latency|load(?:ing)? times?|page speed|lighthouse|web vitals|lazy[- ]?load(?:ing|ed)?|memoi[sz](?:ed|ing|ation)|code[- ]splitting|bundle size|caching|faster)\b/,
  },
  {
    id: 'improve',
    option: /\bimprov(?:e|es|ing|ed)\b|\boptimi[sz](?:e|es|ing)\b|\benhanc(?:e|es|ing)\b/,
    evidence:
      /\b(?:improv(?:ed|ing|ement|ements)|optimi[sz](?:ed|ing|ation)|enhanc(?:ed|ing|ement)|reduc(?:ed|ing)|increas(?:ed|ing)|boost(?:ed|ing))\b/,
  },
  {
    id: 'tests',
    option: /\btests?\b|\btesting\b/,
    evidence:
      /\b(?:tests?|testing|tested|jest|vitest|mocha|jasmine|cypress|playwright|selenium|enzyme|testing library|e2e|tdd|test coverage)\b/,
  },
  {
    id: 'review',
    option: /\breview(?:s|ing|ed)?\b/,
    evidence:
      /\b(?:code reviews?|reviewed (?:code|pull requests?|prs)|reviewing (?:code|pull requests?)|pull requests?|peer reviews?)\b/,
  },
  {
    id: 'support',
    option: /\bsupport(?:ing)?\b|\bmaintain(?:ing)?\b|\bon[- ]call\b/,
    evidence:
      /\b(?:support(?:ed|ing)?|maintain(?:ed|ing)|maintenance|on[- ]call|incidents?|troubleshoot(?:ed|ing)?|debug(?:ged|ging)?|hot ?fix(?:es|ed)?|bug ?fix(?:es|ed|ing)?|resolv(?:ed|ing))\b/,
  },
  {
    id: 'issues',
    option: /\bissues?\b|\bbugs?\b|\bincidents?\b/,
    evidence:
      /\b(?:issues?|bugs?|incidents?|defects?|outages?|hot ?fix(?:es|ed)?|debug(?:ged|ging)?|troubleshoot(?:ed|ing)?)\b/,
  },
];

/** Everything the candidate wrote about themselves, lower-cased. */
export function candidateEvidenceText(careerBrain: Partial<ICareerBrain> | null | undefined): string {
  if (!careerBrain) return '';
  const roles = Array.isArray(careerBrain.workExperience) ? careerBrain.workExperience : [];
  return [
    careerBrain.currentTitle || '',
    ...roles.map(r => `${r.title || ''} ${r.description || ''}`),
    ...(careerBrain.skills || []),
    ...(careerBrain.autoExtractedSkills || []),
    careerBrain.backgroundNarrative || '',
    careerBrain.resumeText || '',
  ]
    .join('\n')
    .toLowerCase();
}

export interface OptionEvidence {
  option: string;
  exclusive: boolean;
  supported: boolean;
  /** Concept ids (or option words) the candidate's text supports / does not support. */
  found: string[];
  missing: string[];
}

const OPTION_FILLER_WORDS = new Set(
  (
    'and the for with from into via per etc other others your you have has had our their its this that these those ' +
    'all any some such both more less than not none only own owned personally recent current role roles related ' +
    'based using use used work working worked experience experienced year years level skill skills knowledge ' +
    'field fields area areas including includes include'
  ).split(' '),
);

const optionWords = (s: string): string[] =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

// 5-letter stems: "analyst" / "analytics" / "analysis", "developer" / "development".
const stemOf = (w: string): string => w.slice(0, 5);

/**
 * Word-level evidence for an option outside the concept table (e.g. "Data Analytics" under
 * "Current IT Specialization"). Every meaningful word of the option must appear in the
 * candidate's data, and on average at the strength of a skill (job title = 3, skills = 2,
 * resume / role descriptions = 1, needed average >= 1.5) — a word buried once in the resume
 * ("management", "technology") is not enough to claim the option.
 */
function assessByOptionWords(
  option: string,
  careerBrain: Partial<ICareerBrain> | null | undefined,
): { found: string[]; missing: string[]; supported: boolean } {
  const tokens = Array.from(
    new Set(
      optionWords(option)
        .filter(w => w.length >= 3 && !OPTION_FILLER_WORDS.has(w))
        .map(stemOf),
    ),
  );
  if (!careerBrain || tokens.length === 0) return { found: [], missing: tokens, supported: false };
  const roles = Array.isArray(careerBrain.workExperience) ? careerBrain.workExperience : [];
  const stemsOf = (parts: string[]) => new Set(parts.flatMap(optionWords).map(stemOf));
  const layers: Array<[Set<string>, number]> = [
    [stemsOf([careerBrain.currentTitle || '', ...roles.map(r => r.title || '')]), 3],
    [stemsOf([...(careerBrain.skills || []), ...(careerBrain.autoExtractedSkills || [])]), 2],
    [
      stemsOf([
        String(careerBrain.resumeText || ''),
        careerBrain.backgroundNarrative || '',
        ...roles.map(r => r.description || ''),
      ]),
      1,
    ],
  ];
  const weights = tokens.map(t => Math.max(0, ...layers.map(([set, w]) => (set.has(t) ? w : 0))));
  const found = tokens.filter((_, i) => weights[i] > 0);
  const missing = tokens.filter((_, i) => weights[i] === 0);
  const average = weights.reduce((a, b) => a + b, 0) / tokens.length;
  return { found, missing, supported: missing.length === 0 && average >= 1.5 };
}

/**
 * Decides, option by option, whether the candidate's own data supports it. Options naming known
 * work activities use the concept table: a specific concept must be evidenced ("reusable" for
 * "Designing reusable React components") and at least 60 % of an option's specific concepts must
 * be found. Any other option needs every one of its words in the candidate's data (see
 * `assessByOptionWords`). Exclusive options are never supported.
 */
export function assessCheckboxOptions(
  options: string[],
  careerBrain: Partial<ICareerBrain> | null | undefined,
): OptionEvidence[] {
  const corpus = candidateEvidenceText(careerBrain);
  return options.map(option => {
    const exclusive = isExclusiveChoiceOption(option);
    const text = normalizeChoiceText(option);
    const specific = CONCEPTS.filter(c => c.option.test(text));
    if (specific.length === 0) {
      // Broad words alone ("developers", "code", "components") prove nothing — judge the
      // option by all of its words instead.
      const byWords = assessByOptionWords(option, careerBrain);
      return { option, exclusive, ...byWords, supported: !exclusive && byWords.supported };
    }
    const found = specific.filter(c => c.evidence.test(corpus)).map(c => c.id);
    const missing = specific.filter(c => !found.includes(c.id)).map(c => c.id);
    const supported = !exclusive && found.length > 0 && found.length / specific.length >= 0.6 && Boolean(corpus);
    return { option, exclusive, supported, found, missing };
  });
}

/** Options the candidate's own data supports (never an exclusive option). */
export function selectEvidenceSupportedOptions(
  options: string[],
  careerBrain: Partial<ICareerBrain> | null | undefined,
): { selected: string[]; assessment: OptionEvidence[] } {
  const assessment = assessCheckboxOptions(options, careerBrain);
  return { selected: assessment.filter(a => a.supported).map(a => a.option), assessment };
}

/**
 * Keeps a consistent selection: an exclusive option never stays next to another option, and two
 * exclusive options contradict each other (neither is kept).
 */
export function resolveChoiceContradictions(selected: string[]): { kept: string[]; dropped: string[] } {
  const exclusive = selected.filter(isExclusiveChoiceOption);
  const normal = selected.filter(o => !isExclusiveChoiceOption(o));
  if (normal.length > 0) return { kept: normal, dropped: exclusive };
  if (exclusive.length > 1) return { kept: [], dropped: exclusive };
  return { kept: exclusive, dropped: [] };
}

/**
 * Turns an answer for a multi-choice question (saved answer, AI reply, "A | B", "A, B", a JSON
 * array) into exact option strings. Unknown parts are reported, never guessed.
 */
export function parseMultiSelectAnswer(
  answer: string | string[],
  options: string[],
): { matched: string[]; unmatched: string[] } {
  const exactOf = (part: string) => options.find(o => normalizeChoiceText(o) === normalizeChoiceText(part));
  let parts: string[] | null = null;
  if (Array.isArray(answer)) {
    parts = answer.map(String);
  } else {
    const text = String(answer || '').trim();
    if (text.startsWith('[')) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr)) parts = arr.map(String);
      } catch {
        // not JSON — fall through to text splitting
      }
    }
    if (!parts) {
      if (exactOf(text)) {
        parts = [text];
      } else {
        parts = text
          .split(/\s*(?:\||;|\n|•)\s*/)
          .map(p => p.trim())
          .filter(Boolean);
        if (parts.length === 1) {
          const commaParts = text
            .split(/\s*,\s*/)
            .map(p => p.trim())
            .filter(Boolean);
          if (commaParts.length > 1 && commaParts.every(p => exactOf(p))) parts = commaParts;
        }
      }
    }
  }
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const raw of parts) {
    const part = raw.replace(/^[-*\s"']+|["'\s]+$/g, '').trim();
    if (!part) continue;
    let option = exactOf(part);
    if (!option) {
      const p = normalizeChoiceText(part);
      const partial = options.filter(o => {
        const n = normalizeChoiceText(o);
        return p.length >= 6 && n.length >= 6 && (n.includes(p) || p.includes(n));
      });
      if (partial.length === 1) option = partial[0];
    }
    if (option) {
      if (!matched.includes(option)) matched.push(option);
    } else {
      unmatched.push(part);
    }
  }
  return { matched, unmatched };
}
