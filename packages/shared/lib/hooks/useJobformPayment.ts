import { useCallback, useEffect, useRef, useState } from 'react';
import { authStorage, sessionUserId, type PremiumStatus } from '@extension/storage';
import {
  refreshAccountCredits,
  refreshAccountQuota,
  refreshAccountStatus,
  type BackendSubscription,
} from '../accountSync';
import {
  detectJobformCurrency,
  fetchJobformPlans,
  JobformPaymentError,
  jobformPaymentUrl,
  onJobformPaymentEvent,
  openJobformPaymentPage,
  planCovers,
  type JobformCurrency,
  type JobformPlan,
  type JobformPlanId,
} from '../jobformPayment';

export type JobformPaymentState =
  /** The website tab is open; `received` once the website has reported the payment. */
  | { phase: 'waiting'; plan: JobformPlanId; url: string; since: number; received: boolean }
  | { phase: 'active'; plan: JobformPlanId; premium: PremiumStatus }
  /** The website paid for another account than the one signed in here. */
  | { phase: 'other-account'; plan: JobformPlanId }
  | { phase: 'timeout'; plan: JobformPlanId };

/** How long a plans view keeps checking for a payment made in the website tab. */
export const PAYMENT_WAIT_MS = 20 * 60_000;
/** While waiting, the plan is also re-read from the backend this often (and when the window regains focus). */
export const PAYMENT_POLL_MS = 15_000;

/**
 * JobForm Automator plans and the purchase in progress, for the side panel and the options page.
 * `active` loads the plans and re-reads the account's plan from the backend (e.g. when the plans view
 * opens). "Choose" opens the website's checkout page right away (no request to wait for); the plan
 * then unlocks when the backend reports it — after the website's `paymentSuccessfull` (handled by the
 * background), or by the regular re-check while waiting. Only one purchase is followed at a time.
 */
export function useJobformPayment(active: boolean) {
  const [plans, setPlans] = useState<JobformPlan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [premium, setPremium] = useState<PremiumStatus | null>(null);
  /** Credit-plan subscription bought in the extension before plans moved to JobForm Automator. */
  const [subscription, setSubscription] = useState<BackendSubscription | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [currency, setCurrency] = useState<JobformCurrency | null>(null);
  /** Plan whose checkout page is about to open (only while the currency lookup is still running). */
  const [opening, setOpening] = useState<JobformPlanId | null>(null);
  const [purchase, setPurchase] = useState<JobformPaymentState | null>(null);
  const currencyRef = useRef<Promise<JobformCurrency | null> | null>(null);
  // Set synchronously on click, so a double click can't open two checkout pages
  const busyRef = useRef(false);

  const loadPlans = useCallback(async () => {
    setPlansError(null);
    try {
      setPlans(await fetchJobformPlans());
    } catch (error) {
      setPlansError(
        error instanceof JobformPaymentError
          ? error.message
          : "Couldn't load the plans. Check your connection and try again.",
      );
    }
  }, []);

  const lookUpCurrency = useCallback(() => {
    if (!currencyRef.current) {
      currencyRef.current = detectJobformCurrency().then(result => {
        if (result) setCurrency(result);
        else currencyRef.current = null; // look up again on the next attempt
        return result;
      });
    }
    return currencyRef.current;
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await refreshAccountStatus();
      setPremium(status?.premium ?? null);
      setSubscription(status?.subscription ?? null);
    } catch {
      // Keep what is shown; the next refresh retries
    } finally {
      setStatusLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    if (!plans) void loadPlans();
    void lookUpCurrency();
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const waitingSince = purchase?.phase === 'waiting' ? purchase.since : null;

  // Follow the purchase: session changes (the background re-reads the plan after the website's
  // payment event), the background's payment events, a regular backend re-check and window focus.
  useEffect(() => {
    if (waitingSince === null || purchase?.phase !== 'waiting') return;
    const { plan } = purchase;
    let done = false;
    let owner: string | null | undefined;

    const finish = (next: JobformPaymentState | null) => {
      if (done) return;
      done = true;
      busyRef.current = false;
      setPurchase(next);
    };

    const check = async (fromBackend: boolean) => {
      const session = await authStorage.getSession();
      const uid = session.token ? sessionUserId(session.user) : null;
      if (owner === undefined || owner === null)
        owner = uid; // signed out when it started: adopt the next sign-in
      else if (uid !== owner) return finish(null); // another account: nothing about this purchase applies to it
      let current = session.premium ?? null;
      if (fromBackend && uid) {
        const status = await refreshAccountStatus().catch(() => null);
        if (status) {
          current = status.premium;
          if (!done) setSubscription(status.subscription ?? null);
        }
      }
      if (done) return;
      setPremium(current);
      if (planCovers(current, plan)) {
        finish({ phase: 'active', plan, premium: current! });
        void refreshAccountCredits().catch(() => undefined);
        void refreshAccountQuota().catch(() => undefined);
      }
    };

    void check(false);
    const unsubscribeSession = authStorage.subscribe(() => void check(false));
    const unsubscribeEvents = onJobformPaymentEvent(event => {
      if (event.at < waitingSince) return;
      if (event.outcome === 'other-account') finish({ phase: 'other-account', plan });
      else if (event.outcome === 'checking')
        setPurchase(current =>
          current?.phase === 'waiting' && current.since === waitingSince ? { ...current, received: true } : current,
        );
      else void check(event.outcome === 'pending');
    });
    const poll = setInterval(() => void check(true), PAYMENT_POLL_MS);
    const onFocus = () => void check(true);
    window.addEventListener('focus', onFocus);
    const timeout = setTimeout(() => finish({ phase: 'timeout', plan }), PAYMENT_WAIT_MS);

    return () => {
      done = true;
      unsubscribeSession();
      unsubscribeEvents();
      clearInterval(poll);
      window.removeEventListener('focus', onFocus);
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingSince]);

  const buy = useCallback(
    async (planId: JobformPlanId) => {
      const plan = plans?.find(p => p.id === planId);
      if (!plan || busyRef.current) return;
      busyRef.current = true;
      setOpening(planId);
      try {
        // Bounded by JOBFORM_CURRENCY_TIMEOUT_MS; unknown → the pricing page, where the website chooses
        const resolved = currency ?? (await lookUpCurrency());
        const url = jobformPaymentUrl(plan, resolved);
        openJobformPaymentPage(url);
        setPurchase({ phase: 'waiting', plan: planId, url, since: Date.now(), received: false });
      } catch {
        busyRef.current = false;
      } finally {
        setOpening(null);
      }
    },
    [plans, currency, lookUpCurrency],
  );

  const reopen = useCallback(() => {
    if (purchase?.phase === 'waiting') openJobformPaymentPage(purchase.url);
  }, [purchase]);

  const stopWaiting = useCallback(() => {
    busyRef.current = false;
    setPurchase(null);
  }, []);

  const dismiss = stopWaiting;

  return {
    plans,
    plansError,
    loadPlans,
    premium,
    subscription,
    statusLoaded,
    refreshStatus,
    currency,
    opening,
    purchase,
    buy,
    reopen,
    stopWaiting,
    dismiss,
  };
}
