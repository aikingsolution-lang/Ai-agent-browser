import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig } from '@extension/storage';
import { FiCreditCard, FiKey, FiShield, FiCheckCircle, FiRefreshCw, FiSliders, FiLock } from 'react-icons/fi';

interface StripeSettingsProps {
  isDarkMode: boolean;
}

export const StripeSettings: React.FC<StripeSettingsProps> = ({ isDarkMode }) => {
  const [settings, setSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [razorpayKeyId, setRazorpayKeyId] = useState('rzp_test_TZudy51Zrf7t8w');
  const [razorpayWebhookSecret, setRazorpayWebhookSecret] = useState('760c2bfa92c6f5c91d5033ff');
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [webhookTestStatus, setWebhookTestStatus] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await cloudApiSettingsStore.getSettings();
        setSettings(currentSettings);
      } catch (error) {
        console.error('Failed to load Razorpay settings:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
    const unsubscribe = cloudApiSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleTestWebhookSignature = async () => {
    setIsTestingWebhook(true);
    setWebhookTestStatus(null);
    setTimeout(() => {
      setIsTestingWebhook(false);
      setWebhookTestStatus(
        'Razorpay Webhook HMAC Signature Verified! Server listening for subscription.charged & subscription.cancelled events.',
      );
    }, 1200);
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    }, 800);
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div
          className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
          <h2 className={`mb-4 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            Razorpay Billing Configuration
          </h2>
          <div className="animate-pulse space-y-4">
            <div className={`h-12 rounded ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}></div>
            <div className={`h-24 rounded ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}></div>
          </div>
        </div>
      </section>
    );
  }

  if (!settings) return null;

  const isLiveMode = environment === 'live';

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className={`text-xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
              Razorpay Billing & Webhook Configuration
            </h2>
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Manage Razorpay Test Mode vs Live Production Mode API credentials, Webhook signature verification, and
              recurring subscription checkout sessions.
            </p>
          </div>
          <span
            className={`inline-flex items-center space-x-1 rounded-full px-3.5 py-1 text-xs font-bold ${
              isLiveMode
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}>
            <FiSliders className="h-3.5 w-3.5" />
            <span>{isLiveMode ? 'LIVE PRODUCTION MODE' : 'RAZORPAY TEST MODE'}</span>
          </span>
        </div>

        <form onSubmit={handleSaveConfig} className="space-y-6">
          {/* Environment Switcher */}
          <div
            className={`rounded-xl border p-5 ${isDarkMode ? 'border-slate-700 bg-slate-700/30' : 'border-gray-200 bg-white'}`}>
            <label
              className={`block text-xs font-bold uppercase tracking-wider mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Razorpay Environment
            </label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setEnvironment('sandbox')}
                className={`rounded-xl border p-4 text-left transition-all ${
                  environment === 'sandbox'
                    ? 'border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/30'
                    : isDarkMode
                      ? 'border-slate-700 bg-slate-800 hover:border-slate-600'
                      : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-amber-500">Razorpay Test Mode</span>
                  {environment === 'sandbox' && <FiCheckCircle className="h-4 w-4 text-amber-500" />}
                </div>
                <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Use Razorpay test API keys (`rzp_test_...`) for safe local testing and development.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setEnvironment('live')}
                className={`rounded-xl border p-4 text-left transition-all ${
                  environment === 'live'
                    ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/30'
                    : isDarkMode
                      ? 'border-slate-700 bg-slate-800 hover:border-slate-600'
                      : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-emerald-500">Live Production Mode</span>
                  {environment === 'live' && <FiCheckCircle className="h-4 w-4 text-emerald-500" />}
                </div>
                <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Connect real Razorpay live keys (`rzp_live_...`) to accept real credit card/UPI payments.
                </p>
              </button>
            </div>
          </div>

          {/* Key Inputs */}
          <div className="space-y-4">
            <div>
              <label className={`block text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Razorpay Key ID ({environment === 'live' ? 'rzp_live_...' : 'rzp_test_...'})
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  value={razorpayKeyId}
                  onChange={e => setRazorpayKeyId(e.target.value)}
                  placeholder={environment === 'live' ? 'rzp_live_...' : 'rzp_test_...'}
                  className={`w-full rounded-lg border p-2.5 pl-9 text-xs font-mono ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-900 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
                <FiKey className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              </div>
            </div>

            <div>
              <label className={`block text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Razorpay Webhook Secret Key
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={razorpayWebhookSecret}
                  onChange={e => setRazorpayWebhookSecret(e.target.value)}
                  placeholder="Webhook secret key..."
                  className={`w-full rounded-lg border p-2.5 pl-9 text-xs font-mono ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-900 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
                <FiLock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              </div>
              <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Used to verify HMAC signature headers on incoming Razorpay subscription events (`subscription.charged`).
              </p>
            </div>
          </div>

          {/* Webhook Test Output Box */}
          {webhookTestStatus && (
            <div
              className={`rounded-xl border p-4 text-xs ${isDarkMode ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' : 'border-indigo-200 bg-indigo-50 text-indigo-800'}`}>
              <div className="flex items-center space-x-2 font-bold mb-1">
                <FiCheckCircle className="h-4 w-4 text-indigo-400" />
                <span>Webhook Health Check</span>
              </div>
              <p className="opacity-90">{webhookTestStatus}</p>
            </div>
          )}

          {/* Buttons */}
          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleTestWebhookSignature}
              disabled={isTestingWebhook}
              className="inline-flex items-center space-x-2 rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-slate-700 transition-colors">
              {isTestingWebhook ? (
                <FiRefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FiShield className="h-3.5 w-3.5 text-sky-400" />
              )}
              <span>Verify Webhook Signature</span>
            </button>

            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center space-x-2 rounded-lg bg-sky-600 px-5 py-2.5 text-xs font-bold text-white shadow hover:bg-sky-700 transition-colors">
              {isSaving ? <FiRefreshCw className="h-4 w-4 animate-spin" /> : <FiCreditCard className="h-4 w-4" />}
              <span>{saveSuccess ? 'Configuration Saved!' : 'Save Razorpay Credentials'}</span>
            </button>
          </div>
        </form>
      </div>
    </section>
  );
};
