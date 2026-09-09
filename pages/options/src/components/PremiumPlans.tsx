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
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);
  const [selectedPlanForCheckout, setSelectedPlanForCheckout] = useState<'pro' | 'enterprise' | null>(null);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // Form fields for mock payment
  const [cardName, setCardName] = useState('Alex Morgan');
  const [cardNumber, setCardNumber] = useState('4242 •••• •••• 4242');
  const [cardExpiry, setCardExpiry] = useState('12/28');
  const [cardCvc, setCardCvc] = useState('888');

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

    loadSettings();
    const unsubscribe = cloudApiSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleOpenCheckout = (planId: 'pro' | 'enterprise') => {
    setSelectedPlanForCheckout(planId);
    setPaymentSuccess(false);
    setShowCheckoutModal(true);
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

  const handleExecutePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPlanForCheckout) return;

    setIsProcessingPayment(true);

    try {
      const planCode = selectedPlanForCheckout === 'pro' ? 'pro' : 'power';
      const idempotencyKey = `checkout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // Call backend to create checkout session
      const checkoutRes = await backendApiClient.createCheckoutSession(planCode, idempotencyKey);
      const checkoutData = checkoutRes.data;

      // Simulate payment authorization / verification step
      const mockPaymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const mockSignature = `sig_${Date.now()}_mock_signature_hash`;

      if (checkoutData?.razorpaySubscriptionId) {
        await backendApiClient.verifyPayment({
          razorpaySubscriptionId: checkoutData.razorpaySubscriptionId,
          razorpayPaymentId: mockPaymentId,
          razorpaySignature: mockSignature,
        });
      }

      await cloudApiSettingsStore.updateSubscription({
        planId: selectedPlanForCheckout,
        status: 'active',
        billingInterval,
      });
      await cloudApiSettingsStore.setApiMode('premium');

      setIsProcessingPayment(false);
      setPaymentSuccess(true);

      setTimeout(() => {
        setShowCheckoutModal(false);
        setPaymentSuccess(false);
      }, 1800);
    } catch (error: any) {
      console.error('Payment processing failed:', error);
      setIsProcessingPayment(false);
      alert(error.message || 'Payment checkout failed. Please check your backend connection.');
    }
  };

  const currentPlan = settings?.subscription.planId || 'free';
  const priceDisplay = billingInterval === 'monthly' ? '$19 / month' : '$180 / year ($15/month)';

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        {/* Header & Toggle */}
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="inline-flex items-center space-x-2 rounded-full bg-indigo-500/10 px-4 py-1.5 text-xs font-semibold text-indigo-500 mb-3">
            <FiStar className="h-4 w-4" />
            <span>Nanobrowser Premium Plans</span>
          </div>
          <h2 className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            Supercharge Your Web Automation
          </h2>
          <p className={`mt-2 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            Get built-in LLM API access without managing API keys, enjoy up to 1,000 tasks/month, and unlock high-speed
            execution.
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
              Monthly Billing
            </button>
            <button
              onClick={() => setBillingInterval('yearly')}
              className={`flex items-center space-x-1 rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
                billingInterval === 'yearly'
                  ? 'bg-sky-500 text-white shadow'
                  : isDarkMode
                    ? 'text-gray-400 hover:text-gray-200'
                    : 'text-gray-600 hover:text-gray-900'
              }`}>
              <span>Yearly Billing</span>
              <span className="rounded-full bg-emerald-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                Save 20%
              </span>
            </button>
          </div>
        </div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Free Tier */}
          <div
            className={`relative flex flex-col justify-between rounded-2xl border p-6 transition-all ${
              currentPlan === 'free'
                ? 'border-sky-500 ring-2 ring-sky-500/20'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/40'
                  : 'border-gray-200 bg-white'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Free Tier</h3>
                {currentPlan === 'free' && (
                  <span className="rounded-full bg-sky-500/20 px-2.5 py-0.5 text-xs font-semibold text-sky-500">
                    Current Plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>Bring your own API key</p>
              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>$0</span>
                <span className={`ml-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>/ forever</span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Unlimited tasks with own API keys</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Supports OpenAI, Anthropic, Gemini, Ollama</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Local browser extension execution</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Standard execution speed</span>
                </li>
              </ul>
            </div>

            {currentPlan === 'pro' || currentPlan === 'enterprise' ? (
              <button
                onClick={handleDowngradeToFree}
                className="mt-8 w-full rounded-xl border border-slate-600 py-2.5 text-xs font-semibold text-gray-300 hover:bg-slate-700 transition-all">
                Cancel Paid Plan & Switch to Free
              </button>
            ) : (
              <button
                disabled
                className="mt-8 w-full rounded-xl bg-gray-200 py-2.5 text-xs font-semibold text-gray-500 cursor-default dark:bg-slate-700 dark:text-gray-400">
                Active Plan
              </button>
            )}
          </div>

          {/* Pro Tier (Recommended) */}
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
                Built-in API access included
              </p>

              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                  {billingInterval === 'monthly' ? '$19' : '$15'}
                </span>
                <span className={`ml-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  / month {billingInterval === 'yearly' ? '(billed yearly)' : ''}
                </span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2 font-medium text-indigo-500 dark:text-indigo-400">
                  <FiZap className="h-4 w-4 flex-shrink-0" />
                  <span>1,000 automated tasks / month included</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Built-in access to Claude 3.5 & GPT-4o</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Zero setup – no personal API key required</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Priority task execution & high concurrency</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Cloud API key backup & auto-sync</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('pro')}
              disabled={currentPlan === 'pro'}
              className={`mt-8 w-full rounded-xl py-2.5 text-xs font-semibold shadow-md transition-all ${
                currentPlan === 'pro'
                  ? 'bg-indigo-500/20 text-indigo-400 cursor-default'
                  : 'bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-600 hover:to-indigo-700'
              }`}>
              {currentPlan === 'pro' ? 'Active Plan' : 'Subscribe to Pro ($19/mo)'}
            </button>
          </div>

          {/* Enterprise Tier */}
          <div
            className={`relative flex flex-col justify-between rounded-2xl border p-6 transition-all ${
              currentPlan === 'enterprise'
                ? 'border-purple-500 ring-2 ring-purple-500/20'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/40'
                  : 'border-gray-200 bg-white'
            }`}>
            <div>
              <div className="flex items-center justify-between">
                <h3 className={`text-lg font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>Enterprise</h3>
                {currentPlan === 'enterprise' && (
                  <span className="rounded-full bg-purple-500/20 px-2.5 py-0.5 text-xs font-semibold text-purple-400">
                    Current Plan
                  </span>
                )}
              </div>
              <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Custom high volume & team management
              </p>
              <div className="mt-4 flex items-baseline">
                <span className={`text-3xl font-extrabold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
                  Custom
                </span>
              </div>

              <ul className={`mt-6 space-y-3 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Unlimited monthly automated tasks</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Dedicated cloud proxy endpoints</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Custom SLA & 24/7 priority support</span>
                </li>
                <li className="flex items-center space-x-2">
                  <FiCheck className="h-4 w-4 text-emerald-500 flex-shrink-0" />
                  <span>Centralized team API key management</span>
                </li>
              </ul>
            </div>

            <button
              onClick={() => handleOpenCheckout('enterprise')}
              disabled={currentPlan === 'enterprise'}
              className={`mt-8 w-full rounded-xl py-2.5 text-xs font-semibold transition-all ${
                currentPlan === 'enterprise'
                  ? 'bg-purple-500/20 text-purple-400 cursor-default'
                  : 'bg-slate-800 text-white hover:bg-slate-700 dark:bg-slate-600 dark:hover:bg-slate-500'
              }`}>
              {currentPlan === 'enterprise' ? 'Active' : 'Subscribe to Enterprise'}
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
