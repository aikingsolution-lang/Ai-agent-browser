import React from 'react';
import {
  isPremiumActive,
  JOBFORM_PRICING_URL,
  openJobformPricing,
  openJobformSignIn,
  useJobformPayment,
  type JobformPlan,
} from '@extension/shared';
import type { PremiumStatus } from '@extension/storage';
import { FiCheck, FiShield, FiExternalLink, FiRefreshCw, FiAlertTriangle, FiCheckCircle } from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

interface PremiumPlansProps {
  isDarkMode: boolean;
}

/** What Premium / Diamond give in the extension (enforced by the backend). */
const EXTENSION_BENEFITS = [
  'Up to 300 applications a day',
  'AI Auto Apply included, no credits used',
  'Premium Mode: 1,000 AI tasks a month',
];
const FREE_DAILY_APPLICATIONS = 10;
/** The free plan, as the website's pricing page names and describes it. */
const BASIC_PLAN = { name: 'Basic', description: 'Essential Tools to Kickstart Your Job Search' };

const formatDate = (iso?: string | null) =>
  iso && !Number.isNaN(Date.parse(iso))
    ? new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

function planAction(plan: JobformPlan, premium: PremiumStatus | null): 'buy' | 'upgrade' | 'current' | 'included' {
  const tier = isPremiumActive(premium) ? premium!.tier : 'Free';
  if (tier === plan.id) return 'current';
  if (tier === 'Diamond') return 'included';
  return tier === 'Premium' ? 'upgrade' : 'buy';
}

/**
 * JobForm Automator Premium / Diamond — the same plans and prices as jobformautomator.com. Choosing a
 * plan opens the website's checkout page; the plan unlocks here once the website has verified the
 * payment (its `paymentSuccessfull` event, then the backend confirms the plan).
 */
export const PremiumPlans: React.FC<PremiumPlansProps> = ({ isDarkMode }) => {
  const billing = useJobformPayment(true);
  const { plans, plansError, premium, purchase, currency } = billing;
  const premiumActive = isPremiumActive(premium);
  const busy = billing.opening !== null || purchase?.phase === 'waiting';
  const tone = (dark: string, light: string) => (isDarkMode ? dark : light);
  const outlineButton = 'rounded-lg border border-current px-3 py-1.5 text-xs font-semibold cursor-pointer';
  const primaryButton =
    'rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-700 cursor-pointer';

  return (
    <section className="space-y-6">
      <div
        className={`shadow-xs rounded-2xl border p-8 text-left ${tone('border-slate-800 bg-slate-900', 'border-slate-200 bg-white')}`}>
        <div className="mx-auto mb-8 max-w-2xl text-center">
          <h2 className={`text-2xl font-bold sm:text-3xl ${tone('text-slate-100', 'text-slate-900')}`}>
            JobForm Automator plans
          </h2>
          <p className={`mt-2 text-sm ${tone('text-slate-400', 'text-slate-600')}`}>
            One plan for the website and the extension, with the same prices as jobformautomator.com.
          </p>
          <p className={`mt-3 text-sm font-medium ${tone('text-slate-300', 'text-slate-700')}`}>
            {!billing.statusLoaded
              ? 'Checking your plan…'
              : premiumActive
                ? `Your plan: ${premium?.tier}${premium?.endDate && premium.tier !== 'Diamond' ? `, active until ${formatDate(premium.endDate)}` : ''}`
                : `Your plan: ${BASIC_PLAN.name} (Free, up to ${FREE_DAILY_APPLICATIONS} applications a day)`}
          </p>
        </div>

        {purchase && (
          <div
            role={purchase.phase === 'other-account' ? 'alert' : 'status'}
            className={`mx-auto mb-6 max-w-3xl rounded-xl border px-4 py-3 text-sm ${
              purchase.phase === 'active'
                ? tone(
                    'border-emerald-800 bg-emerald-950/30 text-emerald-200',
                    'border-emerald-200 bg-emerald-50 text-emerald-800',
                  )
                : purchase.phase === 'other-account'
                  ? tone('border-red-900 bg-red-950/30 text-red-300', 'border-red-200 bg-red-50 text-red-700')
                  : tone('border-sky-900 bg-sky-950/30 text-sky-200', 'border-sky-200 bg-sky-50 text-sky-900')
            }`}>
            {purchase.phase === 'waiting' && (
              <div className="flex flex-wrap items-center gap-3">
                <AiOutlineLoading3Quarters className="size-4 shrink-0 animate-spin" />
                <span className="flex-1">
                  {purchase.received
                    ? `Payment received by JobForm Automator. Confirming your ${purchase.plan} plan…`
                    : purchase.url === JOBFORM_PRICING_URL
                      ? `Choose ${purchase.plan} on the JobForm Automator pricing page. It unlocks here automatically once the payment is confirmed.`
                      : `Finish the payment in the JobForm Automator tab. ${purchase.plan} unlocks here automatically once the payment is confirmed.`}
                </span>
                <button type="button" onClick={billing.reopen} className={primaryButton}>
                  Open payment page
                </button>
                <button type="button" onClick={billing.stopWaiting} className={outlineButton}>
                  Stop waiting
                </button>
              </div>
            )}
            {purchase.phase === 'active' && (
              <p className="flex items-center gap-2">
                <FiCheckCircle className="size-4 shrink-0" />
                Payment confirmed. {purchase.premium.tier} is active here and on jobformautomator.com.
              </p>
            )}
            {purchase.phase === 'timeout' && (
              <p>We haven&apos;t seen the payment yet. If you completed it, your plan unlocks within a few minutes.</p>
            )}
            {purchase.phase === 'other-account' && (
              <div className="flex flex-wrap items-center gap-3">
                <FiAlertTriangle className="size-4 shrink-0" />
                <span className="flex-1">
                  This payment was made with a different JobForm Automator account than the one signed in here. Sign in
                  with that account to use {purchase.plan} in the extension.
                </span>
                <button type="button" onClick={() => void openJobformSignIn()} className={primaryButton}>
                  Sign in with that account
                </button>
              </div>
            )}
          </div>
        )}

        {!plans && !plansError && (
          <p
            className={`flex items-center justify-center gap-2 py-10 text-sm ${tone('text-slate-400', 'text-slate-500')}`}>
            <AiOutlineLoading3Quarters className="size-4 animate-spin" />
            Loading plans…
          </p>
        )}

        {plansError && (
          <div className="flex flex-col items-center gap-3 py-8 text-sm">
            <p className={tone('text-amber-300', 'text-amber-700')}>{plansError}</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => void billing.loadPlans()}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold ${tone(
                  'border-slate-700 text-slate-200 hover:bg-slate-800',
                  'border-slate-300 text-slate-700 hover:bg-slate-50',
                )}`}>
                <FiRefreshCw className="size-3.5" />
                Try again
              </button>
              <button
                type="button"
                onClick={openJobformPricing}
                className="flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-sky-600 hover:underline">
                <FiExternalLink className="size-3.5" />
                Open pricing page
              </button>
            </div>
          </div>
        )}

        {plans && (
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 lg:grid-cols-3">
            <div
              className={`flex flex-col rounded-xl border p-6 ${
                premiumActive
                  ? tone('border-slate-800', 'border-slate-200')
                  : 'border-emerald-500 ring-1 ring-emerald-500'
              } ${tone('bg-slate-900/60', 'bg-white')}`}>
              <div className="flex items-center justify-between gap-2">
                <h3 className={`text-base font-semibold ${tone('text-slate-100', 'text-slate-900')}`}>
                  {BASIC_PLAN.name}
                </h3>
                {!premiumActive && (
                  <span className="rounded-full border border-emerald-300 px-2.5 py-0.5 text-xs font-semibold text-emerald-600">
                    Active plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${tone('text-slate-400', 'text-slate-500')}`}>{BASIC_PLAN.description}</p>
              <p className={`mt-4 text-3xl font-bold ${tone('text-slate-100', 'text-slate-900')}`}>Free</p>
              <ul
                className={`mt-5 space-y-2.5 border-t pt-4 text-xs ${tone(
                  'border-slate-800 text-slate-300',
                  'border-slate-100 text-slate-600',
                )}`}>
                {[`Up to ${FREE_DAILY_APPLICATIONS} applications a day`, 'AI Auto Apply uses AI credits'].map(
                  feature => (
                    <li key={feature} className="flex items-start gap-2">
                      <FiCheck className="mt-0.5 size-4 shrink-0 text-slate-400" />
                      <span>{feature}</span>
                    </li>
                  ),
                )}
              </ul>
            </div>
            {plans.map(plan => {
              const action = planAction(plan, premium);
              const isDiamond = plan.id === 'Diamond';
              const loading = billing.opening === plan.id;
              return (
                <div
                  key={plan.id}
                  className={`flex flex-col justify-between rounded-xl border p-6 ${
                    action === 'current'
                      ? 'border-emerald-500 ring-1 ring-emerald-500'
                      : isDiamond
                        ? tone('border-blue-500/80 ring-1 ring-blue-500/50', 'border-blue-600 ring-1 ring-blue-600')
                        : tone('border-slate-800', 'border-slate-200')
                  } ${tone('bg-slate-900/60', 'bg-white')}`}>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={`text-base font-semibold ${tone('text-slate-100', 'text-slate-900')}`}>
                        {plan.id}
                      </h3>
                      {action === 'current' && (
                        <span className="rounded-full border border-emerald-300 px-2.5 py-0.5 text-xs font-semibold text-emerald-600">
                          Active plan
                        </span>
                      )}
                    </div>
                    <p className={`mt-1 text-xs ${tone('text-slate-400', 'text-slate-500')}`}>{plan.description}</p>
                    <div className="mt-4 flex items-baseline gap-1">
                      <span className={`text-3xl font-bold ${tone('text-slate-100', 'text-slate-900')}`}>
                        {plan.prices[currency ?? 'INR']}
                      </span>
                      <span className={`text-xs ${tone('text-slate-400', 'text-slate-500')}`}>
                        / {plan.durationLabel}
                      </span>
                    </div>
                    <p className={`text-[11px] ${tone('text-slate-500', 'text-slate-400')}`}>
                      {currency === 'USD' ? `${plan.prices.INR} in India` : `${plan.prices.USD} outside India`}
                    </p>
                    <ul
                      className={`mt-5 space-y-2.5 border-t pt-4 text-xs ${tone(
                        'border-slate-800 text-slate-300',
                        'border-slate-100 text-slate-600',
                      )}`}>
                      {EXTENSION_BENEFITS.map(feature => (
                        <li key={feature} className="flex items-start gap-2">
                          <FiCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  {action === 'current' || action === 'included' ? (
                    <p className="mt-6 w-full rounded-lg bg-emerald-50 py-2.5 text-center text-xs font-semibold text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      {action === 'current' ? 'Your current plan' : 'Included in Diamond'}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void billing.buy(plan.id)}
                      disabled={busy}
                      className={`mt-6 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg py-2.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                        isDiamond
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : tone(
                              'border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700',
                              'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
                            )
                      }`}>
                      {loading && <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />}
                      {loading
                        ? 'Opening checkout…'
                        : action === 'upgrade'
                          ? `Upgrade to ${plan.id}`
                          : `Choose ${plan.id}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div
          className={`mx-auto mt-8 flex max-w-3xl items-center gap-3 border-t pt-6 ${tone('border-slate-800', 'border-slate-100')}`}>
          <FiShield className="size-5 shrink-0 text-blue-600" />
          <p className={`text-[11px] ${tone('text-slate-400', 'text-slate-500')}`}>
            Secure Razorpay checkout on jobformautomator.com (UPI, cards, net banking). Your plan unlocks after the
            payment is verified, on the website and in the extension.
          </p>
        </div>
      </div>
    </section>
  );
};
