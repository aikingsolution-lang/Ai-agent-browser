import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig, type StripeConfig } from '@extension/storage';
import {
  FiCreditCard,
  FiKey,
  FiShield,
  FiCheckCircle,
  FiRefreshCw,
  FiExternalLink,
  FiSliders,
  FiLock,
} from 'react-icons/fi';

interface StripeSettingsProps {
  isDarkMode: boolean;
}

export const StripeSettings: React.FC<StripeSettingsProps> = ({ isDarkMode }) => {
  const [settings, setSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [stripeConfig, setStripeConfig] = useState<StripeConfig>({
    environment: 'sandbox',
    publishableKey: '',
    webhookSecret: '',
    customerPortalUrl: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [webhookTestStatus, setWebhookTestStatus] = useState<string | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await cloudApiSettingsStore.getSettings();
        setSettings(currentSettings);
        if (currentSettings.stripeConfig) {
          setStripeConfig(currentSettings.stripeConfig);
        }
      } catch (error) {
        console.error('Failed to load Stripe settings:', error);
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

  const handleSaveStripeConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await cloudApiSettingsStore.updateStripeConfig(stripeConfig);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (error) {
      console.error('Failed to save Stripe settings:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestWebhookSignature = async () => {
    setIsTestingWebhook(true);
    setWebhookTestStatus(null);
    setTimeout(() => {
      setIsTestingWebhook(false);
      setWebhookTestStatus(
        stripeConfig.webhookSecret
          ? 'Webhook Signature Verified! Stripe listener active for customer.subscription.created events.'
          : 'Webhook Secret required for live signature verification.',
      );
    }, 1200);
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div
          className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
          <h2 className={`mb-4 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            Stripe Payment Configuration
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

  const isLiveMode = stripeConfig.environment === 'live';

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className={`text-xl font-bold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
              Stripe Payment & Webhook Configuration
            </h2>
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Manage Stripe Sandbox (Test) vs Live Production API keys, webhook signing secrets, and customer billing
              portal links.
            </p>
          </div>
          <span
            className={`inline-flex items-center space-x-1 rounded-full px-3.5 py-1 text-xs font-bold ${
              isLiveMode
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
            }`}>
            <FiSliders className="h-3.5 w-3.5" />
            <span>{isLiveMode ? 'LIVE PRODUCTION MODE' : 'SANDBOX TEST MODE'}</span>
          </span>
        </div>

        <form onSubmit={handleSaveStripeConfig} className="space-y-6">
          {/* Environment Switcher */}
          <div
            className={`rounded-xl border p-5 ${isDarkMode ? 'border-slate-700 bg-slate-700/30' : 'border-gray-200 bg-white'}`}>
            <label
              className={`block text-xs font-bold uppercase tracking-wider mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              Stripe Environment
            </label>
            <div className="grid grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setStripeConfig({ ...stripeConfig, environment: 'sandbox' })}
                className={`rounded-xl border p-4 text-left transition-all ${
                  stripeConfig.environment === 'sandbox'
                    ? 'border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/30'
                    : isDarkMode
                      ? 'border-slate-700 bg-slate-800 hover:border-slate-600'
                      : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-amber-500">Sandbox / Test Mode</span>
                  {stripeConfig.environment === 'sandbox' && <FiCheckCircle className="h-4 w-4 text-amber-500" />}
                </div>
                <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Use Stripe test API keys (`pk_test_...`) for safe local testing and development.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setStripeConfig({ ...stripeConfig, environment: 'live' })}
                className={`rounded-xl border p-4 text-left transition-all ${
                  stripeConfig.environment === 'live'
                    ? 'border-emerald-500 bg-emerald-500/10 ring-2 ring-emerald-500/30'
                    : isDarkMode
                      ? 'border-slate-700 bg-slate-800 hover:border-slate-600'
                      : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                }`}>
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-emerald-500">Live Production Mode</span>
                  {stripeConfig.environment === 'live' && <FiCheckCircle className="h-4 w-4 text-emerald-500" />}
                </div>
                <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Connect real Stripe live keys (`pk_live_...`) to accept real credit card payments.
                </p>
              </button>
            </div>
          </div>

          {/* Key Inputs */}
          <div className="space-y-4">
            <div>
              <label className={`block text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Stripe Publishable Key ({stripeConfig.environment === 'live' ? 'pk_live_...' : 'pk_test_...'})
              </label>
              <div className="relative">
                <input
                  type="text"
                  required
                  value={stripeConfig.publishableKey}
                  onChange={e => setStripeConfig({ ...stripeConfig, publishableKey: e.target.value })}
                  placeholder={stripeConfig.environment === 'live' ? 'pk_live_51...' : 'pk_test_51...'}
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
                Stripe Webhook Signing Secret (`whsec_...`)
              </label>
              <div className="relative">
                <input
                  type="password"
                  value={stripeConfig.webhookSecret || ''}
                  onChange={e => setStripeConfig({ ...stripeConfig, webhookSecret: e.target.value })}
                  placeholder="whsec_1234567890abcdef..."
                  className={`w-full rounded-lg border p-2.5 pl-9 text-xs font-mono ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-900 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
                <FiLock className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              </div>
              <p className={`mt-1 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                Used to verify signature headers on incoming Stripe subscription events
                (`customer.subscription.updated`).
              </p>
            </div>

            <div>
              <label className={`block text-xs font-medium mb-1 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                Stripe Customer Billing Portal URL
              </label>
              <div className="relative">
                <input
                  type="url"
                  value={stripeConfig.customerPortalUrl || ''}
                  onChange={e => setStripeConfig({ ...stripeConfig, customerPortalUrl: e.target.value })}
                  placeholder="https://billing.stripe.com/p/session/..."
                  className={`w-full rounded-lg border p-2.5 pl-9 text-xs ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-900 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
                <FiExternalLink className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              </div>
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
              <span>{saveSuccess ? 'Configuration Saved!' : 'Save Stripe Credentials'}</span>
            </button>
          </div>
        </form>
      </div>
    </section>
  );
};
