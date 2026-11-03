import React, { useEffect } from 'react';
import {
  isPremiumActive,
  JOBFORM_PRICING_URL,
  openJobformPricing,
  openJobformSignIn,
  useJobformPayment,
  type JobformPaymentState,
  type JobformPlan,
} from '@extension/shared';
import type { PremiumStatus } from '@extension/storage';
import { FiCheck, FiX, FiLock, FiStar, FiZap, FiAlertTriangle, FiExternalLink, FiRefreshCw } from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

interface PremiumPlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
  userCredits?: { remainingCredits: number; allocatedCredits: number } | null;
}

/**
 * What JobForm Automator Premium / Diamond give in the extension, as enforced by the backend
 * (ApplicationQuotaService: free 10 a day, Premium/Diamond 300; PremiumAiAllowanceService: AI
 * without credits, 1,000 AI tasks a month in Premium Mode).
 */
const EXTENSION_BENEFITS = [
  'Up to 300 applications a day',
  'AI Auto Apply included, no credits used',
  'Premium Mode: 1,000 AI tasks a month',
];
const FREE_DAILY_APPLICATIONS = 10;
/** The free plan, as the website's pricing page names and describes it. */
const BASIC_PLAN = { name: 'Basic', description: 'Essential Tools to Kickstart Your Job Search' };

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

/**
 * Credit plans (Starter / Pro / Power) are no longer sold in the extension; accounts that bought one
 * still see it until it ends. Null when the account has none worth showing.
 */
function describeCreditPlan(sub: SubscriptionSummary | null): { title: string; detail: string | null } | null {
  if (!sub || !['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(sub.status ?? '')) return null;
  const isTrial = Boolean(sub.isTrial) || sub.planCodeSnapshot === 'free-trial';
  const ends = formatDate(isTrial ? (sub.trialEndDate ?? sub.currentPeriodEnd) : sub.currentPeriodEnd);
  if (isTrial) return { title: 'Free trial', detail: ends ? `Ends ${ends}` : null };
  const name = `${(sub.planCodeSnapshot && PLAN_NAMES[sub.planCodeSnapshot]) || sub.planNameSnapshot || 'Paid'} credit plan`;
  if (sub.status === 'PAST_DUE') return { title: name, detail: 'Payment failed. Razorpay will retry the charge.' };
  return { title: name, detail: ends ? (sub.cancelAtPeriodEnd ? `Ends ${ends}` : `Renews ${ends}`) : null };
}

/** The action a plan card offers for the account's current plan (as on the website's pricing page). */
function planAction(plan: JobformPlan, premium: PremiumStatus | null): 'buy' | 'upgrade' | 'current' | 'included' {
  const tier = isPremiumActive(premium) ? premium!.tier : 'Free';
  if (tier === plan.id) return 'current';
  if (tier === 'Diamond') return 'included';
  return tier === 'Premium' ? 'upgrade' : 'buy';
}

function purchaseMessage(purchase: JobformPaymentState): {
  tone: 'info' | 'success' | 'error';
  title: string;
  detail?: string;
} {
  switch (purchase.phase) {
    case 'waiting':
      return purchase.received
        ? {
            tone: 'info',
            title: 'Payment received by JobForm Automator',
            detail: `Confirming your ${purchase.plan} plan…`,
          }
        : {
            tone: 'info',
            title:
              purchase.url === JOBFORM_PRICING_URL
                ? `Choose ${purchase.plan} on the JobForm Automator pricing page`
                : 'Finish the payment in the JobForm Automator tab',
            detail: `${purchase.plan} unlocks here automatically once JobForm Automator confirms the payment.`,
          };
    case 'active':
      return {
        tone: 'success',
        title: `Payment confirmed. ${purchase.premium.tier} is active.`,
        detail: 'Premium features are unlocked here and on jobformautomator.com.',
      };
    case 'other-account':
      return {
        tone: 'error',
        title: 'This payment was made with a different JobForm Automator account.',
        detail: `jobformautomator.com is signed in with another account than the extension. Sign in here with that account to use ${purchase.plan}.`,
      };
    case 'timeout':
      return {
        tone: 'info',
        title: "We haven't seen the payment yet.",
        detail: 'If you completed it, your plan unlocks within a few minutes; reopen this window to check.',
      };
  }
}

export const PremiumPlansModal: React.FC<PremiumPlansModalProps> = ({
  isOpen,
  onClose,
  isDarkMode = false,
  userCredits,
}) => {
  // Mounted for the whole side panel session, so a payment finished after closing this window still
  // unlocks the plan and refreshes credits.
  const billing = useJobformPayment(isOpen);
  const { plans, plansError, premium, purchase, currency } = billing;

  // Escape closes the dialog (separate effect: onClose may change on every parent render)
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const tone = (dark: string, light: string) => (isDarkMode ? dark : light);
  const premiumActive = isPremiumActive(premium);
  const creditPlan = describeCreditPlan(billing.subscription as SubscriptionSummary | null);
  const busy = billing.opening !== null || purchase?.phase === 'waiting';
  const message = purchase ? purchaseMessage(purchase) : null;

  const remaining = Math.max(0, userCredits?.remainingCredits ?? 0);
  const allocated = Math.max(userCredits?.allocatedCredits ?? 0, remaining, 1);
  const creditPercent = Math.min(100, Math.round((remaining / allocated) * 100));
  const creditNote = premiumActive
    ? 'Not used while Premium is active.'
    : remaining === 0
      ? 'No credits left. Premium and Diamond include AI without credits.'
      : null;

  const card = `rounded-xl border ${tone('border-slate-700 bg-slate-800/70', 'border-slate-200 bg-white')}`;
  const muted = tone('text-slate-400', 'text-slate-500');
  const badge = (classes: string) => `rounded px-1.5 text-[10px] font-bold uppercase tracking-wide border ${classes}`;
  const activeBadge = badge(
    tone(
      'border-emerald-500/30 bg-emerald-500/15 text-emerald-300',
      'border-emerald-200 bg-emerald-50 text-emerald-700',
    ),
  );
  const secondaryButton = `rounded-md border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${tone(
    'border-slate-600 text-slate-200 hover:bg-slate-800',
    'border-slate-300 text-slate-700 hover:bg-white',
  )}`;

  return (
    <div
      className="backdrop-blur-xs fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3"
      onClick={e => e.target === e.currentTarget && onClose()}
      role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="plans-dialog-title"
        className={`relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border shadow-xl ${tone(
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
            <p className={`text-xs ${muted}`}>Your JobForm Automator plan and upgrades</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`cursor-pointer rounded-lg p-1.5 transition-colors ${tone(
              'text-slate-400 hover:bg-slate-800 hover:text-slate-100',
              'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
            )}`}
            aria-label="Close">
            <FiX className="size-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {/* Purchase in progress / result */}
          {message && purchase && (
            <div
              role={message.tone === 'error' ? 'alert' : 'status'}
              className={`rounded-lg border px-3 py-2.5 text-xs ${
                message.tone === 'error'
                  ? tone('border-red-900/50 bg-red-950/30 text-red-300', 'border-red-200 bg-red-50 text-red-700')
                  : message.tone === 'success'
                    ? tone(
                        'border-emerald-900/50 bg-emerald-950/30 text-emerald-300',
                        'border-emerald-200 bg-emerald-50 text-emerald-800',
                      )
                    : tone('border-sky-900/50 bg-sky-950/30 text-sky-200', 'border-sky-200 bg-sky-50 text-sky-900')
              }`}>
              <div className="flex items-start gap-2">
                {message.tone === 'error' ? (
                  <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                ) : message.tone === 'success' ? (
                  <FiCheck className="mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <AiOutlineLoading3Quarters
                    className={`mt-0.5 size-3.5 shrink-0 ${purchase.phase === 'waiting' ? 'animate-spin' : ''}`}
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{message.title}</p>
                  {message.detail && <p className="mt-0.5">{message.detail}</p>}
                </div>
                {purchase.phase !== 'waiting' && (
                  <button
                    type="button"
                    onClick={billing.dismiss}
                    className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 hover:opacity-100"
                    aria-label="Dismiss">
                    <FiX className="size-3.5" />
                  </button>
                )}
              </div>
              {purchase.phase === 'waiting' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={billing.reopen}
                    className="flex cursor-pointer items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-700">
                    <FiExternalLink className="size-3" />
                    Open payment page
                  </button>
                  <button type="button" onClick={billing.stopWaiting} className={secondaryButton}>
                    Stop waiting
                  </button>
                </div>
              )}
              {purchase.phase === 'other-account' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openJobformSignIn()}
                    className="flex cursor-pointer items-center gap-1 rounded-md bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-700">
                    <FiExternalLink className="size-3" />
                    Sign in with that account
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Your plan */}
          <section className={`${card} divide-y ${tone('divide-slate-700', 'divide-slate-100')}`}>
            <div className="flex items-start gap-2.5 p-3">
              <span
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
                  premiumActive
                    ? tone('bg-violet-500/20 text-violet-300', 'bg-violet-100 text-violet-700')
                    : tone('bg-slate-700 text-slate-300', 'bg-slate-100 text-slate-500')
                }`}>
                <FiStar className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold">
                    {premiumActive ? `JobForm Automator ${premium?.tier}` : `${BASIC_PLAN.name} (Free)`}
                  </span>
                  {premiumActive && <span className={activeBadge}>Active</span>}
                  {!billing.statusLoaded && (
                    <AiOutlineLoading3Quarters className="size-3 animate-spin opacity-60" aria-label="Checking plan" />
                  )}
                </div>
                <ul className={`mt-1 space-y-0.5 text-[11px] ${tone('text-slate-300', 'text-slate-600')}`}>
                  {premiumActive ? (
                    <>
                      {EXTENSION_BENEFITS.map(benefit => (
                        <li key={benefit}>{benefit}</li>
                      ))}
                      {premium?.endDate && premium.tier !== 'Diamond' && (
                        <li>Active until {formatDate(premium.endDate)}</li>
                      )}
                    </>
                  ) : (
                    <li>Up to {FREE_DAILY_APPLICATIONS} applications a day</li>
                  )}
                </ul>
              </div>
            </div>

            {(creditPlan || userCredits) && (
              <div className="p-3">
                {creditPlan && (
                  <div className="mb-2">
                    <p className={`text-[11px] font-medium ${muted}`}>Credit plan</p>
                    <p className="text-sm font-semibold">{creditPlan.title}</p>
                    {creditPlan.detail && <p className={`text-[11px] ${muted}`}>{creditPlan.detail}</p>}
                  </div>
                )}
                {userCredits && (
                  <div>
                    <div className="flex items-baseline justify-between text-[11px]">
                      <span
                        className={`flex items-center gap-1 font-medium ${tone('text-slate-300', 'text-slate-700')}`}>
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
            )}
          </section>

          {/* JobForm Automator plans (same plans, prices and checkout as the website) */}
          <section>
            <div className="px-1">
              <h3 className="text-xs font-semibold">JobForm Automator plans</h3>
              <p className={`text-[11px] ${muted}`}>
                Same plans and prices as jobformautomator.com. One plan for both.
              </p>
            </div>

            {!plans && !plansError && (
              <div className={`mt-2 flex items-center justify-center gap-2 p-6 text-xs ${card} ${muted}`}>
                <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />
                Loading plans…
              </div>
            )}

            {plansError && (
              <div className={`mt-2 p-3 text-xs ${card}`}>
                <p className={tone('text-amber-300', 'text-amber-700')}>{plansError}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void billing.loadPlans()}
                    className={`flex items-center gap-1 ${secondaryButton}`}>
                    <FiRefreshCw className="size-3" />
                    Try again
                  </button>
                  <button
                    type="button"
                    onClick={openJobformPricing}
                    className="flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold text-sky-600 hover:underline">
                    <FiExternalLink className="size-3" />
                    Open pricing page
                  </button>
                </div>
              </div>
            )}

            {plans && (
              <div className="mt-2 space-y-2">
                <div
                  className={`rounded-xl border p-3 ${
                    premiumActive
                      ? tone('border-slate-700 bg-slate-800/70', 'border-slate-200 bg-white')
                      : tone('border-emerald-500/60 bg-emerald-950/20', 'border-emerald-300 bg-emerald-50/50')
                  }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <h4 className="text-sm font-bold">{BASIC_PLAN.name}</h4>
                        {!premiumActive && <span className={activeBadge}>Current</span>}
                      </div>
                      <p className={`text-[11px] ${muted}`}>{BASIC_PLAN.description}</p>
                    </div>
                    <p className="shrink-0 text-base font-bold">Free</p>
                  </div>
                  <ul className={`mt-2 space-y-1 text-xs ${tone('text-slate-300', 'text-slate-700')}`}>
                    {[`Up to ${FREE_DAILY_APPLICATIONS} applications a day`, 'AI Auto Apply uses AI credits'].map(
                      feature => (
                        <li key={feature} className="flex items-start gap-2">
                          <FiCheck className={`mt-0.5 size-3.5 shrink-0 ${muted}`} aria-hidden="true" />
                          <span>{feature}</span>
                        </li>
                      ),
                    )}
                  </ul>
                </div>
                {plans.map(plan => {
                  const action = planAction(plan, premium);
                  const isDiamond = plan.id === 'Diamond';
                  const otherPrice =
                    currency === 'USD' ? `${plan.prices.INR} in India` : `${plan.prices.USD} outside India`;
                  const loading = billing.opening === plan.id;
                  return (
                    <div
                      key={plan.id}
                      className={`rounded-xl border p-3 ${
                        action === 'current'
                          ? tone('border-emerald-500/60 bg-emerald-950/20', 'border-emerald-300 bg-emerald-50/50')
                          : isDiamond
                            ? tone('border-sky-500/60 bg-slate-800/70', 'border-sky-300 bg-white ring-1 ring-sky-200')
                            : tone('border-slate-700 bg-slate-800/70', 'border-slate-200 bg-white')
                      }`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <h4 className="text-sm font-bold">{plan.id}</h4>
                            {action === 'current' && <span className={activeBadge}>Current</span>}
                          </div>
                          <p className={`text-[11px] ${muted}`}>{plan.description}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="whitespace-nowrap">
                            <span className="text-base font-bold">{plan.prices[currency ?? 'INR']}</span>
                            <span className={`text-[11px] ${muted}`}> / {plan.durationLabel}</span>
                          </p>
                          <p className={`text-[10px] ${muted}`}>{otherPrice}</p>
                        </div>
                      </div>

                      <ul className={`mt-2 space-y-1 text-xs ${tone('text-slate-300', 'text-slate-700')}`}>
                        {EXTENSION_BENEFITS.map(feature => (
                          <li key={feature} className="flex items-start gap-2">
                            <FiCheck
                              className={`mt-0.5 size-3.5 shrink-0 ${tone('text-emerald-400', 'text-emerald-600')}`}
                              aria-hidden="true"
                            />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>

                      {action === 'current' || action === 'included' ? (
                        <p
                          className={`mt-2.5 flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold ${tone(
                            'bg-emerald-500/10 text-emerald-300',
                            'bg-emerald-100/70 text-emerald-800',
                          )}`}>
                          <FiCheck className="size-3.5" />
                          {action === 'current' ? 'Your current plan' : 'Included in Diamond'}
                        </p>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void billing.buy(plan.id)}
                          disabled={busy}
                          className={`mt-2.5 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                            isDiamond
                              ? 'bg-sky-600 text-white hover:bg-sky-700'
                              : tone(
                                  'border border-slate-600 text-slate-100 hover:bg-slate-700',
                                  'border border-slate-300 text-slate-800 hover:bg-slate-50',
                                )
                          }`}>
                          {loading ? (
                            <>
                              <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />
                              <span>Opening checkout…</span>
                            </>
                          ) : (
                            <span>{action === 'upgrade' ? `Upgrade to ${plan.id}` : `Choose ${plan.id}`}</span>
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
          <FiLock className={`size-3.5 shrink-0 ${tone('text-emerald-400', 'text-emerald-600')}`} />
          <span>
            Secure Razorpay checkout on jobformautomator.com. Your plan unlocks after JobForm Automator verifies the
            payment.
          </span>
        </div>
      </div>
    </div>
  );
};
