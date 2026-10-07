import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig } from '@extension/storage';
import { backendApiClient } from '@extension/shared';
import {
  FiCheck,
  FiZap,
  FiShield,
  FiCpu,
  FiTrendingUp,
  FiCreditCard,
  FiCheckCircle,
  FiLock,
  FiClock,
} from 'react-icons/fi';

interface PremiumPlansProps {
  isDarkMode: boolean;
}

export const PremiumPlans: React.FC<PremiumPlansProps> = ({ isDarkMode }) => {
  const [settings, setSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [livePlans, setLivePlans] = useState<
    Array<{ code: string; name: string; amount: number; creditsPerBillingPeriod: number }>
  >([
    { code: 'starter', name: 'Starter Plan', amount: 49900, creditsPerBillingPeriod: 1000 },
    { code: 'pro', name: 'Pro Automation Plan', amount: 149900, creditsPerBillingPeriod: 5000 },
    { code: 'power', name: 'Power Enterprise Plan', amount: 499900, creditsPerBillingPeriod: 25000 },
  ]);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await cloudApiSettingsStore.getSettings();
        setSettings(currentSettings);
        if (currentSettings.subscription.billingInterval) {
          setBillingInterval(currentSettings.subscription.billingInterval);
        }
      } catch (error) {
        console.error('Failed to load subscription settings:', error);
      }
    };

    const loadLivePlans = async () => {
      try {
        const res = await backendApiClient.getSubscriptionPlans();
        if (res.data?.plans && res.data.plans.length > 0) {
          const paidPlans = res.data.plans.filter((p: any) => p.code !== 'free-trial');
          if (paidPlans.length > 0) {
            setLivePlans(paidPlans);
          }
        }
      } catch (err) {
        console.log('Using default plan pricing fallback:', err);
      }
    };

    loadSettings();
    loadLivePlans();
    const unsubscribe = cloudApiSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleOpenCheckout = async (planCode: 'starter' | 'pro' | 'power') => {
    setIsProcessingPayment(true);
    try {
      const idempotencyKey = `checkout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const res = await backendApiClient.createCheckoutSession(planCode, idempotencyKey);

      if (res.data?.shortUrl) {
        window.open(res.data.shortUrl, '_blank');
      }

      await cloudApiSettingsStore.updateSubscription({
        planId: planCode as any,
        status: 'active',
        billingInterval,
      });
      await cloudApiSettingsStore.setApiMode('premium');
    } catch (error: any) {
      console.error('Failed to create Razorpay checkout session:', error);
      alert(error.message || 'Checkout failed. Please ensure you are logged in and backend is running.');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const currentPlan = (settings?.subscription.planId || 'free') as string;

  const getPlanDetails = (code: string, defaultPrice: number, defaultCredits: number) => {
    const found = livePlans.find(p => p.code === code);
    return {
      price: found ? found.amount / 100 : defaultPrice,
      credits: found ? found.creditsPerBillingPeriod : defaultCredits,
    };
  };

  const starter = getPlanDetails('starter', 499, 1000);
  const pro = getPlanDetails('pro', 1499, 5000);
  const power = getPlanDetails('power', 4999, 25000);

  return (
    <section className="space-y-6">
      <div
        className={`rounded-2xl border p-8 text-left shadow-xs ${
          isDarkMode ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'
        }`}>
        {/* Header & Toggle */}
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <div className="mb-2.5 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800">
            <span>✦</span>
            <span>COMMERCIAL SUBSCRIPTION</span>
          </div>

          <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100 sm:text-3xl">
            Choose Your AI Automation Capacity
          </h2>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            Managed AWS Bedrock LLM proxy access, automatic credit allocation, and seamless LinkedIn/Indeed auto-apply.
          </p>

          {/* Billing Switcher */}
          <div className="mt-6 inline-flex items-center p-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/80">
            <button
              onClick={() => setBillingInterval('monthly')}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                billingInterval === 'monthly'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900'
              }`}>
              Monthly Billing
            </button>
            <button
              onClick={() => setBillingInterval('yearly')}
              className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                billingInterval === 'yearly'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-900'
              }`}>
              <span>Annual Billing</span>
              <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-1.5 py-0.2 rounded-full border border-emerald-200 dark:border-emerald-800">
                Save 20%
              </span>
            </button>
          </div>
        </div>

        {/* Pricing Cards Grid */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* 1. Starter Plan */}
          <div
            className={`relative flex flex-col justify-between rounded-xl border p-6 transition-all ${
              currentPlan === 'starter'
                ? 'border-emerald-500 bg-emerald-50/20 dark:bg-emerald-950/20 ring-1 ring-emerald-500'
                : isDarkMode
                  ? 'border-slate-800 bg-slate-900/60'
                  : 'border-slate-200 bg-white shadow-xs'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Starter</h3>
                {currentPlan === 'starter' && (
                  <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                    Active Plan
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Ideal for active job seekers & daily applications
              </p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-slate-900 dark:text-slate-100">₹{starter.price}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">/ month</span>
              </div>

              <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
                  <FiZap className="size-3 text-indigo-500" />
                  <span>{starter.credits.toLocaleString()} Credits / mo</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
                  <FiClock className="size-3 text-slate-400" />
                  <span>120 req/min</span>
                </span>
              </div>

              <ul className="mt-6 space-y-3 text-xs text-slate-600 dark:text-slate-300 border-t border-slate-100 dark:border-slate-800 pt-4">
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Autonomous LinkedIn, Indeed & Naukri apply</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Smart AI CareerBrain profile parser</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Screening question auto-solver</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Standard email & community support</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('starter')}
              disabled={isProcessingPayment || currentPlan === 'starter'}
              className="mt-8 w-full cursor-pointer rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 shadow-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50">
              {currentPlan === 'starter' ? 'Current Active Plan' : 'Select Starter Plan'}
            </button>
          </div>

          {/* 2. Pro Automation Plan (Recommended CTA) */}
          <div
            className={`relative flex flex-col justify-between rounded-xl border p-6 transition-all ${
              currentPlan === 'pro'
                ? 'border-emerald-500 bg-emerald-50/20 dark:bg-emerald-950/20 ring-1 ring-emerald-500'
                : isDarkMode
                  ? 'border-blue-500/80 bg-blue-950/10 shadow-xs ring-1 ring-blue-500/50'
                  : 'border-blue-600 bg-blue-50/20 shadow-xs ring-1 ring-blue-600'
            }`}>
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-0.5 text-[10px] font-semibold text-white shadow-xs">
              ✦ RECOMMENDED
            </span>

            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Pro Automation</h3>
                {currentPlan === 'pro' && (
                  <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                    Active Plan
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                High-volume applications & multiple target roles
              </p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-slate-900 dark:text-slate-100">₹{pro.price}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">/ month</span>
              </div>

              <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                <span className="inline-flex items-center gap-1 rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 text-blue-700 dark:text-blue-300">
                  <FiZap className="size-3 text-indigo-500" />
                  <span>{pro.credits.toLocaleString()} Credits / mo</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
                  <FiClock className="size-3 text-slate-400" />
                  <span>300 req/min</span>
                </span>
              </div>

              <ul className="mt-6 space-y-3 text-xs text-slate-600 dark:text-slate-300 border-t border-slate-100 dark:border-slate-800 pt-4">
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>All AI Models: Claude 3.5 Sonnet & Nova</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Priority screening question solver</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Deep keyword matching & JD analysis</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Batch multi-job background processing</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Priority chat & email support</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('pro')}
              disabled={isProcessingPayment || currentPlan === 'pro'}
              className="mt-8 w-full cursor-pointer rounded-lg bg-blue-600 py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-blue-700 disabled:opacity-50">
              {currentPlan === 'pro' ? 'Current Active Plan' : 'Upgrade to Pro Plan'}
            </button>
          </div>

          {/* 3. Power Enterprise Plan */}
          <div
            className={`relative flex flex-col justify-between rounded-xl border p-6 transition-all ${
              currentPlan === 'power'
                ? 'border-emerald-500 bg-emerald-50/20 dark:bg-emerald-950/20 ring-1 ring-emerald-500'
                : isDarkMode
                  ? 'border-slate-800 bg-slate-900/60'
                  : 'border-slate-200 bg-white shadow-xs'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Power Enterprise</h3>
                {currentPlan === 'power' && (
                  <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/50 px-2.5 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                    Active Plan
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Ultra-fast throughput for power job seekers & teams
              </p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-3xl font-bold text-slate-900 dark:text-slate-100">₹{power.price}</span>
                <span className="text-xs text-slate-500 dark:text-slate-400">/ month</span>
              </div>

              <div className="mt-4 flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300">
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
                  <FiZap className="size-3 text-indigo-500" />
                  <span>{power.credits.toLocaleString()} Credits / mo</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5">
                  <FiClock className="size-3 text-slate-400" />
                  <span>600 req/min</span>
                </span>
              </div>

              <ul className="mt-6 space-y-3 text-xs text-slate-600 dark:text-slate-300 border-t border-slate-100 dark:border-slate-800 pt-4">
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Unlimited concurrent background apply loops</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Custom screening answers & rules engine</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Instant credit top-ups without cooldowns</span>
                </li>
                <li className="flex items-center gap-2">
                  <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                  <span>Dedicated 24/7 priority SLA support</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('power')}
              disabled={isProcessingPayment || currentPlan === 'power'}
              className="mt-8 w-full cursor-pointer rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 py-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 shadow-xs transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50">
              {currentPlan === 'power' ? 'Current Active Plan' : 'Select Power Plan'}
            </button>
          </div>
        </div>

        {/* Reassurance & Value Props Footer */}
        <div className="mt-12 grid grid-cols-1 gap-4 border-t border-slate-100 dark:border-slate-800 pt-6 md:grid-cols-3">
          <div className="flex items-center gap-3">
            <FiShield className="size-5 shrink-0 text-blue-600 dark:text-blue-500" />
            <div>
              <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Secure Razorpay Checkout</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                256-bit encrypted transactions via UPI, Cards, NetBanking
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FiCpu className="size-5 shrink-0 text-indigo-500" />
            <div>
              <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Direct Managed AI</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Zero API keys setup required — powered by cloud runtime
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <FiTrendingUp className="size-5 shrink-0 text-emerald-600 dark:text-emerald-500" />
            <div>
              <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">Cancel or Switch Anytime</h4>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                No locked-in contracts. Upgrade, downgrade, or pause anytime
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
