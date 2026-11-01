/**
 * Premium / Diamond purchases, done the way the JobForm Automator extension (noah-master) does them:
 * the extension never takes a payment itself. The website runs the whole purchase for the account
 * signed in there, and the extension follows that account.
 *
 *   plans & prices  settings/subscription_configs/candidates — the same public configuration the
 *                   website's pricing page shows (fetchJobformPlans)
 *   Choose a plan   opens the website's checkout page with the same link as its pricing page
 *                   (/payment?plan=Diamond&price=₹5,999&currency=INR&for=candidate)
 *   payment         on the website: Razorpay Checkout, then /api/payment/confirm verifies the payment
 *                   on the server and writes user/{uid}/Payment
 *   unlock          the website fires `paymentSuccessfull` { uid, plan }; the content script passes it
 *                   to the background (websiteSessionSync), which re-reads the plan from the backend —
 *                   the backend reads user/{uid}/Payment. The event itself grants nothing.
 */

import type { PremiumStatus } from '@extension/storage';
import { JOBFORM_DATABASE_URL, JOBFORM_PRICING_URL, JOBFORM_WEBSITE_URL } from './config';
import { isPremiumActive } from './accountSync';

export type JobformPlanId = 'Premium' | 'Diamond';
export type JobformCurrency = 'INR' | 'USD';

export interface JobformPlan {
  id: JobformPlanId;
  description: string;
  /** As on the website's pricing page: "1 Month" / "Until Hired". */
  durationLabel: string;
  /** Price labels exactly as configured on the website, e.g. "₹5,999" and "$99". */
  prices: Record<JobformCurrency, string>;
}

export class JobformPaymentError extends Error {
  readonly code: 'TIMEOUT' | 'NETWORK_ERROR' | 'PLANS_UNAVAILABLE';

  constructor(message: string, code: JobformPaymentError['code']) {
    super(message);
    this.code = code;
  }
}

export const JOBFORM_PLAN_IDS: readonly JobformPlanId[] = ['Premium', 'Diamond'];

/** Where the website keeps the candidate plan prices (public read). */
export const JOBFORM_PLAN_CONFIG_URL = `${JOBFORM_DATABASE_URL}/settings/subscription_configs/candidates.json`;

/** Location service the website's checkout page uses to choose the currency. */
export const JOBFORM_GEOLOCATION_URL = 'https://geolocation-db.com/json/';

/** Longest a request for the plans may take. */
export const JOBFORM_PLANS_TIMEOUT_MS = 15_000;
/** Longest the location lookup may delay opening the checkout page. */
export const JOBFORM_CURRENCY_TIMEOUT_MS = 8_000;

const CONFIG_KEYS: Record<JobformPlanId, string> = { Premium: 'premium', Diamond: 'diamond' };
const DURATION_LABELS: Record<JobformPlanId, string> = { Premium: '1 Month', Diamond: 'Until Hired' };

/** fetch that gives up after `timeoutMs`; network failures and timeouts become JobformPaymentErrors. */
async function request(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, cache: 'no-store' });
  } catch {
    if (controller.signal.aborted) {
      throw new JobformPaymentError(
        "JobForm Automator didn't respond in time. Check your connection and try again.",
        'TIMEOUT',
      );
    }
    throw new JobformPaymentError(
      "Can't reach JobForm Automator. Check your connection and try again.",
      'NETWORK_ERROR',
    );
  } finally {
    clearTimeout(timer);
  }
}

const priceLabel = (value: unknown): string | null =>
  typeof value === 'string' && /\d/.test(value) && value.trim().length <= 32 ? value.trim() : null;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

function toPlan(id: JobformPlanId, value: unknown): JobformPlan | null {
  const config = asRecord(value);
  const inr = priceLabel(config.priceINR);
  const usd = priceLabel(config.priceUSD);
  if (!inr || !usd) return null;
  return {
    id,
    description: typeof config.description === 'string' ? config.description : '',
    durationLabel: DURATION_LABELS[id],
    prices: { INR: inr, USD: usd },
  };
}

/**
 * Premium and Diamond with the prices currently configured on the website. A plan without a
 * configured price is left out; no price is ever made up here.
 */
export async function fetchJobformPlans(timeoutMs = JOBFORM_PLANS_TIMEOUT_MS): Promise<JobformPlan[]> {
  const res = await request(JOBFORM_PLAN_CONFIG_URL, timeoutMs);
  const config = asRecord(res.ok ? await res.json().catch(() => null) : null);
  const plans = JOBFORM_PLAN_IDS.map(id => toPlan(id, config[CONFIG_KEYS[id]])).filter(Boolean) as JobformPlan[];
  if (plans.length === 0) {
    throw new JobformPaymentError(
      res.ok
        ? 'Plans are unavailable right now. You can see them on the pricing page.'
        : 'JobForm Automator is temporarily unavailable. Please try again in a moment.',
      'PLANS_UNAVAILABLE',
    );
  }
  return plans;
}

/**
 * The currency the website's checkout page will charge in. That page asks geolocation-db.com for the
 * country (India pays in INR, everyone else in USD) and takes the amount from the link, so the link
 * must carry the price in that same currency. Null when the lookup fails: the pricing page is opened
 * then, and the website chooses.
 */
export async function detectJobformCurrency(timeoutMs = JOBFORM_CURRENCY_TIMEOUT_MS): Promise<JobformCurrency | null> {
  try {
    const res = await request(JOBFORM_GEOLOCATION_URL, timeoutMs);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object') return null;
    // Same rule as the checkout page (a missing or "Not found" country counts as outside India)
    return body.country_code === 'IN' ? 'INR' : 'USD';
  } catch {
    return null;
  }
}

/**
 * The website's checkout page for `plan`, with the same link its pricing page builds
 * (components/pricing/PricingSection.jsx). `for=candidate` makes that page activate the plan through
 * its server (/api/payment/confirm) after Razorpay; without a known currency, the pricing page.
 */
export function jobformPaymentUrl(plan: JobformPlan, currency: JobformCurrency | null): string {
  if (!currency) return JOBFORM_PRICING_URL;
  return `${JOBFORM_WEBSITE_URL}/payment?plan=${encodeURIComponent(plan.id)}&price=${encodeURIComponent(
    plan.prices[currency],
  )}&currency=${currency}&for=${encodeURIComponent('candidate')}`;
}

/** Opens the website's checkout page in a new tab (as the JobForm Automator extension's "Upgrade"). */
export function openJobformPaymentPage(url: string): void {
  if (typeof chrome !== 'undefined' && chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, '_blank', 'noopener');
}

/** Whether the backend's plan already gives what `plan` would (Diamond includes Premium). */
export function planCovers(premium: PremiumStatus | null | undefined, plan: JobformPlanId): boolean {
  if (!isPremiumActive(premium)) return false;
  return plan === 'Premium' ? premium!.tier === 'Premium' || premium!.tier === 'Diamond' : premium!.tier === 'Diamond';
}

/**
 * What the background made of the last `paymentSuccessfull` from the website, for the plans views:
 *   checking       the website reported a payment; the plan is being re-read from the backend
 *   active         the backend reports the paid plan
 *   pending        the backend did not report it yet (the plans views keep checking)
 *   other-account  the website paid for another account than the one signed in here
 *   signed-out     nobody is signed in here
 */
export type JobformPaymentOutcome = 'checking' | 'active' | 'pending' | 'other-account' | 'signed-out';

export interface JobformPaymentEvent {
  plan: JobformPlanId;
  outcome: JobformPaymentOutcome;
  at: number;
}

export const JOBFORM_PAYMENT_EVENT_KEY = 'nanobrowser_jobform_payment_event';

const PAYMENT_OUTCOMES: readonly JobformPaymentOutcome[] = [
  'checking',
  'active',
  'pending',
  'other-account',
  'signed-out',
];

function toPaymentEvent(value: unknown): JobformPaymentEvent | null {
  const { plan, outcome, at } = asRecord(value);
  if (!JOBFORM_PLAN_IDS.includes(plan as JobformPlanId)) return null;
  if (!PAYMENT_OUTCOMES.includes(outcome as JobformPaymentOutcome) || typeof at !== 'number') return null;
  return { plan: plan as JobformPlanId, outcome: outcome as JobformPaymentOutcome, at };
}

export async function saveJobformPaymentEvent(event: JobformPaymentEvent): Promise<void> {
  await chrome.storage.local.set({ [JOBFORM_PAYMENT_EVENT_KEY]: event });
}

export async function getJobformPaymentEvent(): Promise<JobformPaymentEvent | null> {
  const stored = await chrome.storage.local.get(JOBFORM_PAYMENT_EVENT_KEY);
  return toPaymentEvent(stored?.[JOBFORM_PAYMENT_EVENT_KEY]);
}

/** Calls `listener` whenever the background records a payment event. Returns the unsubscribe. */
export function onJobformPaymentEvent(listener: (event: JobformPaymentEvent) => void): () => void {
  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return () => undefined;
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(JOBFORM_PAYMENT_EVENT_KEY in changes)) return;
    const event = toPaymentEvent(changes[JOBFORM_PAYMENT_EVENT_KEY].newValue);
    if (event) listener(event);
  };
  chrome.storage.onChanged.addListener(onChanged);
  return () => chrome.storage.onChanged.removeListener(onChanged);
}
