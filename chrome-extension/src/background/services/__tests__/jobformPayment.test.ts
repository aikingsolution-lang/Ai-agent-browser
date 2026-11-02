/**
 * Premium / Diamond purchases the JobForm Automator way (as in noah-master): plans and prices from the
 * website's public configuration, the website's own checkout link, and the currency rule of its
 * checkout page. The network is faked; the real module runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  const local = {
    get: async (keys?: string | string[] | null) => {
      if (!keys) return { ...data };
      const res: Record<string, unknown> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) res[k] = data[k];
      return res;
    },
    set: async (items: Record<string, unknown>) => Object.assign(data, items),
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    onChanged: { addListener: () => undefined },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, sync: local, session: local, onChanged: { addListener: () => undefined } },
    tabs: { create: vi.fn() },
    runtime: { id: 'test', getURL: (p: string) => p },
  };
});

import {
  detectJobformCurrency,
  fetchJobformPlans,
  getJobformPaymentEvent,
  JOBFORM_GEOLOCATION_URL,
  JOBFORM_PLAN_CONFIG_URL,
  JOBFORM_PRICING_URL,
  JOBFORM_WEBSITE_URL,
  JOBFORM_PAYMENT_EVENT_KEY,
  JobformPaymentError,
  jobformPaymentUrl,
  openJobformPaymentPage,
  planCovers,
  saveJobformPaymentEvent,
  type JobformPlan,
} from '@extension/shared';
import type { PremiumStatus } from '@extension/storage';

/** settings/subscription_configs/candidates as the production database returns it today. */
const LIVE_CONFIG = {
  diamond: {
    aiCalls: '100',
    description: 'Until hired we will support you',
    priceINR: '₹5,999',
    priceUSD: '$99',
    resumes: 'Generous',
  },
  premium: {
    aiCalls: '100',
    description: 'Advanced Features - 1 Month Subscription',
    priceINR: '₹499',
    priceUSD: '$20',
    resumes: 'Generous',
  },
};

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A request that never answers until it is aborted. */
const hang = (_url: string, init: RequestInit = {}) =>
  new Promise<Response>((_, reject) =>
    init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  );

const premiumStatus = (tier: 'Free' | 'Premium' | 'Diamond', endOffsetMs = 30 * 86_400_000): PremiumStatus => ({
  source: 'jobform-automator',
  tier,
  isPremium: tier !== 'Free',
  subscriptionType: tier,
  startDate: null,
  endDate: new Date(Date.now() + endOffsetMs).toISOString(),
  expired: false,
  checkedAt: new Date().toISOString(),
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (chrome.tabs.create as ReturnType<typeof vi.fn>).mockClear();
});

describe('plans and prices come from the website configuration', () => {
  it('reads Premium ₹499 / 1 Month and Diamond ₹5,999 / Until Hired from settings/subscription_configs', async () => {
    fetchMock.mockResolvedValue(respond(200, LIVE_CONFIG));
    const plans = await fetchJobformPlans();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://jobform-automator-website-default-rtdb.firebaseio.com/settings/subscription_configs/candidates.json',
    );
    expect(JOBFORM_PLAN_CONFIG_URL).toBe(fetchMock.mock.calls[0][0]);
    expect(plans).toEqual([
      {
        id: 'Premium',
        description: 'Advanced Features - 1 Month Subscription',
        durationLabel: '1 Month',
        prices: { INR: '₹499', USD: '$20' },
      },
      {
        id: 'Diamond',
        description: 'Until hired we will support you',
        durationLabel: 'Until Hired',
        prices: { INR: '₹5,999', USD: '$99' },
      },
    ]);
  });

  it('follows a price change on the website (nothing is built into the extension)', async () => {
    fetchMock.mockResolvedValue(
      respond(200, { ...LIVE_CONFIG, premium: { ...LIVE_CONFIG.premium, priceINR: '₹599', priceUSD: '$25' } }),
    );
    const [premium] = await fetchJobformPlans();
    expect(premium.prices).toEqual({ INR: '₹599', USD: '$25' });
  });

  it('leaves out a plan without a configured price instead of making one up', async () => {
    fetchMock.mockResolvedValue(respond(200, { premium: LIVE_CONFIG.premium, diamond: { description: 'x' } }));
    expect((await fetchJobformPlans()).map(p => p.id)).toEqual(['Premium']);
  });

  it('no configuration at all → PLANS_UNAVAILABLE (no fallback prices)', async () => {
    fetchMock.mockResolvedValue(respond(200, null));
    await expect(fetchJobformPlans()).rejects.toMatchObject({ code: 'PLANS_UNAVAILABLE' });
  });

  it('database error → PLANS_UNAVAILABLE with a retry message', async () => {
    fetchMock.mockResolvedValue(respond(503, { error: 'unavailable' }));
    const error = await fetchJobformPlans().catch(e => e);
    expect(error).toBeInstanceOf(JobformPaymentError);
    expect(error).toMatchObject({ code: 'PLANS_UNAVAILABLE' });
    expect(error.message).toMatch(/temporarily unavailable/);
  });

  it('offline → NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(fetchJobformPlans()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('a request that never answers ends with TIMEOUT (no endless loading)', async () => {
    fetchMock.mockImplementation(hang);
    const started = Date.now();
    await expect(fetchJobformPlans(50)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('currency: the rule of the website checkout page', () => {
  it.each([
    ['IN', 'INR'],
    ['US', 'USD'],
    ['GB', 'USD'],
    ['Not found', 'USD'],
  ])('country %s → %s', async (country, currency) => {
    fetchMock.mockResolvedValue(respond(200, { country_code: country, country_name: 'x' }));
    expect(await detectJobformCurrency()).toBe(currency);
    expect(fetchMock.mock.calls[0][0]).toBe(JOBFORM_GEOLOCATION_URL);
  });

  it('lookup failure, error status or no answer → unknown (the pricing page is opened instead)', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await detectJobformCurrency()).toBeNull();
    fetchMock.mockResolvedValueOnce(respond(500, {}));
    expect(await detectJobformCurrency()).toBeNull();
    fetchMock.mockImplementationOnce(hang);
    expect(await detectJobformCurrency(50)).toBeNull();
  });
});

describe("the checkout link is the website pricing page's own link", () => {
  const plans: Record<'Premium' | 'Diamond', JobformPlan> = {
    Premium: { id: 'Premium', description: '', durationLabel: '1 Month', prices: { INR: '₹499', USD: '$20' } },
    Diamond: { id: 'Diamond', description: '', durationLabel: 'Until Hired', prices: { INR: '₹5,999', USD: '$99' } },
  };

  /** components/pricing/PricingSection.jsx handlePyment(), as on the website. */
  const websiteLink = (name: string, usd: string, inr: string, currency: string) => {
    const selectedPrice = currency === 'INR' ? inr : usd;
    return `/payment?plan=${encodeURIComponent(name)}&price=${encodeURIComponent(
      selectedPrice,
    )}&currency=${currency}&for=${encodeURIComponent('candidate')}`;
  };

  it.each([
    ['Premium', 'INR'],
    ['Premium', 'USD'],
    ['Diamond', 'INR'],
    ['Diamond', 'USD'],
  ] as const)('%s in %s', (id, currency) => {
    const plan = plans[id];
    expect(jobformPaymentUrl(plan, currency)).toBe(
      JOBFORM_WEBSITE_URL + websiteLink(plan.id, plan.prices.USD, plan.prices.INR, currency),
    );
  });

  it('the checkout page reads the plan, the amount and the candidate flow from it', () => {
    // components/payment/PaymentClient.js
    const url = new URL(jobformPaymentUrl(plans.Diamond, 'INR'));
    expect(url.origin + url.pathname).toBe('https://www.jobformautomator.com/payment');
    expect(url.searchParams.get('plan')).toBe('Diamond');
    expect(url.searchParams.get('for')).toBe('candidate'); // → /api/payment/confirm activates the plan
    const amount = parseFloat(decodeURIComponent(url.searchParams.get('price')!).replace(/[^0-9.]/g, ''));
    expect(amount).toBe(5999);
    const usd = new URL(jobformPaymentUrl(plans.Premium, 'USD'));
    expect(parseFloat(decodeURIComponent(usd.searchParams.get('price')!).replace(/[^0-9.]/g, ''))).toBe(20);
  });

  it('unknown currency → the pricing page, where the website chooses', () => {
    expect(jobformPaymentUrl(plans.Diamond, null)).toBe(JOBFORM_PRICING_URL);
  });

  it('opens the page in a new tab, like the JobForm Automator extension', () => {
    openJobformPaymentPage('https://www.jobformautomator.com/payment?plan=Premium');
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://www.jobformautomator.com/payment?plan=Premium' });
  });
});

describe('what counts as having a plan', () => {
  it.each([
    [null, 'Premium', false],
    ['Free', 'Premium', false],
    ['Premium', 'Premium', true],
    ['Premium', 'Diamond', false],
    ['Diamond', 'Premium', true],
    ['Diamond', 'Diamond', true],
  ] as const)('%s covers %s: %s', (tier, plan, covered) => {
    expect(planCovers(tier ? premiumStatus(tier) : null, plan)).toBe(covered);
  });

  it('an expired plan covers nothing', () => {
    expect(planCovers(premiumStatus('Diamond', -1000), 'Premium')).toBe(false);
  });
});

describe('payment events recorded for the plans views', () => {
  it('round-trips and ignores malformed records', async () => {
    await saveJobformPaymentEvent({ plan: 'Diamond', outcome: 'checking', at: 123 });
    expect(await getJobformPaymentEvent()).toEqual({ plan: 'Diamond', outcome: 'checking', at: 123 });
    await chrome.storage.local.set({ [JOBFORM_PAYMENT_EVENT_KEY]: { plan: 'Gold', outcome: 'active', at: 1 } });
    expect(await getJobformPaymentEvent()).toBeNull();
  });
});
