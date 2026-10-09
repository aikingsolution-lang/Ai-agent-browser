import React, { useState, useEffect } from 'react';
import { backendApiClient, isPremiumActive, refreshAccountStatus } from '@extension/shared';
import type { PremiumStatus } from '@extension/storage';
import {
  FiCheck,
  FiZap,
  FiStar,
  FiShield,
  FiX,
  FiLock,
  FiCheckCircle,
  FiArrowRight,
  FiCreditCard,
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
  const [jobformPremium, setJobformPremium] = useState<PremiumStatus | null>(null);
  const [loadingPlanCode, setLoadingPlanCode] = useState<string | null>(null);
  const [selectedPlanCode, setSelectedPlanCode] = useState<'starter' | 'pro' | 'power'>('pro');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    async function loadSubscription() {
      try {
        // Status always comes from the backend (also updates the stored session)
        const status = await refreshAccountStatus();
        if (isMounted && status) {
          setJobformPremium(status.premium);
        }
        if (isMounted && status?.subscription) {
          setCurrentSubscription(status.subscription);
          if (status.subscription.planCodeSnapshot && status.subscription.planCodeSnapshot !== 'free-trial') {
            setSelectedPlanCode(status.subscription.planCodeSnapshot as any);
          }
        }
      } catch (err) {
        // Fallback gracefully
      }
    }
    loadSubscription();

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const plans = [
    {
      code: 'starter',
      name: 'Starter Plan',
      tagline: 'Ideal for active job seekers & daily applications',
      amountPaise: 49900,
      priceFormatted: '₹499',
      credits: '1,000 Credits / mo',
      rateLimit: '120 req / min',
      features: [
        '1,000 monthly automation credits',
        'Autonomous LinkedIn, Naukri & Indeed apply',
        'Smart AI Resume Parsing',
        'Standard screening question solver',
        'Standard support',
      ],
      popular: false,
      color: 'from-blue-500 to-sky-600',
    },
    {
      code: 'pro',
      name: 'Pro Automation Plan',
      tagline: 'Best value for high-volume applications & multiple roles',
      amountPaise: 149900,
      priceFormatted: '₹1,499',
      credits: '5,000 Credits / mo',
      rateLimit: '300 req / min',
      features: [
        '5,000 monthly automation credits',
        'All AI models (Claude 3.5, GPT-4o & Nova)',
        'Priority screening question solver',
        'Deep relevance matching & keyword scanner',
        'Autonomous multi-job batch application',
        'Priority email & chat support',
      ],
      popular: true,
      color: 'from-amber-500 to-orange-600',
    },
    {
      code: 'power',
      name: 'Power Enterprise Plan',
      tagline: 'Maximum speed and limits for power job seekers & teams',
      amountPaise: 499900,
      priceFormatted: '₹4,999',
      credits: '25,000 Credits / mo',
      rateLimit: '600 req / min',
      features: [
        '25,000 monthly automation credits',
        '600 req/min enterprise rate limit',
        'Unlimited concurrent background apply loops',
        'Custom screening answers & rules engine',
        'Instant credit top-ups with no cooldowns',
        'Dedicated 24/7 priority support',
      ],
      popular: false,
      color: 'from-purple-500 to-indigo-600',
    },
  ];

  if (!isOpen) return null;

  const handleCheckout = async (planCode: string) => {
    setLoadingPlanCode(planCode);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const idempotencyKey = `checkout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const res = await backendApiClient.createCheckoutSession(planCode, idempotencyKey);

      // The plan becomes active only when the backend has verified the payment (Razorpay signature
      // check / webhook); nothing is unlocked here.
      if (res.data?.shortUrl) {
        window.open(res.data.shortUrl, '_blank');
        setSuccessMessage('Checkout opened. Your plan activates as soon as the payment is confirmed.');
      } else {
        setSuccessMessage(
          `Subscription session created for ${planCode.toUpperCase()}. Complete the payment to activate it.`,
        );
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to initiate checkout. Please try again.');
    } finally {
      setLoadingPlanCode(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className={`relative flex flex-col w-full max-w-md max-h-[92vh] rounded-2xl border shadow-2xl overflow-hidden ${
          isDarkMode ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-gray-200 text-gray-900'
        }`}>
        {/* Modal Header */}
        <div className="relative p-5 pb-3 border-b border-inherit bg-gradient-to-b from-sky-500/10 to-transparent shrink-0">
          <button
            onClick={onClose}
            className="absolute right-4 top-4 rounded-full p-1.5 text-gray-400 hover:text-white hover:bg-slate-700/50 transition-colors cursor-pointer"
            aria-label="Close modal">
            <FiX className="size-5" />
          </button>

          <div className="flex items-center gap-2 mb-1">
            <span className="flex items-center justify-center size-7 rounded-lg bg-gradient-to-tr from-amber-500 to-orange-500 text-white shadow-md shadow-orange-500/20">
              <FiZap className="size-4" />
            </span>
            <span className="text-[11px] font-bold uppercase tracking-wider text-amber-400">
              Commercial Subscription
            </span>
          </div>
          <h2 className="text-lg font-extrabold tracking-tight">NanoBrowser Premium Plans</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            Supercharge your job hunt with cloud automation capacity & AI credits.
          </p>

          {/* JobForm Automator plan (server-verified, shown for information) */}
          {isPremiumActive(jobformPremium) && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs">
              <FiStar className={`size-4 shrink-0 ${isDarkMode ? 'text-violet-300' : 'text-violet-600'}`} />
              <div>
                <span className={`font-semibold ${isDarkMode ? 'text-violet-200' : 'text-violet-700'}`}>
                  JobForm Automator {jobformPremium?.tier}
                </span>
                {jobformPremium?.endDate && jobformPremium.tier !== 'Diamond' && (
                  <span className={`block text-[11px] ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                    Active until {new Date(jobformPremium.endDate).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Dynamic Subscription Status Banner */}
          {currentSubscription?.status === 'ACTIVE' && currentSubscription?.planCodeSnapshot !== 'free-trial' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <FiCheckCircle className="size-4 text-sky-400 shrink-0" />
                <div>
                  <span className="font-semibold text-sky-300">
                    {currentSubscription.planNameSnapshot || 'Active Subscription'} Active
                  </span>
                  <span className="text-[11px] text-gray-300 block">
                    Valid until {new Date(currentSubscription.currentPeriodEnd).toLocaleDateString()}
                  </span>
                </div>
              </div>
              {userCredits && (
                <span className="rounded-full bg-sky-500/20 px-2 py-0.5 text-[10px] font-bold text-sky-300 border border-sky-500/30">
                  ⚡ {userCredits.remainingCredits} Credits
                </span>
              )}
            </div>
          ) : currentSubscription?.status === 'EXPIRED' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <FiShield className="size-4 text-amber-400 shrink-0" />
                <div>
                  <span className="font-semibold text-amber-300">Trial / Subscription Expired</span>
                  <span className="text-[11px] text-gray-300 block">Choose a plan to resume auto-applying</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <FiCheckCircle className="size-4 text-emerald-400 shrink-0" />
                <div>
                  <span className="font-semibold text-emerald-300">Free Trial Active</span>
                  <span className="text-[11px] text-gray-300 block">5-day access auto-provisioned</span>
                </div>
              </div>
              {userCredits && (
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300 border border-emerald-500/30">
                  ⚡ {userCredits.remainingCredits} Credits Left
                </span>
              )}
            </div>
          )}
        </div>

        {/* Scrollable Plans List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3.5">
          {errorMessage && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-300">
              {errorMessage}
            </div>
          )}
          {successMessage && (
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 flex items-center gap-2">
              <FiCheck className="size-4 text-emerald-400" />
              <span>{successMessage}</span>
            </div>
          )}

          {plans.map(plan => {
            const isSelected = selectedPlanCode === plan.code;
            const isPopular = plan.popular;
            const isCurrentActivePlan =
              currentSubscription?.status === 'ACTIVE' && currentSubscription?.planCodeSnapshot === plan.code;

            return (
              <div
                key={plan.code}
                onClick={() => setSelectedPlanCode(plan.code as any)}
                className={`relative rounded-xl border p-4 transition-all cursor-pointer ${
                  isCurrentActivePlan
                    ? isDarkMode
                      ? 'border-emerald-500/80 bg-emerald-500/10 shadow-lg shadow-emerald-500/10 ring-1 ring-emerald-500'
                      : 'border-emerald-500 bg-emerald-50/50 shadow-md ring-1 ring-emerald-500'
                    : isSelected
                      ? isDarkMode
                        ? 'border-sky-500 bg-sky-500/10 shadow-lg shadow-sky-500/10 ring-1 ring-sky-500'
                        : 'border-sky-500 bg-sky-50 shadow-md ring-1 ring-sky-500'
                      : isDarkMode
                        ? 'border-slate-800 bg-slate-800/50 hover:border-slate-700'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                }`}>
                {isCurrentActivePlan ? (
                  <span className="absolute -top-2.5 right-4 rounded-full bg-emerald-600 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white shadow-sm flex items-center gap-1">
                    <FiCheck className="size-2.5" /> Current Plan
                  </span>
                ) : isPopular ? (
                  <span className="absolute -top-2.5 right-4 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-white shadow-sm">
                    ⭐ Most Popular
                  </span>
                ) : null}

                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-bold text-sm flex items-center gap-1.5">
                      <span>{plan.name}</span>
                    </h3>
                    <p className="text-[11px] text-gray-400 mt-0.5">{plan.tagline}</p>
                  </div>
                  <div className="text-right">
                    <span className="text-base font-extrabold">{plan.priceFormatted}</span>
                    <span className="text-[10px] text-gray-400 block">/ month</span>
                  </div>
                </div>

                {/* Metrics Pill */}
                <div className="mt-2.5 flex items-center gap-2 text-[10px] font-semibold">
                  <span className="rounded-md border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-sky-300">
                    ⚡ {plan.credits}
                  </span>
                  <span className="rounded-md border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 text-purple-300">
                    🚀 {plan.rateLimit}
                  </span>
                </div>

                {/* Features List */}
                <div className="mt-3 space-y-1.5 border-t border-inherit pt-2.5">
                  {plan.features.map((feat, idx) => (
                    <div key={idx} className="flex items-center gap-2 text-[11px]">
                      <FiCheck className="size-3 text-emerald-400 shrink-0" />
                      <span className="text-gray-300">{feat}</span>
                    </div>
                  ))}
                </div>

                {/* Action Button */}
                <div className="mt-3.5">
                  {isCurrentActivePlan ? (
                    <div className="w-full flex items-center justify-center gap-2 rounded-xl py-2 px-4 text-xs font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 cursor-default">
                      <FiCheckCircle className="size-3.5" />
                      <span>Current Active Plan</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        handleCheckout(plan.code);
                      }}
                      disabled={loadingPlanCode === plan.code}
                      className={`w-full flex items-center justify-center gap-2 rounded-xl py-2 px-4 text-xs font-bold text-white shadow transition-all cursor-pointer ${
                        isPopular
                          ? 'bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-orange-500/20 active:scale-[0.99]'
                          : 'bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-600 hover:to-indigo-700 shadow-sky-500/20 active:scale-[0.99]'
                      } disabled:opacity-50`}>
                      {loadingPlanCode === plan.code ? (
                        <>
                          <AiOutlineLoading3Quarters className="size-3.5 animate-spin" />
                          <span>Initiating Checkout...</span>
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

        {/* Modal Footer / Dismiss */}
        <div className="p-4 pt-3 border-t border-inherit bg-slate-900/60 flex items-center justify-between shrink-0">
          <span className="text-[11px] text-gray-400">Cancel or upgrade anytime.</span>
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-1.5 text-xs font-semibold text-sky-400 hover:bg-slate-700 hover:text-sky-300 transition-colors cursor-pointer">
            <span>
              {currentSubscription?.status === 'ACTIVE' && currentSubscription?.planCodeSnapshot !== 'free-trial'
                ? 'Close & Continue'
                : 'Continue with Free Trial'}
            </span>
            <FiArrowRight className="size-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
