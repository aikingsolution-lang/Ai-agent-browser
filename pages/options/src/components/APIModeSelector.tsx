import React, { useState, useEffect } from 'react';
import { cloudApiSettingsStore, type CloudApiSettingsConfig, type ApiMode, type CloudConfig } from '@extension/storage';
import {
  cloudApiClient,
  type SecretManagerPayload,
} from '../../../../chrome-extension/src/background/services/cloud-api-client';
import {
  FiKey,
  FiCloud,
  FiCheckCircle,
  FiShield,
  FiCpu,
  FiRefreshCw,
  FiZap,
  FiLock,
  FiStar,
  FiAlertCircle,
  FiServer,
  FiActivity,
} from 'react-icons/fi';

interface APIModeSelectorProps {
  isDarkMode: boolean;
  onNavigateToPremium?: () => void;
}

export const APIModeSelector: React.FC<APIModeSelectorProps> = ({ isDarkMode, onNavigateToPremium }) => {
  const [settings, setSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [cloudConfig, setCloudConfig] = useState<CloudConfig>({
    provider: 'aws',
    region: 'us-east-1',
    awsSecretName: 'nanobrowser-llm-keys',
    gcpSecretId: 'nanobrowser-llm-keys',
  });
  const [isSavingCloud, setIsSavingCloud] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showSubscriptionPrompt, setShowSubscriptionPrompt] = useState(false);

  // Secret Manager test states
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    payload?: SecretManagerPayload;
    error?: string;
  } | null>(null);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await cloudApiSettingsStore.getSettings();
        setSettings(currentSettings);
        if (currentSettings.cloudConfig) {
          setCloudConfig({
            awsSecretName: 'nanobrowser-llm-keys',
            gcpSecretId: 'nanobrowser-llm-keys',
            ...currentSettings.cloudConfig,
          });
        }
      } catch (error) {
        console.error('Failed to load cloud API settings:', error);
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

  const handleModeChange = async (mode: ApiMode) => {
    if (!settings) return;

    if (mode === 'premium') {
      const isSubscribed = settings.subscription.planId === 'pro' || settings.subscription.planId === 'enterprise';
      if (!isSubscribed) {
        setShowSubscriptionPrompt(true);
        return;
      }
    }

    try {
      await cloudApiSettingsStore.setApiMode(mode);
      setSettings({ ...settings, apiMode: mode });
    } catch (error) {
      console.error('Failed to update API mode:', error);
    }
  };

  const handleSaveCloudConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingCloud(true);
    try {
      await cloudApiSettingsStore.updateCloudConfig(cloudConfig);
      await cloudApiClient.syncCloudCredentials(cloudConfig);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (error) {
      console.error('Failed to save cloud credentials:', error);
    } finally {
      setIsSavingCloud(false);
    }
  };

  const handleTestSecretManager = async () => {
    setIsTestingConnection(true);
    setTestResult(null);
    try {
      const res = await cloudApiClient.testSecretManagerConnection(cloudConfig);
      if (res.success && res.data) {
        setTestResult({ success: true, payload: res.data.secretPayload });
      } else {
        setTestResult({ success: false, error: res.error || 'Connection failed' });
      }
    } catch (error) {
      setTestResult({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    } finally {
      setIsTestingConnection(false);
    }
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div
          className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
          <h2 className={`mb-4 text-xl font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            API Mode Selection
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

  const usagePercent = Math.min(100, Math.round((settings.usage.taskCount / (settings.usage.taskLimit || 1000)) * 100));
  const isPaidUser = settings.subscription.planId === 'pro' || settings.subscription.planId === 'enterprise';

  return (
    <section className="space-y-6">
      <div
        className={`rounded-lg border ${isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-blue-100 bg-gray-50'} p-6 text-left shadow-sm`}>
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className={`text-xl font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              API Mode & Cloud Key Management
            </h2>
            <p className={`mt-1 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Choose how Nanobrowser connects to LLM providers: bring your own API key or use built-in Cloud API access.
            </p>
          </div>
          <span
            className={`inline-flex items-center space-x-1 rounded-full px-3 py-1 text-xs font-semibold ${
              settings.apiMode === 'premium'
                ? 'bg-gradient-to-r from-sky-500 to-indigo-500 text-white shadow-md'
                : 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
            }`}>
            <FiZap className="h-3 w-3" />
            <span>{settings.apiMode === 'premium' ? 'Premium Mode' : 'Free Mode'}</span>
          </span>
        </div>

        {/* Mode Selector Cards */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Free Mode Card */}
          <div
            onClick={() => handleModeChange('free')}
            className={`relative cursor-pointer rounded-xl border p-5 transition-all ${
              settings.apiMode === 'free'
                ? 'border-sky-500 bg-sky-500/10 ring-2 ring-sky-500/30'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/50 hover:border-slate-600'
                  : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-3">
                <div
                  className={`rounded-lg p-2.5 ${
                    settings.apiMode === 'free'
                      ? 'bg-sky-500 text-white'
                      : 'bg-gray-200 text-gray-700 dark:bg-slate-600 dark:text-gray-200'
                  }`}>
                  <FiKey className="h-6 w-6" />
                </div>
                <div>
                  <h3 className={`font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                    Free Mode (Use My Own Key)
                  </h3>
                  <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    Direct connection to OpenAI, Anthropic, Gemini, Ollama, etc.
                  </p>
                </div>
              </div>
              {settings.apiMode === 'free' && <FiCheckCircle className="h-5 w-5 text-sky-500" />}
            </div>
            <ul className={`mt-4 space-y-2 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              <li className="flex items-center space-x-2">
                <span className="text-emerald-500">•</span>
                <span>No monthly task limits</span>
              </li>
              <li className="flex items-center space-x-2">
                <span className="text-emerald-500">•</span>
                <span>Keys stored locally in browser storage</span>
              </li>
              <li className="flex items-center space-x-2">
                <span className="text-emerald-500">•</span>
                <span>Optional Cloud storage backup (AWS / GCP)</span>
              </li>
            </ul>
          </div>

          {/* Premium Mode Card */}
          <div
            onClick={() => handleModeChange('premium')}
            className={`relative cursor-pointer rounded-xl border p-5 transition-all ${
              settings.apiMode === 'premium'
                ? 'border-indigo-500 bg-indigo-500/10 ring-2 ring-indigo-500/30'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-700/50 hover:border-slate-600'
                  : 'border-gray-200 bg-white hover:border-gray-300'
            }`}>
            <div className="flex items-start justify-between">
              <div className="flex items-center space-x-3">
                <div
                  className={`rounded-lg p-2.5 ${
                    settings.apiMode === 'premium'
                      ? 'bg-gradient-to-r from-sky-500 to-indigo-500 text-white'
                      : 'bg-gray-200 text-gray-700 dark:bg-slate-600 dark:text-gray-200'
                  }`}>
                  <FiCpu className="h-6 w-6" />
                </div>
                <div>
                  <div className="flex items-center space-x-2">
                    <h3 className={`font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                      Premium Mode (Built-in API)
                    </h3>
                    {!isPaidUser && <FiLock className="h-4 w-4 text-amber-500" title="Subscription required" />}
                  </div>
                  <p className={`text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    Zero setup required — subscribe for built-in high speed API access
                  </p>
                </div>
              </div>
              {settings.apiMode === 'premium' && <FiCheckCircle className="h-5 w-5 text-indigo-500" />}
            </div>
            <ul className={`mt-4 space-y-2 text-xs ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              <li className="flex items-center space-x-2">
                <span className="text-indigo-500">•</span>
                <span>1,000 tasks per month included</span>
              </li>
              <li className="flex items-center space-x-2">
                <span className="text-indigo-500">•</span>
                <span>Instant access to Claude 3.5, GPT-4o, Gemini Pro</span>
              </li>
              <li className="flex items-center space-x-2">
                <span className="text-indigo-500">•</span>
                <span>Backed by AWS Secrets Manager & GCP Secret Manager</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Subscription Gating Banner for Free Users */}
        {!isPaidUser && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <FiAlertCircle className="h-5 w-5 text-amber-500 flex-shrink-0" />
              <div>
                <h4 className={`text-xs font-bold ${isDarkMode ? 'text-amber-300' : 'text-amber-800'}`}>
                  Subscription Required for Premium Mode
                </h4>
                <p className={`text-[11px] ${isDarkMode ? 'text-amber-200/70' : 'text-amber-700'}`}>
                  Subscribe to a Pro plan ($19/mo) to unlock built-in Cloud API access and 1,000 tasks/month.
                </p>
              </div>
            </div>
            {onNavigateToPremium && (
              <button
                onClick={onNavigateToPremium}
                className="inline-flex items-center space-x-1.5 rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:from-sky-600 hover:to-indigo-700 transition-all">
                <FiStar className="h-3.5 w-3.5" />
                <span>View Plans & Subscribe</span>
              </button>
            )}
          </div>
        )}

        {/* Premium Usage Meter */}
        {settings.apiMode === 'premium' && (
          <div
            className={`mt-6 rounded-lg border p-4 ${
              isDarkMode ? 'border-slate-700 bg-slate-700/50' : 'border-indigo-100 bg-indigo-50/50'
            }`}>
            <div className="flex items-center justify-between mb-2">
              <span className={`text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
                Monthly Premium Quota Usage
              </span>
              <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                {settings.usage.taskCount} / {settings.usage.taskLimit || 1000} tasks used ({usagePercent}%)
              </span>
            </div>
            <div className={`h-2.5 w-full rounded-full overflow-hidden ${isDarkMode ? 'bg-slate-600' : 'bg-gray-200'}`}>
              <div
                className="h-full bg-gradient-to-r from-sky-500 to-indigo-500 transition-all duration-300"
                style={{ width: `${usagePercent}%` }}></div>
            </div>
            <p className={`mt-2 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Resets on {new Date(settings.usage.resetTimestamp).toLocaleDateString()}
            </p>
          </div>
        )}

        {/* Cloud Secret Manager & Key Integration Form */}
        <div
          className={`mt-8 rounded-lg border p-6 ${isDarkMode ? 'border-slate-700 bg-slate-700/30' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center space-x-2 mb-4">
            <FiServer className={`h-5 w-5 ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`} />
            <h3 className={`text-base font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
              AWS Secrets Manager & GCP Secret Manager Integration
            </h3>
          </div>
          <p className={`mb-4 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            Configure your enterprise Secret Manager vault for retrieving and rotating built-in LLM API keys securely.
          </p>

          <form onSubmit={handleSaveCloudConfig} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={`block text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'} mb-1`}>
                  Cloud Secret Provider
                </label>
                <select
                  value={cloudConfig.provider}
                  onChange={e => setCloudConfig({ ...cloudConfig, provider: e.target.value as 'aws' | 'gcp' })}
                  className={`w-full rounded-md border p-2 text-sm ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-800 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}>
                  <option value="aws">AWS Secrets Manager (KMS Encrypted)</option>
                  <option value="gcp">Google Cloud Secret Manager</option>
                </select>
              </div>

              <div>
                <label className={`block text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'} mb-1`}>
                  {cloudConfig.provider === 'aws' ? 'AWS Region' : 'GCP Project ID'}
                </label>
                <input
                  type="text"
                  value={cloudConfig.provider === 'aws' ? cloudConfig.region || '' : cloudConfig.projectId || ''}
                  onChange={e =>
                    cloudConfig.provider === 'aws'
                      ? setCloudConfig({ ...cloudConfig, region: e.target.value })
                      : setCloudConfig({ ...cloudConfig, projectId: e.target.value })
                  }
                  placeholder={cloudConfig.provider === 'aws' ? 'us-east-1' : 'my-gcp-project-id'}
                  className={`w-full rounded-md border p-2 text-sm ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-800 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className={`block text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'} mb-1`}>
                  {cloudConfig.provider === 'aws' ? 'AWS Secret Name / ARN' : 'GCP Secret ID'}
                </label>
                <input
                  type="text"
                  value={
                    cloudConfig.provider === 'aws' ? cloudConfig.awsSecretName || '' : cloudConfig.gcpSecretId || ''
                  }
                  onChange={e =>
                    cloudConfig.provider === 'aws'
                      ? setCloudConfig({ ...cloudConfig, awsSecretName: e.target.value })
                      : setCloudConfig({ ...cloudConfig, gcpSecretId: e.target.value })
                  }
                  placeholder={cloudConfig.provider === 'aws' ? 'nanobrowser-llm-keys' : 'nanobrowser-llm-keys'}
                  className={`w-full rounded-md border p-2 text-sm ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-800 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
              </div>

              <div>
                <label className={`block text-xs font-medium ${isDarkMode ? 'text-gray-300' : 'text-gray-700'} mb-1`}>
                  Cloud Storage Bucket / Vault
                </label>
                <input
                  type="text"
                  value={cloudConfig.bucketName || ''}
                  onChange={e => setCloudConfig({ ...cloudConfig, bucketName: e.target.value })}
                  placeholder="nanobrowser-secret-vault"
                  className={`w-full rounded-md border p-2 text-sm ${
                    isDarkMode
                      ? 'border-slate-600 bg-slate-800 text-gray-200'
                      : 'border-gray-300 bg-white text-gray-800'
                  }`}
                />
              </div>
            </div>

            {/* Test Connection Result Box */}
            {testResult && (
              <div
                className={`rounded-xl border p-4 text-xs ${
                  testResult.success
                    ? isDarkMode
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : isDarkMode
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-red-200 bg-red-50 text-red-800'
                }`}>
                {testResult.success && testResult.payload ? (
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2 font-bold text-sm">
                      <FiCheckCircle className="h-4 w-4" />
                      <span>Secret Manager Connected ({testResult.payload.provider.toUpperCase()})</span>
                    </div>
                    <p className="font-mono text-[11px] opacity-80">{testResult.payload.secretIdentifier}</p>
                    <p className="opacity-90">
                      Decrypted Keys: OpenAI, Anthropic, Gemini ({testResult.payload.keysCount} active secret keys)
                    </p>
                  </div>
                ) : (
                  <p className="font-semibold">{testResult.error}</p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleTestSecretManager}
                disabled={isTestingConnection}
                className="inline-flex items-center space-x-2 rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-gray-300 hover:bg-slate-700 transition-colors">
                {isTestingConnection ? (
                  <FiRefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FiActivity className="h-3.5 w-3.5 text-sky-400" />
                )}
                <span>Test Secret Manager Vault</span>
              </button>

              <button
                type="submit"
                disabled={isSavingCloud}
                className="inline-flex items-center space-x-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-medium text-white shadow hover:bg-sky-700 transition-colors">
                {isSavingCloud ? <FiRefreshCw className="h-4 w-4 animate-spin" /> : <FiCloud className="h-4 w-4" />}
                <span>{saveSuccess ? 'Saved & Synced!' : 'Sync Secret Credentials'}</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Subscription Required Modal */}
      {showSubscriptionPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div
            className={`w-full max-w-sm rounded-2xl border p-6 text-center shadow-2xl ${
              isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'
            }`}>
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/20 text-amber-500 mb-3">
              <FiLock className="h-6 w-6" />
            </div>
            <h3 className="text-lg font-bold">Pro Subscription Required</h3>
            <p className="mt-2 text-xs text-gray-400">
              Built-in Cloud API access is a Premium feature. Please subscribe to Pro ($19/mo) to unlock built-in keys
              with 1,000 tasks/month.
            </p>
            <div className="mt-6 flex space-x-3">
              <button
                onClick={() => setShowSubscriptionPrompt(false)}
                className="w-1/2 rounded-xl border border-slate-600 py-2 text-xs font-medium text-gray-300 hover:bg-slate-700">
                Cancel
              </button>
              {onNavigateToPremium && (
                <button
                  onClick={() => {
                    setShowSubscriptionPrompt(false);
                    onNavigateToPremium();
                  }}
                  className="w-1/2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 py-2 text-xs font-bold text-white shadow hover:from-sky-600 hover:to-indigo-700">
                  View Plans
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
