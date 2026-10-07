import React, { useState, useEffect } from 'react';
import { backendApiClient } from '@extension/shared';
import { cloudApiSettingsStore } from '@extension/storage';
import {
  FiCheck,
  FiZap,
  FiShield,
  FiX,
  FiCheckCircle,
  FiArrowRight,
  FiCreditCard,
  FiClock,
  FiLock,
  FiHelpCircle,
} from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

interface PremiumPlansModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
  userCredits?: { remainingCredits: number; allocatedCredits: number } | null;
}

export const PremiumPlansModal: React.FC<PremiumPlansModalProps> = ({
  isOpen,
  onClose,
  isDarkMode = false,
  userCredits,
}) => {
  const [currentSubscription, setCurrentSubscription] = useState<any | null>(null);
  const [loadingPlanCode, setLoadingPlanCode] = useState<string | null>(null);
  const [selectedPlanCode, setSelectedPlanCode] = useState<'starter' | 'pro' | 'power'>('pro');
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    async function loadSubscription() {
      try {
        const res = await backendApiClient.getSubscriptionMe();
        if (isMounted && res.data?.subscription) {
          setCurrentSubscription(res.data.subscription);
          if (res.data.subscription.planCodeSnapshot && res.data.subscription.planCodeSnapshot !== 'free-trial') {
            setSelectedPlanCode(res.data.subscription.planCodeSnapshot as any);
          }
        }
      } catch {
        // Fallback gracefully
      }
    }
    loadSubscription();

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const plans = [
    {
      code: 'starter' as const,
      name: 'Starter',
      badge: null,
      tagline: 'Essential automation for active job hunters',
      monthlyPrice: '₹499',
      annualPrice: '₹399',
      credits: '1,000',
      rateLimit: '120 req / min',
      features: [
        '1,000 monthly automation credits',
        'Auto-apply on LinkedIn, Indeed & Naukri',
        'AI CareerBrain profile extraction',
        'Screening question auto-fill',
        'Standard email support',
      ],
      recommended: false,
    },
    {
      code: 'pro' as const,
      name: 'Pro Automation',
      badge: '✦ Most Popular',
      tagline: 'High volume applying with premium AI models',
      monthlyPrice: '₹1,499',
      annualPrice: '₹1,199',
      credits: '5,000',
      rateLimit: '300 req / min',
      features: [
        '5,000 monthly automation credits',
        'All AI models (Claude 3.5 Sonnet & Nova)',
        'Priority screening question solver',
        'Deep resume keyword scanner',
        'Multi-job automated batch processing',
        'Priority chat & email support',
      ],
      recommended: true,
    },
    {
      code: 'power' as const,
      name: 'Power Enterprise',
      badge: 'Maximum Speed',
      tagline: 'Maximum throughput for multi-role campaigns',
      monthlyPrice: '₹4,999',
      annualPrice: '₹3,999',
      credits: '25,000',
      rateLimit: '600 req / min',
      features: [
        '25,000 monthly automation credits',
        '600 req/min ultra-fast rate limit',
        'Concurrent background apply sessions',
        'Custom screening rules & answers engine',
        'Instant credit top-ups without cooldown',
        'Dedicated 24/7 engineering support',
      ],
      recommended: false,
    },
  ];

  const handleCheckout = async (planCode: string) => {
    setLoadingPlanCode(planCode);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const idempotencyKey = `checkout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const res = await backendApiClient.createCheckoutSession(planCode, idempotencyKey);

      if (res.data?.shortUrl) {
        window.open(res.data.shortUrl, '_blank');
        setSuccessMessage('Razorpay payment window opened. Complete checkout to activate.');
      } else {
        setSuccessMessage(`Subscription order generated for ${planCode.toUpperCase()}!`);
      }

      await cloudApiSettingsStore.updateSubscription({
        planId: planCode as any,
        status: 'active',
        billingInterval,
      });
      await cloudApiSettingsStore.setApiMode('premium');
    } catch (err: any) {
      setErrorMessage(err.message || 'Payment initiation failed. Please try again or check connection.');
    } finally {
      setLoadingPlanCode(null);
    }
  };

  const remaining = userCredits?.remainingCredits ?? 0;
  const allocated = Math.max(userCredits?.allocatedCredits ?? 1, 1);
  const creditPercent = Math.min(Math.round((remaining / allocated) * 100), 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className={`relative flex flex-col w-full max-w-lg max-h-[92vh] rounded-2xl border shadow-xl overflow-hidden ${
          isDarkMode ? 'bg-slate-900 border-slate-800 text-slate-100' : 'bg-white border-slate-200 text-slate-900'
        }`}>
        {/* Header Bar */}
        <div
          className={`relative px-5 pt-5 pb-4 border-b shrink-0 ${
            isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-slate-50'
          }`}>
          <button
            onClick={onClose}
            className={`absolute right-4 top-4 rounded-lg p-1.5 transition-colors cursor-pointer ${
              isDarkMode
                ? 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                : 'text-slate-400 hover:text-slate-900 hover:bg-slate-200'
            }`}
            aria-label="Close modal">
            <FiX className="size-4" />
          </button>

          {/* Section Breadcrumb / Category */}
          <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 mb-1">
            <span className="text-xs">✦</span>
            <span>SUBSCRIPTION & CREDITS</span>
          </div>

          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Automate Job Applications with AI</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Choose a plan that fits your job search volume. Credits refill monthly.
          </p>

          {/* Current Subscription & Credit Status Card */}
          <div
            className={`mt-3 rounded-xl border p-3 ${
              isDarkMode ? 'border-slate-800 bg-slate-800/60' : 'border-slate-200 bg-white'
            }`}>
            <div className="flex items-center justify-between text-xs mb-1.5">
              <div className="flex items-center gap-1.5">
                {currentSubscription?.status === 'ACTIVE' && currentSubscription?.planCodeSnapshot !== 'free-trial' ? (
                  <>
                    <span className="size-2 rounded-full bg-emerald-500" />
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {currentSubscription.planNameSnapshot || 'Pro Automation'} Plan Active
                    </span>
                  </>
                ) : currentSubscription?.status === 'EXPIRED' ? (
                  <>
                    <span className="size-2 rounded-full bg-amber-500" />
                    <span className="font-semibold text-amber-700 dark:text-amber-400">Subscription Expired</span>
                  </>
                ) : (
                  <>
                    <span className="size-2 rounded-full bg-blue-500" />
                    <span className="font-semibold text-slate-800 dark:text-slate-200">Free Trial Active</span>
                  </>
                )}
              </div>

              {/* Credits text */}
              <span className="font-semibold text-slate-700 dark:text-slate-300">
                {remaining.toLocaleString()}{' '}
                <span className="font-normal text-slate-400">/ {allocated.toLocaleString()} Credits</span>
              </span>
            </div>

            {/* Progress bar */}
            <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div
                className={`h-full transition-all duration-500 rounded-full ${
                  creditPercent < 20 ? 'bg-amber-500' : 'bg-blue-600'
                }`}
                style={{ width: `${Math.max(creditPercent, 3)}%` }}
              />
            </div>

            {/* Validity / Help subtext */}
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                {currentSubscription?.currentPeriodEnd
                  ? `Renews: ${new Date(currentSubscription.currentPeriodEnd).toLocaleDateString()}`
                  : '50-100 free trial credits allocated'}
              </span>
              <span className="flex items-center gap-1">
                <FiZap className="size-3 text-indigo-500" />
                <span>1 credit = 1 automated step</span>
              </span>
            </div>
          </div>

          {/* Billing Switcher (Monthly / Annual) */}
          <div className="mt-3 flex items-center justify-center">
            <div className="inline-flex items-center p-0.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setBillingInterval('monthly')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                  billingInterval === 'monthly'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900'
                }`}>
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setBillingInterval('yearly')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer flex items-center gap-1 ${
                  billingInterval === 'yearly'
                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-900'
                }`}>
                <span>Annual</span>
                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.2 rounded-full border border-emerald-200 dark:border-emerald-800">
                  Save 20%
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Scrollable Plan Selection Cards */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {errorMessage && (
            <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 p-2.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-2">
              <FiX className="size-4 shrink-0 text-red-600 dark:text-red-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {successMessage && (
            <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-2.5 text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
              <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}

          {plans.map(plan => {
            const isSelected = selectedPlanCode === plan.code;
            const isCurrentActivePlan =
              currentSubscription?.status === 'ACTIVE' && currentSubscription?.planCodeSnapshot === plan.code;
            const price = billingInterval === 'yearly' ? plan.annualPrice : plan.monthlyPrice;

            return (
              <div
                key={plan.code}
                onClick={() => setSelectedPlanCode(plan.code)}
                className={`relative rounded-xl border p-4 transition-all cursor-pointer ${
                  isCurrentActivePlan
                    ? isDarkMode
                      ? 'border-emerald-600/70 bg-emerald-950/20'
                      : 'border-emerald-500 bg-emerald-50/40'
                    : isSelected
                      ? plan.recommended
                        ? isDarkMode
                          ? 'border-blue-500 bg-blue-950/20 shadow-xs'
                          : 'border-blue-600 bg-blue-50/30 shadow-xs'
                        : isDarkMode
                          ? 'border-slate-700 bg-slate-800/80 shadow-xs'
                          : 'border-slate-400 bg-slate-50/50 shadow-xs'
                      : isDarkMode
                        ? 'border-slate-800 bg-slate-900 hover:border-slate-700'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                }`}>
                {/* Plan Badge Pill */}
                {isCurrentActivePlan ? (
                  <span className="absolute -top-2.5 right-4 rounded-full bg-emerald-600 px-2.5 py-0.5 text-[10px] font-semibold text-white shadow-xs flex items-center gap-1">
                    <FiCheck className="size-3" /> Current Plan
                  </span>
                ) : plan.badge ? (
                  <span
                    className={`absolute -top-2.5 right-4 rounded-full px-2.5 py-0.5 text-[10px] font-semibold shadow-xs ${
                      plan.recommended
                        ? 'bg-blue-600 text-white'
                        : isDarkMode
                          ? 'bg-slate-700 text-slate-200'
                          : 'bg-slate-800 text-white'
                    }`}>
                    {plan.badge}
                  </span>
                ) : null}

                {/* Plan Header */}
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-sm text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      <span>{plan.name}</span>
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{plan.tagline}</p>
                  </div>

                  <div className="text-right">
                    <div className="flex items-baseline justify-end gap-1">
                      <span className="text-lg font-bold text-slate-900 dark:text-slate-100">{price}</span>
                      <span className="text-xs text-slate-500 dark:text-slate-400">/ mo</span>
                    </div>
                    {billingInterval === 'yearly' && (
                      <span className="text-[10px] text-slate-400 block">Billed annually</span>
                    )}
                  </div>
                </div>

                {/* Credits & Limits Spec Pills */}
                <div className="mt-2.5 flex items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                    <FiZap className="size-3 text-indigo-500" />
                    <span>{plan.credits} Credits / mo</span>
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-medium">
                    <FiClock className="size-3 text-slate-400" />
                    <span>{plan.rateLimit}</span>
                  </span>
                </div>

                {/* Features List */}
                <div className="mt-3 space-y-1.5 border-t border-slate-100 dark:border-slate-800/80 pt-2.5">
                  {plan.features.map((feat, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                      <FiCheck className="size-3.5 text-emerald-600 dark:text-emerald-500 shrink-0" />
                      <span>{feat}</span>
                    </div>
                  ))}
                </div>

                {/* Primary / Secondary CTA Button */}
                <div className="mt-3.5">
                  {isCurrentActivePlan ? (
                    <div className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2 px-3 text-xs font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 cursor-default">
                      <FiCheckCircle className="size-3.5" />
                      <span>Active Subscription</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        handleCheckout(plan.code);
                      }}
                      disabled={loadingPlanCode === plan.code}
                      className={`w-full flex items-center justify-center gap-2 rounded-lg py-2 px-4 text-xs font-semibold transition-all cursor-pointer ${
                        plan.recommended
                          ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-xs active:scale-[0.99]'
                          : isDarkMode
                            ? 'bg-slate-800 hover:bg-slate-700 text-slate-100 border border-slate-700'
                            : 'bg-white hover:bg-slate-50 text-slate-800 border border-slate-300 shadow-xs'
                      } disabled:opacity-50`}>
                      {loadingPlanCode === plan.code ? (
                        <>
                          <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />
                          <span>Preparing Checkout...</span>
                        </>
                      ) : (
                        <>
                          <FiCreditCard className="size-3.5" />
                          <span>Upgrade to {plan.name}</span>
                          <FiArrowRight className="size-3" />
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Modal Footer (Trust & Dismiss) */}
        <div
          className={`p-3.5 border-t shrink-0 flex items-center justify-between text-xs ${
            isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-slate-50'
          }`}>
          <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
            <FiLock className="size-3.5 text-emerald-600 dark:text-emerald-500" />
            <span>Secure 256-bit Razorpay Checkout</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              isDarkMode
                ? 'text-slate-300 hover:text-white hover:bg-slate-800'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200'
            }`}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
