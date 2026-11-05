/**
 * Grounded street-address and postal-code resolution for LinkedIn Easy Apply.
 *
 * Address answers are facts about the candidate, so they come from exactly two places:
 *   1. answers the candidate saved in Career Brain (golden answers / custom answers), and
 *   2. the candidate's own resume text (an explicit "Address:" line, a labelled PIN/ZIP code,
 *      or a resume-header entry that ends with a postal code).
 *
 * Nothing here guesses a street, reuses the city as a street, or pads a postal code. When no
 * grounded value exists the resolver returns an empty answer and the caller must leave the
 * field blank — it must never be handed to an LLM or a "Not applicable" fallback.
 */
import { STANDARD_LOCATIONS, type ICareerBrain } from '@extension/storage';

export type AddressFieldKind = 'street' | 'addressLine2' | 'postalCode' | 'fullAddress';

export interface CandidateLocationHint {
  location?: string;
  city?: string;
  state?: string;
  country?: string;
}

export interface ParsedAddress {
  /** The address as written by the candidate, with contact details stripped. */
  full: string;
  street?: string;
  postalCode?: string;
}

export interface CandidateAddress {
  full?: string;
  street?: string;
  postalCode?: string;
  fullSource?: string;
  streetSource?: string;
  postalSource?: string;
}

export interface GroundedAddressAnswer {
  kind: AddressFieldKind;
  /** Grounded value, or '' when the candidate has no such detail on file. */
  answer: string;
  sourceDetail: string;
}

type AddressFieldLike = { label?: string; fieldType?: string };

// ── Label classification ─────────────────────────────────────────────────────

const QUALIFIERS =
  '(?:(?:home|current|present|permanent|residential|residence|mailing|correspondence|communication|local|your)\\s+)*';

const POSTAL_LABEL_RE = new RegExp(
  `^${QUALIFIERS}(?:area\\s+)?(?:postal\\s*code|post\\s*code|postcode|zip(?:\\s*code)?|zip\\s*(?:\\/|or|&)\\s*postal(?:\\s*code)?|postal\\s*(?:\\/|or|&)\\s*zip(?:\\s*code)?|pin\\s*code|pincode|postal\\s*index\\s*number)$`,
);
const ADDRESS_LINE2_RE = /^(?:street\s*)?address\s*line\s*(?:2|two)$/;
const STREET_LABEL_RE = new RegExp(
  `^${QUALIFIERS}(?:street(?:\\s*address)?(?:\\s*line\\s*(?:1|one))?|address\\s*line\\s*(?:1|one)|street\\s*name(?:\\s*(?:and|&)\\s*(?:house\\s*)?(?:number|no))?|house\\s*(?:number|no)\\s*(?:and|&)\\s*street(?:\\s*name)?)$`,
);
const FULL_ADDRESS_LABEL_RE = new RegExp(`^${QUALIFIERS}(?:(?:postal|full|complete)\\s+)?address$`);

/** Lower-cases a field label and strips LinkedIn decorations ("*", "(optional)", repeated text). */
export function normalizeAddressLabel(raw: string | null | undefined): string {
  let s = String(raw || '')
    .toLowerCase()
    // Zero-width / format characters (U+200B–U+200D, U+FEFF) that LinkedIn labels can carry.
    .replace(/\p{Cf}/gu, '')
    .replace(/\(\s*(?:optional|required)\s*\)/g, ' ')
    .replace(/\b(?:optional|required)\b/g, ' ')
    .replace(/[*:?.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // LinkedIn repeats the visible label for screen readers ("postal code postal code").
  const words = s.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(' ');
    if (first === words.slice(half).join(' ')) s = first;
  }
  return s;
}

/**
 * Returns the address component a form field asks for, or null when the field is not an
 * address input. Only free-text inputs qualify: a radio/checkbox/dropdown that mentions an
 * address is a different question (e.g. "Is your address in Karnataka?").
 */
export function classifyAddressField(field: AddressFieldLike | string | null | undefined): AddressFieldKind | null {
  if (!field) return null;
  const label = typeof field === 'string' ? field : field.label || '';
  const fieldType = typeof field === 'string' ? undefined : field.fieldType;
  if (fieldType && fieldType !== 'text' && fieldType !== 'number' && fieldType !== 'textarea') return null;
  const norm = normalizeAddressLabel(label);
  if (!norm || norm.length > 60) return null;
  if (POSTAL_LABEL_RE.test(norm)) return 'postalCode';
  if (ADDRESS_LINE2_RE.test(norm)) return 'addressLine2';
  if (STREET_LABEL_RE.test(norm)) return 'street';
  if (FULL_ADDRESS_LABEL_RE.test(norm)) return 'fullAddress';
  return null;
}

// ── Place knowledge (separates the street from city / state / country) ──────

const INDIA_STATES_AND_UTS = [
  'andhra pradesh',
  'arunachal pradesh',
  'assam',
  'bihar',
  'chhattisgarh',
  'goa',
  'gujarat',
  'haryana',
  'himachal pradesh',
  'jharkhand',
  'karnataka',
  'kerala',
  'madhya pradesh',
  'maharashtra',
  'manipur',
  'meghalaya',
  'mizoram',
  'nagaland',
  'odisha',
  'orissa',
  'punjab',
  'rajasthan',
  'sikkim',
  'tamil nadu',
  'telangana',
  'tripura',
  'uttar pradesh',
  'uttarakhand',
  'uttaranchal',
  'west bengal',
  'andaman and nicobar islands',
  'chandigarh',
  'dadra and nagar haveli and daman and diu',
  'daman and diu',
  'delhi',
  'new delhi',
  'nct of delhi',
  'delhi ncr',
  'ncr',
  'jammu and kashmir',
  'ladakh',
  'lakshadweep',
  'puducherry',
  'pondicherry',
  'up',
  'mp',
  'ap',
  'tn',
  'wb',
  'hp',
  'jk',
];

const COMMON_COUNTRIES = [
  'india',
  'bharat',
  'united states',
  'united states of america',
  'usa',
  'us',
  'united kingdom',
  'uk',
  'england',
  'scotland',
  'wales',
  'ireland',
  'canada',
  'australia',
  'new zealand',
  'germany',
  'france',
  'spain',
  'italy',
  'netherlands',
  'sweden',
  'switzerland',
  'poland',
  'singapore',
  'malaysia',
  'indonesia',
  'philippines',
  'japan',
  'china',
  'united arab emirates',
  'uae',
  'saudi arabia',
  'qatar',
  'oman',
  'kuwait',
  'bahrain',
  'sri lanka',
  'nepal',
  'bangladesh',
  'pakistan',
  'south africa',
];

/** Former / alternate names of major cities (not neighbourhoods — those belong to the street). */
const ALTERNATE_CITY_NAMES = [
  'bangalore',
  'bombay',
  'calcutta',
  'madras',
  'gurgaon',
  'trivandrum',
  'mysore',
  'mangalore',
  'baroda',
  'poona',
  'cochin',
  'vizag',
  'benares',
  'secunderabad',
];

const US_STATE_CODES = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
]);

function normPlace(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\./g, '')
    .replace(/\b(?:dist|district|state of|urban|rural)\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let cachedBasePlaces: Set<string> | null = null;

function basePlaces(): Set<string> {
  if (cachedBasePlaces) return cachedBasePlaces;
  const set = new Set<string>();
  const add = (p?: string) => {
    const n = normPlace(p);
    if (n) set.add(n);
  };
  for (const loc of STANDARD_LOCATIONS) {
    if (loc.category === 'remote') continue;
    add(loc.city);
    add(loc.state);
    add(loc.country);
  }
  INDIA_STATES_AND_UTS.forEach(add);
  COMMON_COUNTRIES.forEach(add);
  ALTERNATE_CITY_NAMES.forEach(add);
  US_STATE_CODES.forEach(code => add(code));
  cachedBasePlaces = set;
  return set;
}

/** Known place names plus the candidate's own city / state / country. */
function knownPlacesFor(location?: CandidateLocationHint | null): Set<string> {
  const base = basePlaces();
  if (!location) return base;
  const extra = [location.city, location.state, location.country, ...(location.location || '').split(',')]
    .map(normPlace)
    .filter(p => p.length >= 2 && !base.has(p));
  if (extra.length === 0) return base;
  const set = new Set(base);
  extra.forEach(p => set.add(p));
  return set;
}

/**
 * Removes trailing place words from a segment ("MG Road Bengaluru" -> "MG Road"), working on
 * the original words so house numbers and punctuation survive. Two-letter codes are only ever
 * a whole segment ("TX"), never stripped from the end of a street ("Main St IN").
 */
function stripTrailingPlaceWords(segment: string, places: Set<string>): string {
  let words = segment.split(/\s+/).filter(Boolean);
  let changed = true;
  while (words.length > 1 && changed) {
    changed = false;
    for (let k = Math.min(4, words.length - 1); k >= 1; k--) {
      const tail = normPlace(words.slice(-k).join(' '));
      if (tail.length >= 3 && places.has(tail)) {
        words = words.slice(0, -k);
        changed = true;
        break;
      }
    }
  }
  return words.join(' ');
}

/** True when a segment is only place names (or only digits / punctuation). */
function isPlaceSegment(segment: string, places: Set<string>): boolean {
  let current = segment.trim();
  for (let guard = 0; guard < 6; guard++) {
    const n = normPlace(current);
    if (!n || places.has(n)) return true;
    const next = stripTrailingPlaceWords(current, places);
    if (next === current) return false;
    current = next;
  }
  return false;
}

function containsKnownPlace(text: string, places: Set<string>): boolean {
  const words = normPlace(text).split(' ').filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let k = 1; k <= 4 && i + k <= words.length; k++) {
      const gram = words.slice(i, i + k).join(' ');
      if (gram.length >= 3 && places.has(gram)) return true;
    }
  }
  return false;
}

// ── Postal code extraction ───────────────────────────────────────────────────

const POSTAL_SHAPES =
  '(\\d{3}\\s?\\d{3}|\\d{5}(?:-\\d{4})?|\\d{4}|[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}|[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d)';
/** Multi-word labels ("PIN code: 560038", "Postal code - 10115") — safe anywhere in a resume. */
const LABELED_POSTAL_STRICT_RE = new RegExp(
  `\\b(?:pin\\s*code|pincode|postal\\s*code|post\\s*code|postcode|zip\\s*code)\\b\\s*(?:no\\.?|number)?\\s*[:\\-–#]?\\s*${POSTAL_SHAPES}(?![A-Za-z0-9])`,
  'i',
);
/** Bare "PIN"/"ZIP" labels are trusted only inside an address string, and only for 5–6 digits. */
const LABELED_POSTAL_BARE_RE = /\b(?:pin|zip)\b\s*[:\-–#]?\s*(\d{3}\s?\d{3}|\d{5}(?:-\d{4})?)(?![A-Za-z0-9])/i;
const POSTAL_LABEL_WORDS_RE =
  /\b(?:pin\s*code|pincode|pin|postal\s*code|post\s*code|postcode|zip\s*code|zip)\b\s*(?:no\.?|number)?\s*[:\-–#]?/gi;
const IN_PIN_RE = /(?<![\d+])([1-9]\d{2})\s?(\d{3})(?!\d)/g;
const US_ZIP_RE = /\b([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?!\d)/g;
const CA_POSTAL_RE = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/;
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/;
const PLACE_THEN_ZIP_RE = /([A-Za-z][A-Za-z .'-]{1,40}?)\s*[,–-]?\s*(\d{5})(?!\d)(?!\s*[–-]\s*\d)/g;

function cleanPostalCandidate(raw: string): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  // Indian PINs are written "560 038" as often as "560038" — keep digits only.
  if (/^\d{3}\s?\d{3}$/.test(compact)) return compact.replace(/\s/g, '');
  return compact.toUpperCase();
}

/**
 * Extracts a postal / ZIP / PIN code from address text. Only formats with a clear signal are
 * accepted — an explicit label, an Indian 6-digit PIN, "ST 12345" for the US, Canadian / UK
 * postcodes, or 5 digits right after a known place name — so house numbers, years and phone
 * fragments are never mistaken for a postal code.
 */
export function extractPostalCode(text: string, location?: CandidateLocationHint | null): string | null {
  const src = String(text || '');
  if (!src.trim()) return null;

  const labeled = LABELED_POSTAL_STRICT_RE.exec(src) || LABELED_POSTAL_BARE_RE.exec(src);
  if (labeled) return cleanPostalCandidate(labeled[1]);

  const pins = Array.from(src.matchAll(IN_PIN_RE));
  if (pins.length > 0) {
    const last = pins[pins.length - 1];
    return `${last[1]}${last[2]}`;
  }

  for (const m of Array.from(src.matchAll(US_ZIP_RE)).reverse()) {
    if (US_STATE_CODES.has(m[1])) return m[2];
  }

  const ca = CA_POSTAL_RE.exec(src);
  if (ca) return `${ca[1]} ${ca[2]}`;

  const uk = UK_POSTCODE_RE.exec(src);
  if (uk) return `${uk[1]} ${uk[2]}`;

  const places = knownPlacesFor(location);
  for (const m of Array.from(src.matchAll(PLACE_THEN_ZIP_RE)).reverse()) {
    const before = normPlace(m[1]).split(' ');
    for (let k = Math.min(4, before.length); k >= 1; k--) {
      const tail = before.slice(-k).join(' ');
      if (tail.length >= 3 && places.has(tail)) return m[2];
    }
  }
  return null;
}

function postalRegexFor(postalCode: string): RegExp {
  if (/^\d{6}$/.test(postalCode)) return new RegExp(`${postalCode.slice(0, 3)}\\s?${postalCode.slice(3)}`);
  return new RegExp(postalCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'), 'i');
}

// ── Address parsing ──────────────────────────────────────────────────────────

const STREET_WORD_RE =
  /\b(?:road|rd|street|st|lane|ln|avenue|ave|marg|nagar|colony|layout|sector|block|phase|stage|cross|main|apartments?|apt|flat|floor|house|h\s?no|plot|villa|tower|residency|enclave|society|chowk|gali|mohalla|village|vill|near|opp|opposite|behind|building|bldg|complex|extension|extn|suite|unit|drive|boulevard|blvd|court|square|highway|bypass|township|vihar|puram|bagh|ganj|taluk|tehsil|mandal|ward|quarters|qtrs|estate|heights|post\s*office)\b/i;
const NON_ADDRESS_RE =
  /\b(?:engineer|developer|manager|analyst|intern|experience|skills?|summary|objective|university|college|school|institute|bachelor|master|b\s?tech|m\s?tech|resume|curriculum|linkedin|github|portfolio|email|phone|mobile|salary|ctc|lpa|notice|expected|days|years|months|cgpa|gpa|percentage|dob|birth|gender|nationality|marital|languages?|hobbies)\b/i;

/**
 * A street needs a house number or a street word. Résumé words ("college", "salary", ...)
 * disqualify text only when no street word is present ("Near St. Joseph's School, MG Road" is
 * still a street; "B.Tech, Amity University" is not).
 */
function looksLikeStreet(text: string): boolean {
  const hasStreetWord = STREET_WORD_RE.test(text);
  if (!hasStreetWord && !/\d/.test(text)) return false;
  return hasStreetWord || !NON_ADDRESS_RE.test(text);
}

/** Drops contact details (emails, URLs, phone numbers) that often share a line with the address. */
function stripContactNoise(raw: string): string {
  return String(raw || '')
    .replace(/\S+@\S+\.\S+/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b(?:linkedin|github)\.com\/\S*/gi, ' ')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|•·–-]+|[\s,;:|•·–-]+$/g, '')
    .trim();
}

/**
 * Splits an address written by the candidate into its street part and postal code. The street
 * is whatever precedes the trailing city / state / country / postal segments, and it must look
 * like a street (a house number or a street word) — otherwise it is dropped, never guessed.
 */
export function parseAddressComponents(raw: string, location?: CandidateLocationHint | null): ParsedAddress | null {
  const full = stripContactNoise(raw);
  if (!full || full.length < 4 || full.length > 220) return null;
  if (NON_ADDRESS_RE.test(full) && !STREET_WORD_RE.test(full)) return null;

  const postalCode = extractPostalCode(full, location) || undefined;
  let core = full;
  if (postalCode) core = core.replace(postalRegexFor(postalCode), ' ');
  core = core.replace(POSTAL_LABEL_WORDS_RE, ' ');

  const places = knownPlacesFor(location);
  const segments = core
    .split(/\s*,\s*|\s+[–-]\s+/)
    .map(s => s.replace(/^[\s.–-]+|[\s.–-]+$/g, '').trim())
    .filter(Boolean);

  let end = segments.length;
  while (end > 0 && isPlaceSegment(segments[end - 1], places)) end--;
  const streetSegments = segments.slice(0, end);
  if (streetSegments.length > 0) {
    streetSegments[streetSegments.length - 1] = stripTrailingPlaceWords(
      streetSegments[streetSegments.length - 1],
      places,
    );
  }
  let street = streetSegments.join(', ').replace(/\s+/g, ' ').trim();
  if (street && (!looksLikeStreet(street) || street.length > 120)) {
    street = '';
  }

  if (!street && !postalCode) return null;
  return { full, street: street || undefined, postalCode };
}

// ── Resume scanning ──────────────────────────────────────────────────────────

const EXPLICIT_ADDRESS_LINE_RE =
  /^\s*(?:(current|present|residential|home|local|communication|correspondence|mailing|postal|permanent)\s+)?(?:address|addr\.?)(?:\s+for\s+communication)?\s*[:\-–]\s*(.*)$/i;
const FOLLOWING_LABEL_RE =
  /\s*(?:[|•·]|\b(?:phone|mobile|mob|tel|email|e-mail|contact|linkedin|github|dob|date\s+of\s+birth|nationality|gender)\s*[:\-–])/i;
const LABEL_LINE_RE = /^\s*[A-Za-z][A-Za-z .()/&-]{1,40}\s*[:\-–]\s*/;

/** A header token is only an address when it ends with its postal code (country may follow). */
function endsWithPostal(text: string, postalCode: string, places: Set<string>): boolean {
  const rx = postalRegexFor(postalCode);
  let lastEnd = -1;
  const global = new RegExp(rx.source, `${rx.flags.replace('g', '')}g`);
  for (const m of text.matchAll(global)) lastEnd = (m.index ?? 0) + m[0].length;
  if (lastEnd < 0) return false;
  const tail = text.slice(lastEnd).replace(/^[\s,.;–-]+/, '');
  return !tail || isPlaceSegment(tail, places);
}

/**
 * Finds the candidate's address in resume text: an explicit "Address:" line (current /
 * present / residential preferred over permanent), else a resume-header entry that ends with a
 * postal code, else a labelled PIN/ZIP code. Returns null when the resume holds no address.
 */
export function findAddressInResumeText(
  resumeText: string,
  location?: CandidateLocationHint | null,
): (ParsedAddress & { sourceDetail: string }) | null {
  const text = String(resumeText || '');
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);

  const explicit: Array<{ value: string; permanent: boolean; index: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EXPLICIT_ADDRESS_LINE_RE.exec(lines[i]);
    if (!m) continue;
    let value = (m[2] || '').trim();
    // The address may continue on the next line(s): "Address:" alone, or a line ending in a comma.
    let j = i + 1;
    while (j < lines.length && j <= i + 2 && (!value || /,\s*$/.test(value))) {
      const next = lines[j].trim();
      if (!next || LABEL_LINE_RE.test(next)) break;
      value = value ? `${value} ${next}` : next;
      j++;
    }
    const cut = value.search(FOLLOWING_LABEL_RE);
    if (cut > 0) value = value.slice(0, cut);
    value = value.trim();
    if (value) explicit.push({ value, permanent: /permanent/i.test(m[1] || ''), index: i });
  }
  explicit.sort((a, b) => Number(a.permanent) - Number(b.permanent) || a.index - b.index);
  for (const cand of explicit) {
    const parsed = parseAddressComponents(cand.value, location);
    if (parsed) {
      return {
        ...parsed,
        sourceDetail: `resume: ${cand.permanent ? 'permanent ' : ''}address line ("${parsed.full.slice(0, 80)}")`,
      };
    }
  }

  // Resume header entries ("221B MG Road, Bengaluru 560038 | +91 ... | name@mail.com").
  const places = knownPlacesFor(location);
  const header = lines.filter(l => l.trim()).slice(0, 12);
  for (const line of header) {
    for (const token of line.split(/\s*[|•·\t]\s*|\s{3,}/)) {
      const cleaned = stripContactNoise(token);
      if (!cleaned || cleaned.length < 8 || cleaned.includes(':')) continue;
      const postal = extractPostalCode(cleaned, location);
      if (!postal || !containsKnownPlace(cleaned, places) || !endsWithPostal(cleaned, postal, places)) continue;
      const parsed = parseAddressComponents(cleaned, location);
      if (parsed) {
        return { ...parsed, sourceDetail: `resume header: address ("${parsed.full.slice(0, 80)}")` };
      }
    }
  }

  // A labelled PIN/ZIP anywhere ("Pincode: 560038") without a usable address line.
  for (const line of lines) {
    const m = LABELED_POSTAL_STRICT_RE.exec(line);
    if (m) {
      const postalCode = cleanPostalCandidate(m[1]);
      return { full: '', postalCode, sourceDetail: `resume: labelled postal code ("${postalCode}")` };
    }
  }
  return null;
}

// ── Saved answers (Career Brain) ─────────────────────────────────────────────

const PLACEHOLDER_ANSWER_RE = /^(?:n\/?a|na|none|nil|null|not\s*applicable|not\s*available|unknown|-+|\.+|0)$/i;

function savedAddressAnswers(
  careerBrain: Partial<ICareerBrain>,
): Array<{ kind: AddressFieldKind; answer: string; source: string }> {
  const found: Array<{ kind: AddressFieldKind; answer: string; source: string }> = [];
  for (const ga of Array.isArray(careerBrain.goldenAnswers) ? careerBrain.goldenAnswers : []) {
    const kind = ga?.question ? classifyAddressField(ga.question) : null;
    const answer = String(ga?.answer || '').trim();
    if (kind && answer && !PLACEHOLDER_ANSWER_RE.test(answer)) {
      found.push({ kind, answer, source: `Career Brain answer: "${ga.question}"` });
    }
  }
  for (const [question, value] of Object.entries(careerBrain.customAnswers || {})) {
    const kind = classifyAddressField(question);
    const answer = String(value || '').trim();
    if (kind && answer && !PLACEHOLDER_ANSWER_RE.test(answer)) {
      found.push({ kind, answer, source: `Career Brain answer: "${question}"` });
    }
  }
  return found;
}

/**
 * Collects the candidate's grounded address details: saved Career Brain answers first (they
 * reflect what the candidate typed), then the resume, then a postal code that the profile
 * location itself carries ("Bengaluru, Karnataka 560038").
 */
export function resolveCandidateAddress(
  careerBrain: Partial<ICareerBrain> | null | undefined,
  location?: CandidateLocationHint | null,
): CandidateAddress {
  const out: CandidateAddress = {};
  if (!careerBrain) return out;

  const saved = savedAddressAnswers(careerBrain);
  const savedOf = (kind: AddressFieldKind) => saved.find(s => s.kind === kind);

  const savedStreet = savedOf('street');
  if (savedStreet) {
    out.street = savedStreet.answer;
    out.streetSource = savedStreet.source;
  }
  const savedPostal = savedOf('postalCode');
  if (savedPostal) {
    out.postalCode = cleanPostalCandidate(savedPostal.answer);
    out.postalSource = savedPostal.source;
  }
  const savedFull = savedOf('fullAddress');
  if (savedFull) {
    out.full = savedFull.answer;
    out.fullSource = savedFull.source;
    const parsed = parseAddressComponents(savedFull.answer, location);
    if (parsed?.street && !out.street) {
      out.street = parsed.street;
      out.streetSource = `${savedFull.source} (street part)`;
    }
    if (parsed?.postalCode && !out.postalCode) {
      out.postalCode = parsed.postalCode;
      out.postalSource = `${savedFull.source} (postal code)`;
    }
  }

  if (!out.street || !out.postalCode || !out.full) {
    const fromResume = findAddressInResumeText(String(careerBrain.resumeText || ''), location);
    if (fromResume) {
      if (!out.full && fromResume.full) {
        out.full = fromResume.full;
        out.fullSource = fromResume.sourceDetail;
      }
      if (!out.street && fromResume.street) {
        out.street = fromResume.street;
        out.streetSource = fromResume.sourceDetail;
      }
      if (!out.postalCode && fromResume.postalCode) {
        out.postalCode = fromResume.postalCode;
        out.postalSource = fromResume.sourceDetail;
      }
    }
  }

  if (!out.postalCode && careerBrain.currentLocation) {
    const fromProfile = extractPostalCode(careerBrain.currentLocation, location);
    if (fromProfile) {
      out.postalCode = fromProfile;
      out.postalSource = `profile: currentLocation ("${careerBrain.currentLocation}")`;
    }
  }
  return out;
}

function formatForField(kind: AddressFieldKind, value: string, field: AddressFieldLike): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (kind === 'postalCode' && field.fieldType === 'number') return clean.replace(/\D/g, '');
  return clean;
}

const KIND_DESCRIPTION: Record<AddressFieldKind, string> = {
  street: 'street address',
  addressLine2: 'second address line',
  postalCode: 'postal / ZIP / PIN code',
  fullAddress: 'address',
};

export function describeAddressKind(kind: AddressFieldKind): string {
  return KIND_DESCRIPTION[kind];
}

/**
 * Resolves the grounded answer for an address field. Returns null when the field is not an
 * address input; otherwise returns the value (or '' when the candidate has none on file).
 */
export function resolveGroundedAddressAnswer(
  field: AddressFieldLike,
  careerBrain: Partial<ICareerBrain> | null | undefined,
  location?: CandidateLocationHint | null,
): GroundedAddressAnswer | null {
  const kind = classifyAddressField(field);
  if (!kind) return null;
  const empty: GroundedAddressAnswer = {
    kind,
    answer: '',
    sourceDetail: `no ${KIND_DESCRIPTION[kind]} in Career Brain answers or resume`,
  };
  if (!careerBrain) return empty;

  // An answer saved for exactly this component always wins.
  const exact = savedAddressAnswers(careerBrain).find(s => s.kind === kind);
  if (exact) return { kind, answer: formatForField(kind, exact.answer, field), sourceDetail: exact.source };
  if (kind === 'addressLine2') return empty;

  const addr = resolveCandidateAddress(careerBrain, location);
  if (kind === 'street') {
    return addr.street
      ? { kind, answer: formatForField(kind, addr.street, field), sourceDetail: addr.streetSource || 'resume' }
      : empty;
  }
  if (kind === 'postalCode') {
    const answer = addr.postalCode ? formatForField(kind, addr.postalCode, field) : '';
    return answer ? { kind, answer, sourceDetail: addr.postalSource || 'resume' } : empty;
  }

  // Full address: the candidate's own address text, else grounded parts joined.
  if (addr.full) {
    return { kind, answer: formatForField(kind, addr.full, field), sourceDetail: addr.fullSource || 'resume' };
  }
  const placeLine = location
    ? Array.from(
        new Set([location.city, location.state, location.country].map(p => (p || '').trim()).filter(Boolean)),
      ).join(', ') || (location.location || '').trim()
    : '';
  if (addr.street || addr.postalCode) {
    const composed = [addr.street, [placeLine, addr.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return {
      kind,
      answer: formatForField(kind, composed, field),
      sourceDetail: [addr.streetSource, addr.postalSource].filter(Boolean).join(' + ') || 'resume',
    };
  }
  // City-level location the candidate gave (never a made-up street).
  if (location?.location) {
    return {
      kind,
      answer: formatForField(kind, location.location, field),
      sourceDetail: 'current location from profile/resume (no street address on file)',
    };
  }
  return empty;
}
