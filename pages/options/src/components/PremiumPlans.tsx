import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig } from '@extension/storage';
import { backendApiClient } from '@extension/shared';
import {
  FiCheck,
  FiZap,
  FiStar,
  FiShield,
  FiCpu,
  FiTrendingUp,
  FiCreditCard,
  FiX,
  FiCheckCircle,
  FiLock,
  FiRefreshCw,
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
    { code: 'pro', name: 'Pro Plan', amount: 149900, creditsPerBillingPeriod: 5000 },
    { code: 'power', name: 'Power Plan', amount: 499900, creditsPerBillingPeriod: 25000 },
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
        alert(
          `Razorpay checkout initiated! Opening payment page for ${res.data.planName || planCode.toUpperCase()} plan.`,
        );
      } else {
        alert(
          `Checkout session created for plan ${planCode.toUpperCase()}! (Subscription ID: ${res.data?.subscriptionId})`,
        );
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

  const handleDowngradeToFree = async () => {
    try {
      await backendApiClient.cancelSubscription();
      await cloudApiSettingsStore.updateSubscription({
        planId: 'free',
        status: 'cancelled',
        billingInterval,
      });
      await cloudApiSettingsStore.setApiMode('free');
    } catch (error) {
      console.error('Failed to cancel/downgrade subscription:', error);
    }
  };

  const currentPlan = settings?.subscription.planId || 'free';

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
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        {/* Header & Toggle */}
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="inline-flex items-center space-x-2 rounded-full bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold text-indigo-500 mb-3">
            <FiStar className="h-4 w-4" />
            <span>NanoBrowser Premium Commercial Plans</span>
          </div>
          <h2 className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            Supercharge Your AI Web Automation
          </h2>
          <p className={`mt-2 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            Built-in AWS Bedrock Nova LLM proxy access, automated credit allocation, and secure Razorpay payment
            processing.
          </p>

          {/* Billing Switcher */}
          <div className="mt-6 inline-flex items-center rounded-full p-1 border border-slate-700/30 bg-slate-900/20 backdrop-blur-sm">
            <button
              onClick={() => setBillingInterval('monthly')}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
                billingInterval === 'monthly'
                  ? 'bg-sky-500 text-white shadow'
                  : isDarkMode
                    ? 'text-gray-400 hover:text-gray-200'
                    : 'text-gray-600 hover:text-gray-900'
              }`}>
              Monthly Billing (INR)
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Starter Plan */}
          <div
            className={`relative flex flex-col justify-between rounded-2xl border p-6 transition-all ${
              currentPlan === 'starter'
                ? 'border-sky-500 ring-2 ring-sky-500/20'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/40'
                  : 'border-gray-200 bg-white'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Starter Plan</h3>
                {currentPlan === 'starter' && (
                  <span className="rounded-full bg-sky-500/20 px-2.5 py-0.5 text-xs font-semibold text-sky-500">
                    Current Plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Ideal for individual automation
              </p>
              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                  ₹{starter.price}
                </span>
                <span className={`ml-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>/ month</span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2 font-medium text-sky-500">
                  <FiZap className="h-4 w-4 flex-shrink-0" />
                  <span>{starter.credits.toLocaleString()} AI Credits / month included</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>AWS Bedrock Nova Lite (`amazon.nova-lite-v1:0`)</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>120 tasks / minute rate limit</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Razorpay Instant Checkout</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('starter')}
              disabled={isProcessingPayment || currentPlan === 'starter'}
              className="mt-8 w-full rounded-xl bg-sky-600 py-2.5 text-xs font-semibold text-white hover:bg-sky-500 transition-all shadow-md disabled:opacity-50 cursor-pointer">
              {currentPlan === 'starter' ? 'Active Plan' : `Subscribe to Starter (₹${starter.price}/mo)`}
            </button>
          </div>

          {/* Pro Plan (Recommended) */}
          <div
            className={`relative flex flex-col justify-between rounded-2xl border p-6 shadow-xl transition-all ${
              currentPlan === 'pro'
                ? 'border-indigo-500 bg-indigo-500/10 ring-2 ring-indigo-500/30'
                : isDarkMode
                  ? 'border-indigo-500/50 bg-slate-800/80'
                  : 'border-indigo-200 bg-gradient-to-b from-indigo-50/50 to-white'
            }`}>
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 px-3 py-0.5 text-[11px] font-bold text-white shadow-md">
              MOST POPULAR
            </div>

            <div>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>Pro Plan</h3>
                {currentPlan === 'pro' && (
                  <span className="rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-xs font-semibold text-indigo-400">
                    Current Plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                High-volume power users
              </p>

              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                  ₹{pro.price.toLocaleString()}
                </span>
                <span className={`ml-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>/ month</span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2 font-medium text-indigo-500 dark:text-indigo-400">
                  <FiZap className="h-4 w-4 flex-shrink-0" />
                  <span>{pro.credits.toLocaleString()} AI Credits / month included</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>AWS Bedrock Nova Lite & Pro Models</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>300 tasks / minute rate limit</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Priority task execution & SSE streaming</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('pro')}
              disabled={isProcessingPayment || currentPlan === 'pro'}
              className={`mt-8 w-full rounded-xl py-2.5 text-xs font-semibold shadow-md transition-all cursor-pointer ${
                currentPlan === 'pro'
                  ? 'bg-indigo-500/20 text-indigo-400 cursor-default'
                  : 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-600 hover:to-indigo-700'
              }`}>
              {currentPlan === 'pro' ? 'Active Plan' : `Subscribe to Pro (₹${pro.price.toLocaleString()}/mo)`}
            </button>
          </div>

          {/* Power Plan */}
          <div
            className={`relative flex flex-col justify-between rounded-2xl border p-6 transition-all ${
              currentPlan === 'power'
                ? 'border-purple-500 ring-2 ring-purple-500/20'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/40'
                  : 'border-gray-200 bg-white'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Power Plan</h3>
                {currentPlan === 'power' && (
                  <span className="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-xs font-semibold text-purple-400">
                    Current Plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Maximum performance & credits
              </p>
              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                  ₹{power.price.toLocaleString()}
                </span>
                <span className={`ml-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>/ month</span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2 font-medium text-purple-400">
                  <FiZap className="h-4 w-4 flex-shrink-0" />
                  <span>{power.credits.toLocaleString()} AI Credits / month included</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>600 tasks / minute rate limit</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Dedicated priority concurrency pool</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('power')}
              disabled={isProcessingPayment || currentPlan === 'power'}
              className="mt-8 w-full rounded-xl bg-purple-600 hover:bg-purple-500 py-2.5 text-xs font-semibold text-white transition-all shadow-md cursor-pointer">
              {currentPlan === 'power' ? 'Active Plan' : `Subscribe to Power (₹${power.price.toLocaleString()}/mo)`}
            </button>
          </div>
        </div>

        {/* Value Proposition Highlights */}
        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3 pt-6 border-t border-slate-700/30">
          <div className="flex items-center space-x-3">
            <FiShield className="h-6 w-6 text-sky-500 flex-shrink-0" />
            <div>
              <h4 className={`text-xs font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                Monetization & Revenue
              </h4>
              <p className={`text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Sustainable funding for continuous agent features
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <FiCpu className="h-6 w-6 text-indigo-500 flex-shrink-0" />
            <div>
              <h4 className={`text-xs font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                User Convenience
              </h4>
              <p className={`text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                No complex API key creation or setup required
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <FiTrendingUp className="h-6 w-6 text-emerald-500 flex-shrink-0" />
            <div>
              <h4 className={`text-xs font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                Ultimate Flexibility
              </h4>
              <p className={`text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Switch between your keys or built-in API anytime
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Stripe Payment Checkout Modal */}
      {showCheckoutModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-md rounded-2xl border p-6 shadow-2xl transition-all ${
              isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'
            }`}>
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-700/30">
              <div className="flex items-center space-x-2">
                <FiCreditCard className="h-5 w-5 text-indigo-500" />
                <h3 className="font-bold text-lg">Secure Stripe Checkout</h3>
              </div>
              <button
                onClick={() => setShowCheckoutModal(false)}
                disabled={isProcessingPayment}
                className="rounded-full p-1 text-gray-400 hover:bg-slate-700 hover:text-white transition-colors">
                <FiX className="h-5 w-5" />
              </button>
            </div>

            {paymentSuccess ? (
              <div className="py-8 text-center space-y-4">
                <FiCheckCircle className="mx-auto h-16 w-16 text-emerald-500 animate-bounce" />
                <h4 className="text-xl font-bold text-emerald-500">Payment Successful!</h4>
                <p className="text-xs text-gray-400">
                  Your Pro Plan is now active with 1,000 tasks/month and built-in Cloud API access.
                </p>
              </div>
            ) : (
              <form onSubmit={handleExecutePayment} className="mt-4 space-y-4">
                <div
                  className={`rounded-xl p-3 text-xs border ${isDarkMode ? 'border-indigo-500/30 bg-indigo-500/10' : 'border-indigo-100 bg-indigo-50'}`}>
                  <div className="flex justify-between font-semibold">
                    <span>Plan Selected: {selectedPlanForCheckout?.toUpperCase()}</span>
                    <span className="text-indigo-500">{priceDisplay}</span>
                  </div>
                  <p className="mt-1 text-[11px] text-gray-400">
                    Includes 1,000 automated tasks / month & Cloud API access
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">Cardholder Name</label>
                  <input
                    type="text"
                    required
                    value={cardName}
                    onChange={e => setCardName(e.target.value)}
                    className={`w-full rounded-lg border p-2.5 text-xs ${
                      isDarkMode
                        ? 'border-slate-600 bg-slate-900 text-gray-200'
                        : 'border-gray-300 bg-gray-50 text-gray-800'
                    }`}
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">Card Number</label>
                  <div className="relative">
                    <input
                      type="text"
                      required
                      value={cardNumber}
                      onChange={e => setCardNumber(e.target.value)}
                      className={`w-full rounded-lg border p-2.5 pl-9 text-xs font-mono ${
                        isDarkMode
                          ? 'border-slate-600 bg-slate-900 text-gray-200'
                          : 'border-gray-300 bg-gray-50 text-gray-800'
                      }`}
                    />
                    <FiCreditCard className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">Expiry Date</label>
                    <input
                      type="text"
                      required
                      value={cardExpiry}
                      onChange={e => setCardExpiry(e.target.value)}
                      placeholder="MM/YY"
                      className={`w-full rounded-lg border p-2.5 text-xs font-mono ${
                        isDarkMode
                          ? 'border-slate-600 bg-slate-900 text-gray-200'
                          : 'border-gray-300 bg-gray-50 text-gray-800'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">CVC / CVV</label>
                    <input
                      type="password"
                      required
                      maxLength={4}
                      value={cardCvc}
                      onChange={e => setCardCvc(e.target.value)}
                      placeholder="123"
                      className={`w-full rounded-lg border p-2.5 text-xs font-mono ${
                        isDarkMode
                          ? 'border-slate-600 bg-slate-900 text-gray-200'
                          : 'border-gray-300 bg-gray-50 text-gray-800'
                      }`}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-gray-400 pt-2">
                  <span className="flex items-center space-x-1">
                    <FiLock className="h-3 w-3 text-emerald-500" />
                    <span>256-Bit SSL Encrypted</span>
                  </span>
                  <span>Powered by Stripe</span>
                </div>

                <button
                  type="submit"
                  disabled={isProcessingPayment}
                  className="mt-4 flex w-full items-center justify-center space-x-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 py-3 text-xs font-bold text-white shadow-lg hover:from-sky-600 hover:to-indigo-700 transition-all disabled:opacity-50">
                  {isProcessingPayment ? (
                    <>
                      <FiRefreshCw className="h-4 w-4 animate-spin" />
                      <span>Processing Stripe Payment...</span>
                    </>
                  ) : (
                    <>
                      <FiLock className="h-4 w-4" />
                      <span>Pay & Activate Pro Subscription</span>
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
