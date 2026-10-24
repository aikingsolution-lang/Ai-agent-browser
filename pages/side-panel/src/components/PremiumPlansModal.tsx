import React, { useState, useEffect, useRef } from 'react';
import { backendApiClient, isPremiumActive, refreshAccountStatus, waitForCheckoutActivation } from '@extension/shared';
import type { PremiumStatus } from '@extension/storage';
import { FiCheck, FiX, FiLock, FiStar, FiZap, FiChevronDown, FiChevronUp, FiAlertTriangle } from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

interface PremiumPlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
  userCredits?: { remainingCredits: number; allocatedCredits: number } | null;
}

type PlanCode = 'starter' | 'pro' | 'power';

/**
 * Credit plans as configured on the backend (monthly billing only; credits and daily application
 * limits match PlanSeedService and ApplicationQuotaService).
 */
const PLANS: ReadonlyArray<{
  code: PlanCode;
  name: string;
  price: string;
  credits: string;
  dailyApplications: number;
  support: string;
  popular?: boolean;
}> = [
  {
    code: 'starter',
    name: 'Starter',
    price: '₹499',
    credits: '1,000',
    dailyApplications: 50,
    support: 'Email support',
  },
  {
    code: 'pro',
    name: 'Pro',
    price: '₹1,499',
    credits: '5,000',
    dailyApplications: 100,
    support: 'Priority support',
    popular: true,
  },
  {
    code: 'power',
    name: 'Power',
    price: '₹4,999',
    credits: '25,000',
    dailyApplications: 500,
    support: 'Dedicated support',
  },
];

const PLAN_NAMES: Record<string, string> = { starter: 'Starter', pro: 'Pro', power: 'Power' };

const formatDate = (iso?: string | null) =>
  iso && !Number.isNaN(Date.parse(iso))
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

/** Subscription fields (from GET /subscription/me) used for the plan summary. */
interface SubscriptionSummary {
  status?: string;
  isTrial?: boolean;
  planCodeSnapshot?: string;
  planNameSnapshot?: string;
  trialEndDate?: string | null;
  currentPeriodEnd?: string | null;
  endedAt?: string | null;
  cancelAtPeriodEnd?: boolean;
}

/** Title and one line of detail for the credit-plan subscription returned by the backend. */
function describeSubscription(sub: SubscriptionSummary | null): {
  title: string;
  detail: string | null;
  state: 'active' | 'warning' | 'ended';
} {
  if (!sub) return { title: 'Free', detail: null, state: 'ended' };
  const isTrial = Boolean(sub.isTrial) || sub.planCodeSnapshot === 'free-trial';
  const planName = (sub.planCodeSnapshot && PLAN_NAMES[sub.planCodeSnapshot]) || sub.planNameSnapshot || 'Paid';
  const name = isTrial ? 'Free trial' : `${planName} plan`;
  const periodEnd = formatDate(sub.currentPeriodEnd);
  switch (sub.status) {
    case 'TRIALING': {
      const ends = formatDate(sub.trialEndDate) ?? periodEnd;
      return { title: 'Free trial', detail: ends ? `Ends ${ends}` : null, state: 'active' };
    }
    case 'ACTIVE':
      if (isTrial) return { title: 'Free trial', detail: periodEnd ? `Ends ${periodEnd}` : null, state: 'active' };
      return {
        title: name,
        detail: periodEnd ? (sub.cancelAtPeriodEnd ? `Ends ${periodEnd}` : `Renews ${periodEnd}`) : null,
        state: 'active',
      };
    case 'PAST_DUE':
      return { title: name, detail: 'Payment failed. Razorpay will retry the charge.', state: 'warning' };
    case 'EXPIRED':
    case 'CANCELLED': {
      const ended = formatDate(sub.endedAt) ?? periodEnd;
      return { title: `${name} ended`, detail: ended ? `Ended ${ended}` : null, state: 'ended' };
    }
    default:
      return { title: 'Free', detail: null, state: 'ended' };
  }
}

export const PremiumPlansModal: React.FC<PremiumPlansModalProps> = ({
  isOpen,
  onClose,
  isDarkMode = false,
  userCredits,
}) => {
  const [currentSubscription, setCurrentSubscription] = useState<any | null>(null);
  const [jobformPremium, setJobformPremium] = useState<PremiumStatus | null>(null);
  const [loadingPlanCode, setLoadingPlanCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showPlans, setShowPlans] = useState(false);
  // Waiting for the backend to confirm the last checkout (kept while the side panel is open, so a
  // payment finished after closing this window still refreshes the plan and credits)
  const activationRef = useRef<AbortController | null>(null);

  useEffect(() => () => activationRef.current?.abort(), []);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    async function loadSubscription() {
      try {
        // Status always comes from the backend (also updates the stored session)
        const status = await refreshAccountStatus();
        if (isMounted && status) {
          setJobformPremium(status.premium);
          setCurrentSubscription(status.subscription ?? null);
        }
      } catch {
        // Keep what is shown; the next open retries
      }
    }
    loadSubscription();

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Escape closes the dialog (separate effect: onClose may change on every parent render)
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const tone = (dark: string, light: string) => (isDarkMode ? dark : light);

  const watchActivation = async (providerSubscriptionId: string, planName: string) => {
    activationRef.current?.abort();
    const controller = new AbortController();
    activationRef.current = controller;

    const result = await waitForCheckoutActivation(providerSubscriptionId, { signal: controller.signal });
    if (activationRef.current !== controller) return; // superseded by a newer checkout
    activationRef.current = null;

    if (result.outcome === 'active') {
      setCurrentSubscription(result.subscription);
      setErrorMessage(null);
      setSuccessMessage(`Payment confirmed. ${result.subscription.planNameSnapshot || planName} is now active.`);
    } else if (result.outcome === 'timeout') {
      setSuccessMessage(
        'Payment confirmation has not arrived yet. If you completed the payment, your plan activates within a few minutes; reopen this window to check.',
      );
    } else if (result.outcome === 'account-changed') {
      // The checkout belonged to the previous account: show nothing about it
      setCurrentSubscription(null);
      setJobformPremium(null);
      setSuccessMessage(null);
    }
  };

  const handleCheckout = async (planCode: string) => {
    setLoadingPlanCode(planCode);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const idempotencyKey = `checkout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const res = await backendApiClient.createCheckoutSession(planCode, idempotencyKey);
      const planName = res.data?.planName || planCode.toUpperCase();

      // The plan becomes active only when the backend has verified the payment (Razorpay signature
      // check / webhook); nothing is unlocked here. The backend status is re-read until it confirms.
      if (res.data?.shortUrl && res.data.subscriptionId) {
        window.open(res.data.shortUrl, '_blank');
        setSuccessMessage(`Razorpay checkout opened. ${planName} activates as soon as the payment is confirmed.`);
        void watchActivation(res.data.subscriptionId, planName);
      } else {
        setSuccessMessage(`Subscription order generated for ${planName}. Complete the payment to activate it.`);
      }
    } catch (err: any) {
      if (err?.code === 'ALREADY_SUBSCRIBED') {
        setSuccessMessage(err.message || 'You are already subscribed to this plan.');
        const status = await refreshAccountStatus().catch(() => null);
        if (status?.subscription) setCurrentSubscription(status.subscription);
      } else {
        setErrorMessage(err.message || 'Could not start checkout. Check your connection and try again.');
      }
    } finally {
      setLoadingPlanCode(null);
    }
  };

  const premiumActive = isPremiumActive(jobformPremium);
  const subscription = describeSubscription(currentSubscription);
  const subscriptionEntitled = ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(currentSubscription?.status);
  const activePaidPlan =
    currentSubscription?.status === 'ACTIVE' && !currentSubscription?.isTrial
      ? (currentSubscription?.planCodeSnapshot as string | undefined)
      : undefined;
  const plansVisible = !premiumActive || showPlans;

  const remaining = Math.max(0, userCredits?.remainingCredits ?? 0);
  const allocated = Math.max(userCredits?.allocatedCredits ?? 0, remaining, 1);
  const creditPercent = Math.min(100, Math.round((remaining / allocated) * 100));
  const creditNote = premiumActive
    ? 'Not used while Premium is active.'
    : !subscriptionEntitled
      ? 'Choose a plan to use AI credits again.'
      : remaining === 0
        ? 'No credits left this period.'
        : null;

  const card = `rounded-xl border ${tone('border-slate-700 bg-slate-800/70', 'border-slate-200 bg-white')}`;
  const muted = tone('text-slate-400', 'text-slate-500');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3 backdrop-blur-xs"
      onClick={e => e.target === e.currentTarget && onClose()}
      role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plans-dialog-title"
        className={`relative flex w-full max-w-lg max-h-[92vh] flex-col overflow-hidden rounded-2xl border shadow-xl ${tone(
          'border-slate-800 bg-slate-900 text-slate-100',
          'border-slate-200 bg-slate-50 text-slate-900',
        )}`}>
        {/* Header */}
        <div
          className={`flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3.5 ${tone(
            'border-slate-800 bg-slate-900',
            'border-slate-200 bg-white',
          )}`}>
          <div>
            <h2 id="plans-dialog-title" className="text-base font-bold">
              Plans & credits
            </h2>
            <p className={`text-xs ${muted}`}>Your plan, AI credits and upgrades</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-lg p-1.5 transition-colors cursor-pointer ${tone(
              'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
              'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
            )}`}
            aria-label="Close">
            <FiX className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* Messages */}
          {errorMessage && (
            <div
              role="alert"
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tone(
                'border-red-900/50 bg-red-950/30 text-red-300',
                'border-red-200 bg-red-50 text-red-700',
              )}`}>
              <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
          {successMessage && (
            <div
              role="status"
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tone(
                'border-emerald-900/50 bg-emerald-950/30 text-emerald-300',
                'border-emerald-200 bg-emerald-50 text-emerald-800',
              )}`}>
              <FiCheck className="mt-0.5 size-3.5 shrink-0" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Your plan */}
          <section className={`${card} divide-y ${tone('divide-slate-700', 'divide-slate-100')}`}>
            {premiumActive && (
              <div className="flex items-start gap-2.5 p-3">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${tone(
                    'bg-violet-500/20 text-violet-300',
                    'bg-violet-100 text-violet-700',
                  )}`}>
                  <FiStar className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-bold">JobForm Automator {jobformPremium?.tier}</span>
                    <span
                      className={`rounded px-1.5 text-[10px] font-bold uppercase tracking-wide border ${tone(
                        'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
                        'border-emerald-200 bg-emerald-50 text-emerald-700',
                      )}`}>
                      Active
                    </span>
                  </div>
                  <ul className={`mt-1 space-y-0.5 text-[11px] ${tone('text-slate-300', 'text-slate-600')}`}>
                    <li>AI Auto Apply included, no credits used</li>
                    <li>Up to 300 applications a day</li>
                    {jobformPremium?.endDate && jobformPremium.tier !== 'Diamond' && (
                      <li>Active until {formatDate(jobformPremium.endDate)}</li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            <div className="p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-[11px] font-medium ${muted}`}>{premiumActive ? 'Credit plan' : 'Current plan'}</p>
                  <p className="flex items-center gap-1.5 text-sm font-semibold">
                    <span
                      className={`size-2 shrink-0 rounded-full ${
                        subscription.state === 'active'
                          ? 'bg-emerald-500'
                          : subscription.state === 'warning'
                            ? 'bg-amber-500'
                            : 'bg-slate-400'
                      }`}
                    />
                    {subscription.title}
                  </p>
                  {subscription.detail && <p className={`text-[11px] ${muted}`}>{subscription.detail}</p>}
                </div>
              </div>

              {userCredits && (
                <div className="mt-3">
                  <div className="flex items-baseline justify-between text-[11px]">
                    <span className={`flex items-center gap-1 font-medium ${tone('text-slate-300', 'text-slate-700')}`}>
                      <FiZap className="size-3" />
                      AI credits
                    </span>
                    <span className={tone('text-slate-300', 'text-slate-600')}>
                      <span className="font-semibold">{remaining.toLocaleString()}</span> of{' '}
                      {allocated.toLocaleString()} left
                    </span>
                  </div>
                  <div
                    className={`mt-1.5 h-1.5 w-full overflow-hidden rounded-full ${tone('bg-slate-700', 'bg-slate-200')}`}
                    role="progressbar"
                    aria-label="AI credits left"
                    aria-valuemin={0}
                    aria-valuemax={allocated}
                    aria-valuenow={remaining}>
                    <div
                      className={`h-full rounded-full ${creditPercent < 20 ? 'bg-amber-500' : 'bg-sky-600'}`}
                      style={{ width: `${creditPercent}%` }}
                    />
                  </div>
                  {creditNote && <p className={`mt-1 text-[11px] ${muted}`}>{creditNote}</p>}
                </div>
              )}
            </div>
          </section>

          {/* Credit plans */}
          <section>
            {premiumActive ? (
              <button
                type="button"
                onClick={() => setShowPlans(v => !v)}
                aria-expanded={showPlans}
                className={`flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-xs font-semibold cursor-pointer ${tone(
                  'text-slate-300 hover:text-white',
                  'text-slate-700 hover:text-slate-900',
                )}`}>
                <span>
                  Credit plans
                  <span className={`block text-[11px] font-normal ${muted}`}>
                    Premium already includes AI. Plans add credits and higher daily limits.
                  </span>
                </span>
                {showPlans ? (
                  <FiChevronUp className="size-4 shrink-0" />
                ) : (
                  <FiChevronDown className="size-4 shrink-0" />
                )}
              </button>
            ) : (
              <div className="px-1">
                <h3 className="text-xs font-semibold">Choose a plan</h3>
                <p className={`text-[11px] ${muted}`}>Billed monthly. Credits refill each billing period.</p>
              </div>
            )}

            {plansVisible && (
              <div className="mt-2 space-y-2">
                {PLANS.map(plan => {
                  const isCurrent = activePaidPlan === plan.code;
                  const isLoading = loadingPlanCode === plan.code;
                  return (
                    <div
                      key={plan.code}
                      className={`rounded-xl border p-3 ${
                        isCurrent
                          ? tone('border-emerald-500/60 bg-emerald-950/20', 'border-emerald-300 bg-emerald-50/50')
                          : plan.popular
                            ? tone('border-sky-500/60 bg-slate-800/70', 'border-sky-300 bg-white ring-1 ring-sky-200')
                            : tone('border-slate-700 bg-slate-800/70', 'border-slate-200 bg-white')
                      }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <h4 className="text-sm font-bold">{plan.name}</h4>
                          {isCurrent ? (
                            <span
                              className={`rounded px-1.5 text-[10px] font-bold uppercase tracking-wide border ${tone(
                                'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
                                'border-emerald-200 bg-emerald-50 text-emerald-700',
                              )}`}>
                              Current
                            </span>
                          ) : (
                            plan.popular && (
                              <span
                                className={`rounded px-1.5 text-[10px] font-bold uppercase tracking-wide border ${tone(
                                  'border-sky-500/30 bg-sky-500/15 text-sky-300',
                                  'border-sky-200 bg-sky-50 text-sky-700',
                                )}`}>
                                Most popular
                              </span>
                            )
                          )}
                        </div>
                        <p className="whitespace-nowrap">
                          <span className="text-base font-bold">{plan.price}</span>
                          <span className={`text-[11px] ${muted}`}> / month</span>
                        </p>
                      </div>

                      <ul className={`mt-2 space-y-1 text-xs ${tone('text-slate-300', 'text-slate-700')}`}>
                        {[
                          `${plan.credits} AI credits a month`,
                          `Up to ${plan.dailyApplications} applications a day`,
                          plan.support,
                        ].map(feature => (
                          <li key={feature} className="flex items-center gap-2">
                            <FiCheck
                              className={`size-3.5 shrink-0 ${tone('text-emerald-400', 'text-emerald-600')}`}
                              aria-hidden="true"
                            />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>

                      {isCurrent ? (
                        <p
                          className={`mt-2.5 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold ${tone(
                            'bg-emerald-500/10 text-emerald-300',
                            'bg-emerald-100/70 text-emerald-800',
                          )}`}>
                          <FiCheck className="size-3.5" />
                          Your current plan
                        </p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleCheckout(plan.code)}
                          disabled={loadingPlanCode !== null}
                          className={`mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 ${
                            plan.popular
                              ? 'bg-sky-600 text-white hover:bg-sky-700'
                              : tone(
                                  'border border-slate-600 text-slate-100 hover:bg-slate-700',
                                  'border border-slate-300 text-slate-800 hover:bg-slate-50',
                                )
                          }`}>
                          {isLoading ? (
                            <>
                              <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />
                              <span>Opening checkout…</span>
                            </>
                          ) : (
                            <span>
                              {activePaidPlan ? 'Switch to' : 'Choose'} {plan.name}
                            </span>
                          )}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div
          className={`flex shrink-0 items-center gap-1.5 border-t px-4 py-2.5 text-[11px] ${tone(
            'border-slate-800 bg-slate-900 text-slate-400',
            'border-slate-200 bg-white text-slate-500',
          )}`}>
          <FiLock className={`size-3.5 ${tone('text-emerald-400', 'text-emerald-600')}`} />
          <span>Secure checkout by Razorpay. Plans activate once the payment is confirmed.</span>
        </div>
      </div>
    </div>
  );
};
