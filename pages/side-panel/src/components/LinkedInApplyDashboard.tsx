import { useState, useEffect, useCallback, useRef } from 'react';
import {
  dailyQuotaStore,
  processedJobsStore,
  exportApplicationsToCsv,
  detectPlatformFromUrl,
  type DailyQuotaData,
  authStorage,
  type UserSessionData,
  queueSafetyStore,
  linkedInConfigStore,
  type ILinkedInAutomationConfig,
  DEFAULT_LINKEDIN_CONFIG,
  careerBrainStore,
  getQuotaDisplay,
  sessionUserId,
  type QuotaDisplay,
} from '@extension/storage';
import {
  backendApiClient,
  isPremiumActive,
  openJobformPricing,
  refreshAccountQuota,
  type QuotaRefreshResult,
} from '@extension/shared';
import {
  FiRefreshCw,
  FiPlay,
  FiSquare,
  FiCheckCircle,
  FiAlertTriangle,
  FiExternalLink,
  FiZap,
  FiHelpCircle,
  FiDownload,
  FiLock,
  FiPauseCircle,
  FiSliders,
  FiChevronDown,
  FiChevronUp,
} from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';

export interface PendingQuestionData {
  questionId: string;
  questionText: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  skillName?: string;
}

export interface BatchQuestionItemData {
  id: string;
  fieldIndex?: number;
  questionText: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  skillName?: string;
  required?: boolean;
}

export interface PendingBatchData {
  batchId: string;
  questions: BatchQuestionItemData[];
}

export interface StructuredActivityItem {
  id: string;
  jobId?: string;
  url?: string;
  title?: string;
  company?: string;
  status: 'applied' | 'skipped' | 'failed' | 'running' | 'modal_opened' | 'modal_failed' | 'needs_verification';
  reason?: string;
  creditsUsed?: number;
  timestamp: number;
}

export interface AutoEmailJob {
  id: string;
  title: string;
  company: string;
  location: string;
  category: string;
  email: string | null;
}

export interface AutoEmailProgress {
  type: 'SCRAPING' | 'EXTRACTING' | 'PROGRESS' | 'COMPLETE' | 'ERROR';
  message: string;
  jobsFound?: number;
  company?: string;
  remaining?: number;
  results?: AutoEmailJob[];
}

/** Display names for the plan codes returned by the backend quota. */
const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  'free-trial': 'Free',
  premium: 'Premium',
  diamond: 'Diamond',
  starter: 'Starter',
  pro: 'Pro',
  power: 'Power',
};

/** Plans with no higher plan to move to, so no upgrade action is offered. */
const TOP_PLANS = new Set(['premium', 'diamond', 'power']);

/** "Resets 5:30 AM" / "Resets tomorrow, 5:30 AM" (local time of the next UTC midnight). */
function formatQuotaReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const reset = new Date(resetsAt);
  const time = reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return reset.toDateString() === new Date().toDateString() ? `Resets ${time}` : `Resets tomorrow, ${time}`;
}

type QuotaFetchState = 'checking' | 'done' | 'failed';

/** Today's applications for the signed-in account, as verified by the backend. */
function DailyQuotaCard({
  view,
  fetchState,
  isDarkMode,
  onRetry,
  onUpgrade,
}: {
  view: QuotaDisplay;
  fetchState: QuotaFetchState;
  isDarkMode: boolean;
  onRetry: () => void;
  onUpgrade?: () => void;
}) {
  const shell = `rounded-xl border px-3 py-2.5 text-xs ${
    isDarkMode ? 'border-sky-900 bg-slate-800/60' : 'border-sky-100 bg-white/80 shadow-sm'
  }`;
  const caption = `text-[11px] font-medium whitespace-nowrap ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`;

  if (view.status !== 'ready') {
    const failed = fetchState === 'failed';
    return (
      <div className={`${shell} flex items-center justify-between gap-2`} aria-live="polite">
        <div className="min-w-0">
          <p className={caption}>Daily applications</p>
          <p
            className={`font-semibold ${failed ? 'text-amber-500' : isDarkMode ? 'text-slate-200' : 'text-slate-700'}`}>
            {failed ? 'Unable to load usage' : 'Checking plan…'}
          </p>
        </div>
        {failed ? (
          <button
            type="button"
            onClick={onRetry}
            className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold cursor-pointer ${
              isDarkMode
                ? 'border-slate-600 text-slate-200 hover:bg-slate-700'
                : 'border-slate-300 text-slate-700 hover:bg-slate-100'
            }`}>
            <FiRefreshCw className="size-3" />
            <span>Retry</span>
          </button>
        ) : (
          <AiOutlineLoading3Quarters className="size-3.5 shrink-0 animate-spin opacity-60" aria-hidden="true" />
        )}
      </div>
    );
  }

  const label = PLAN_LABELS[view.plan] ?? (view.isPaid ? 'Paid' : 'Free');
  const percent = Math.round((view.used / view.limit) * 100);
  const reset = formatQuotaReset(view.resetsAt);
  return (
    <div className={shell}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={caption}>Daily applications</span>
          <span
            className={`whitespace-nowrap rounded px-1.5 text-[9px] font-bold uppercase tracking-wider border ${
              view.isPaid
                ? isDarkMode
                  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                  : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : isDarkMode
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
            {view.isPaid ? `${label} Active` : label}
          </span>
        </div>
        {!TOP_PLANS.has(view.plan) && onUpgrade && (
          <button
            type="button"
            onClick={onUpgrade}
            className="shrink-0 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 px-2.5 py-0.5 text-[10px] font-bold text-white hover:from-amber-600 hover:to-orange-600 cursor-pointer">
            Upgrade
          </button>
        )}
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className={`text-sm font-bold ${isDarkMode ? 'text-sky-300' : 'text-sky-700'}`}>
          {view.used} / {view.limit}{' '}
          <span className={`text-[11px] font-medium ${isDarkMode ? 'text-slate-300' : 'text-slate-600'}`}>used</span>
        </p>
        <p
          className={`text-[11px] font-semibold ${
            view.exhausted ? 'text-amber-500' : isDarkMode ? 'text-emerald-300' : 'text-emerald-700'
          }`}>
          {view.remaining} remaining
        </p>
      </div>
      <div
        className={`mt-1.5 h-1 w-full overflow-hidden rounded-full ${isDarkMode ? 'bg-slate-700' : 'bg-slate-200'}`}
        role="progressbar"
        aria-label="Daily applications used"
        aria-valuemin={0}
        aria-valuemax={view.limit}
        aria-valuenow={view.used}>
        <div
          className={`h-full rounded-full ${view.exhausted ? 'bg-amber-500' : 'bg-sky-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {reset && <p className={`mt-1 text-[10px] ${isDarkMode ? 'text-slate-400' : 'text-slate-500'}`}>{reset}</p>}
    </div>
  );
}

interface LinkedInApplyDashboardProps {
  isDarkMode?: boolean;
  onStartAutoApply?: (platform?: 'linkedin' | 'naukri' | 'indeed') => void;
  onStop: () => void;
  onOpenAuthModal?: () => void;
  onOpenPlansModal?: () => void;
  isApplying: boolean;
  activeStatusText: string;
  appliedLogs: Array<{ id: string; text: string; status: 'ok' | 'fail' | 'info'; timestamp: number }>;
  activityItems?: StructuredActivityItem[];
  pendingQuestion?: PendingQuestionData | null;
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  pendingBatch?: PendingBatchData | null;
  onAnswerQuestionBatch?: (batchId: string, answers: Record<string, string>) => void;
  onStartAutoEmail?: (jobTitle: string) => void;
  onStopAutoEmail?: () => void;
  isAutoEmailRunning?: boolean;
  autoEmailProgress?: AutoEmailProgress | null;
  autoEmailResults?: AutoEmailJob[];
}

export function LinkedInApplyDashboard({
  isDarkMode = false,
  onStartAutoApply,
  onStop,
  onOpenAuthModal,
  onOpenPlansModal,
  isApplying,
  activeStatusText,
  appliedLogs,
  activityItems = [],
  pendingQuestion,
  onAnswerQuestion,
  pendingBatch,
  onAnswerQuestionBatch,
  onStartAutoEmail,
  onStopAutoEmail,
  isAutoEmailRunning = false,
  autoEmailProgress = null,
  autoEmailResults = [],
}: LinkedInApplyDashboardProps) {
  const [selectedPlatform, setSelectedPlatform] = useState<'linkedin' | 'naukri' | 'indeed'>('linkedin');
  const [quota, setQuota] = useState<DailyQuotaData | null>(null);
  const [quotaFetch, setQuotaFetch] = useState<QuotaFetchState>('checking');
  const [session, setSession] = useState<UserSessionData | null>(null);
  // Shown only when verified by the backend for this account and day, and consistent with the
  // verified Premium status (a stale copy cannot show FREE for a Premium account).
  const quotaView = getQuotaDisplay(quota, {
    uid: sessionUserId(session?.user, session?.token),
    premiumActive: session?.premium ? isPremiumActive(session.premium) : undefined,
    premiumCheckedAt: session?.premium?.checkedAt ? Date.parse(session.premium.checkedAt) : undefined,
  });
  const quotaResetLabel = quotaView.status === 'ready' ? formatQuotaReset(quotaView.resetsAt) : null;
  const aiIncluded = isPremiumActive(session?.premium);
  const [platformPauseInfo, setPlatformPauseInfo] = useState<{ isPaused: boolean; reason?: string }>({
    isPaused: false,
  });
  const [automationConfig, setAutomationConfig] = useState<ILinkedInAutomationConfig>(DEFAULT_LINKEDIN_CONFIG);
  const [showEasyApplySettings, setShowEasyApplySettings] = useState(false);
  const [careerBrainInfo, setCareerBrainInfo] = useState<{ currentTitle: string; roles: string[] }>({
    currentTitle: '',
    roles: [],
  });
  // Sync automationConfig and Career Brain info
  useEffect(() => {
    let isMounted = true;
    const syncConfig = async () => {
      try {
        const [cfg, brain] = await Promise.all([linkedInConfigStore.getConfig(), careerBrainStore.getCareerBrain()]);
        if (isMounted) {
          setAutomationConfig(cfg);
          setCareerBrainInfo({
            currentTitle: brain.currentTitle || '',
            roles: Array.isArray(brain.predefinedRoles) ? brain.predefinedRoles : [],
          });
        }
      } catch {}
    };

    syncConfig();
    const unsubConfig = linkedInConfigStore.subscribe(() => {
      syncConfig();
    });
    const unsubBrain = careerBrainStore.subscribe(() => {
      syncConfig();
    });

    return () => {
      isMounted = false;
      unsubConfig();
      unsubBrain();
    };
  }, []);

  const handleUpdateFitScore = async (score: number) => {
    setAutomationConfig(prev => ({ ...prev, minFitScore: score }));
    await linkedInConfigStore.updateConfig({ minFitScore: score });
  };

  // Sync platform pause status from queueSafetyStore
  useEffect(() => {
    let isMounted = true;
    const syncPause = async () => {
      try {
        const pauseStatus = await queueSafetyStore.getPlatformPause(selectedPlatform);
        if (isMounted) {
          setPlatformPauseInfo(pauseStatus);
        }
      } catch {
        if (isMounted) setPlatformPauseInfo({ isPaused: false });
      }
    };

    syncPause();
    const unsub = queueSafetyStore.subscribe(() => {
      syncPause();
    });

    return () => {
      isMounted = false;
      unsub();
    };
  }, [selectedPlatform]);

  const isStatusTextPaused = Boolean(
    activeStatusText &&
      (activeStatusText.toLowerCase().includes('pausing') ||
        activeStatusText.toLowerCase().includes('paused') ||
        activeStatusText.toLowerCase().includes('additional verification')),
  );
  const isPlatformPaused = platformPauseInfo.isPaused || isStatusTextPaused;

  // Sync auth session and refresh if expired
  useEffect(() => {
    let isMounted = true;
    const syncSession = async () => {
      try {
        const cur = await authStorage.getSession();
        if (cur?.token) {
          if (isMounted) setSession(cur);
        } else if (cur?.refreshToken) {
          const newToken = await backendApiClient.refreshAccessToken();
          if (newToken && isMounted) {
            const updated = await authStorage.getSession();
            setSession(updated);
          } else if (isMounted) {
            setSession(null);
          }
        } else {
          if (isMounted) setSession(null);
        }
      } catch {
        if (isMounted) setSession(null);
      }
    };

    syncSession();
    const unsub = authStorage.subscribe(() => {
      syncSession();
    });

    return () => {
      isMounted = false;
      unsub();
    };
  }, []);

  // Question answering state (single)
  const [userAnswerInput, setUserAnswerInput] = useState<string>('');
  const [questionTimeRemaining, setQuestionTimeRemaining] = useState<number>(180);

  // Question answering state (batch - 5 min timeout)
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({});
  const [batchTimeRemaining, setBatchTimeRemaining] = useState<number>(300);

  // Timer countdown for pending user question
  useEffect(() => {
    if (!pendingQuestion) {
      setUserAnswerInput('');
      setQuestionTimeRemaining(180);
      return;
    }

    setQuestionTimeRemaining(180);
    setUserAnswerInput(pendingQuestion.options?.[0] || '');

    const interval = setInterval(() => {
      setQuestionTimeRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [pendingQuestion]);

  // Timer countdown for pending batch questions (5 minutes)
  useEffect(() => {
    if (!pendingBatch || pendingBatch.questions.length === 0) {
      setBatchAnswers({});
      setBatchTimeRemaining(300);
      return;
    }

    setBatchTimeRemaining(300);
    const initial: Record<string, string> = {};
    for (const q of pendingBatch.questions) {
      if (q.options && q.options.length > 0) {
        initial[q.id] = q.options[0];
      } else if (q.fieldType === 'number') {
        initial[q.id] = '0';
      } else {
        initial[q.id] = '';
      }
    }
    setBatchAnswers(initial);

    const interval = setInterval(() => {
      setBatchTimeRemaining(prev => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [pendingBatch]);

  const lastBackendSyncRef = useRef<number>(0);

  // Switch to the runner tab (LinkedIn/Indeed/Naukri/Checkpoint) so the user can easily solve OTP/Captcha or upload resume
  const handleFocusRunnerTab = useCallback(async () => {
    try {
      if (typeof chrome === 'undefined' || !chrome.tabs) return;
      const allTabs = await chrome.tabs.query({});
      const runnerTab = allTabs.find(
        t =>
          t.url?.includes('linkedin.com') ||
          t.url?.includes('indeed.com') ||
          t.url?.includes('naukri.com') ||
          t.url?.includes('checkpoint') ||
          t.url?.includes('challenge'),
      );
      if (runnerTab?.id) {
        await chrome.tabs.update(runnerTab.id, { active: true });
        if (runnerTab.windowId && chrome.windows) {
          await chrome.windows.update(runnerTab.windowId, { focused: true });
        }
      }
    } catch (err) {
      console.warn('[LinkedInApplyDashboard] Failed to focus runner tab:', err);
    }
  }, []);

  // Quota from the backend (event-driven + 60s background sync); the local copy is display-only
  const loadQuota = useCallback(async (forceBackend = false) => {
    setQuota(await dailyQuotaStore.getQuotaData().catch(() => null));

    const now = Date.now();
    if (!forceBackend && now - lastBackendSyncRef.current < 60000) {
      return;
    }
    lastBackendSyncRef.current = now;

    const result = await refreshAccountQuota().catch((): QuotaRefreshResult => 'unavailable');
    if (result === 'account-changed') return; // the new account's own refresh follows
    setQuotaFetch(result === 'unavailable' ? 'failed' : 'done');
    setQuota(await dailyQuotaStore.getQuotaData().catch(() => null));
  }, []);

  const retryQuota = useCallback(async () => {
    setQuotaFetch('checking');
    await backendApiClient.getFreshToken(0).catch(() => null);
    loadQuota(true);
  }, [loadQuota]);

  useEffect(() => {
    // Initial fetch from backend
    loadQuota(true);

    // Event-driven reactive updates whenever local storage changes (zero API calls)
    const unsubscribe = dailyQuotaStore.subscribe(async () => {
      const localData = await dailyQuotaStore.getQuotaData().catch(() => null);
      if (localData) setQuota(localData);
    });

    // Controlled 60s background sync interval (increased from 5s to eliminate excessive polling)
    const interval = setInterval(() => {
      loadQuota(true);
    }, 60000);

    // Re-read the quota as soon as the account or its verified plan changes (sign-in, account
    // switch, payment, Premium starting or ending)
    let planSignature = '';
    const unsubscribeAuth = authStorage.subscribe(async () => {
      const session = await authStorage.getSession().catch(() => null);
      const signature = JSON.stringify([
        sessionUserId(session?.user),
        session?.premium?.tier ?? null,
        session?.premium?.isPremium ?? null,
        session?.subscription?.status ?? null,
        session?.subscription?.planCode ?? null,
      ]);
      if (planSignature && signature !== planSignature) {
        setQuotaFetch('checking');
        loadQuota(true);
      }
      planSignature = signature;
    });

    return () => {
      unsubscribe();
      unsubscribeAuth();
      clearInterval(interval);
    };
  }, [loadQuota]);

  const [isExporting, setIsExporting] = useState<boolean>(false);

  const handleExportSidePanelCsv = async () => {
    try {
      setIsExporting(true);
      const records = await processedJobsStore.getAllRecords();
      if (!records || records.length === 0) {
        alert('No job records found to export yet. Run an Auto Apply task first!');
        setIsExporting(false);
        return;
      }
      const exportable = records.map(r => ({
        jobId: r.jobId,
        title: r.title,
        company: r.company,
        location: r.location,
        platform: r.platform || detectPlatformFromUrl(r.url),
        status: r.status,
        reason: r.reason,
        fitScore: r.fitScore,
        creditsUsed: r.creditsUsed,
        url: r.url,
        timestamp: r.timestamp,
      }));
      exportApplicationsToCsv(exportable, 'JobForm_Automator_Applications');
    } catch (err) {
      console.error('Failed to export CSV from side panel:', err);
    } finally {
      setTimeout(() => setIsExporting(false), 1500);
    }
  };

  return (
    <div
      className={`flex flex-1 flex-col overflow-y-auto p-3 space-y-3 ${isDarkMode ? 'text-gray-100' : 'text-gray-800'}`}>
      {/* Platform Switcher */}
      <div
        className={`flex rounded-xl p-1 border text-xs font-semibold ${
          isDarkMode ? 'bg-slate-900/60 border-slate-700/60' : 'bg-gray-100 border-gray-200'
        }`}>
        <button
          type="button"
          onClick={() => setSelectedPlatform('linkedin')}
          disabled={isApplying}
          className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all cursor-pointer ${
            selectedPlatform === 'linkedin'
              ? 'bg-sky-600 text-white shadow-sm font-bold'
              : isDarkMode
                ? 'text-gray-400 hover:text-gray-200'
                : 'text-gray-600 hover:text-gray-900'
          }`}>
          LinkedIn
        </button>
        <button
          type="button"
          onClick={() => setSelectedPlatform('naukri')}
          disabled={isApplying}
          className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all cursor-pointer ${
            selectedPlatform === 'naukri'
              ? 'bg-blue-600 text-white shadow-sm font-bold'
              : isDarkMode
                ? 'text-gray-400 hover:text-gray-200'
                : 'text-gray-600 hover:text-gray-900'
          }`}>
          Naukri
        </button>
        <button
          type="button"
          onClick={() => setSelectedPlatform('indeed')}
          disabled={isApplying}
          className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all cursor-pointer ${
            selectedPlatform === 'indeed'
              ? 'bg-indigo-600 text-white shadow-sm font-bold'
              : isDarkMode
                ? 'text-gray-400 hover:text-gray-200'
                : 'text-gray-600 hover:text-gray-900'
          }`}>
          Indeed
        </button>
      </div>

      {/* Daily applications (counted and enforced by the backend, per account and UTC day) */}
      {session?.token && (
        <DailyQuotaCard
          view={quotaView}
          fetchState={quotaFetch}
          isDarkMode={isDarkMode}
          onRetry={retryQuota}
          onUpgrade={onOpenPlansModal}
        />
      )}

      {session?.token && quotaView.status === 'ready' && quotaView.exhausted && (
        <div
          role="alert"
          className={`rounded-xl border px-3 py-2.5 text-xs ${isDarkMode ? 'border-amber-700 bg-amber-900/20 text-amber-200' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <p className="font-bold">Daily limit reached</p>
          <p className="mt-0.5">
            {quotaView.isPaid
              ? `All ${quotaView.limit} applications used today.`
              : `All ${quotaView.limit} free applications used today. Premium allows 300 a day.`}
            {quotaResetLabel ? ` ${quotaResetLabel}.` : ''}
          </p>
          {!quotaView.isPaid && (
            <button
              type="button"
              onClick={() => openJobformPricing()}
              className="mt-1.5 rounded-md bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 text-[11px] font-bold text-white hover:from-amber-600 hover:to-orange-600 cursor-pointer">
              Get Premium
            </button>
          )}
        </div>
      )}

      {/* Easy Apply & Match Criteria Settings Widget */}
      <div
        className={`rounded-xl border transition-all ${
          isDarkMode ? 'border-sky-900 bg-slate-800/80' : 'border-sky-100 bg-white/90 shadow-sm'
        }`}>
        <button
          type="button"
          onClick={() => setShowEasyApplySettings(prev => !prev)}
          aria-expanded={showEasyApplySettings}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer select-none">
          <div className="flex min-w-0 items-center gap-2">
            <FiSliders className="size-4 shrink-0 text-sky-400" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold whitespace-nowrap">Match settings</span>
                <span className="whitespace-nowrap rounded bg-sky-500/20 px-1.5 text-[9px] font-bold text-sky-500 border border-sky-500/30">
                  Min fit {automationConfig.minFitScore ?? 50}%
                </span>
              </div>
              {careerBrainInfo.currentTitle && (
                <p className="truncate text-[10px] opacity-60">
                  {careerBrainInfo.currentTitle}
                  {careerBrainInfo.roles.length > 1 ? ` (+${careerBrainInfo.roles.length - 1} more)` : ''}
                </p>
              )}
            </div>
          </div>
          {showEasyApplySettings ? (
            <FiChevronUp className="size-4 shrink-0 text-gray-400" />
          ) : (
            <FiChevronDown className="size-4 shrink-0 text-gray-400" />
          )}
        </button>

        {showEasyApplySettings && (
          <div className="border-t px-3 pb-3 pt-2 space-y-3 text-xs border-sky-500/10">
            {/* Minimum Match / Fit Score Threshold Slider & Presets */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="min-fit-score" className="text-[11px] font-semibold opacity-80">
                  Minimum match score
                </label>
                <span className="text-[11px] font-bold text-sky-500">{automationConfig.minFitScore ?? 50}%</span>
              </div>
              <input
                id="min-fit-score"
                type="range"
                min={30}
                max={95}
                step={5}
                value={automationConfig.minFitScore ?? 50}
                onChange={e => handleUpdateFitScore(Number(e.target.value))}
                className="w-full cursor-pointer accent-sky-500"
              />
              <div className="flex flex-wrap gap-1 mt-1.5">
                {[
                  { label: '50% (default)', val: 50 },
                  { label: '60%', val: 60 },
                  { label: '70%', val: 70 },
                  { label: '80% (strict)', val: 80 },
                ].map(preset => (
                  <button
                    key={preset.val}
                    type="button"
                    onClick={() => handleUpdateFitScore(preset.val)}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors cursor-pointer ${
                      (automationConfig.minFitScore ?? 50) === preset.val
                        ? 'bg-sky-500 text-white font-bold'
                        : isDarkMode
                          ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}>
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] opacity-60 mt-1">
                Jobs below {automationConfig.minFitScore ?? 50}% match are skipped.
              </p>
            </div>

            {/* Experience Gap & Safeties */}
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-sky-500/10">
              <div>
                <label className="block text-[10px] font-semibold opacity-70 mb-0.5">Max Exp Gap Tolerance</label>
                <select
                  value={automationConfig.maxExperienceGapYears ?? 3}
                  onChange={async e => {
                    const val = Number(e.target.value);
                    setAutomationConfig(prev => ({ ...prev, maxExperienceGapYears: val }));
                    await linkedInConfigStore.updateConfig({ maxExperienceGapYears: val });
                  }}
                  className={`w-full rounded-md border px-2 py-1 text-[11px] outline-none ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-white' : 'border-sky-200 bg-white text-gray-900'
                  }`}>
                  <option value={1}>+1 Year</option>
                  <option value={2}>+2 Years</option>
                  <option value={3}>+3 Years (Default)</option>
                  <option value={5}>+5 Years</option>
                  <option value={10}>No Gap Limit</option>
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold opacity-70 mb-0.5">Negative Keywords</label>
                <div
                  className={`px-2 py-1 rounded-md border text-[11px] flex items-center justify-between ${
                    isDarkMode ? 'border-sky-800 bg-slate-900 text-gray-300' : 'border-sky-200 bg-white text-gray-700'
                  }`}>
                  <span>{automationConfig.negativeKeywords?.length || 0} active</span>
                  <span className="text-[9px] text-emerald-400 font-medium">Safe</span>
                </div>
              </div>
            </div>

            {/* Link to Full Options Page */}
            <div className="pt-1 flex items-center justify-between border-t border-sky-500/10 text-[10px]">
              <span className="opacity-60">Saved answers & blocked companies</span>
              <button
                type="button"
                onClick={() => chrome.runtime.openOptionsPage()}
                className="text-sky-400 hover:text-sky-300 font-semibold underline cursor-pointer flex items-center gap-1">
                <span>Full Settings</span>
                <FiExternalLink className="size-2.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Single Entry Point: Start Auto Apply or Sign In */}
      <div className="space-y-2">
        {!session?.token ? (
          <div className="space-y-2">
            <button
              onClick={() => onOpenAuthModal?.()}
              className="w-full flex items-center justify-center space-x-2 rounded-xl py-3 px-4 font-bold text-sm bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-500 hover:to-indigo-500 shadow-md shadow-blue-500/20 active:scale-[0.99] cursor-pointer transition-all">
              <FiLock className="size-4" />
              <span>Login with JobForm Automator</span>
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => onStartAutoApply?.(selectedPlatform)}
              disabled={isApplying || platformPauseInfo.isPaused}
              className={`w-full flex items-center justify-center space-x-2 rounded-xl py-3 px-4 font-bold text-sm shadow-md transition-all ${
                isApplying || platformPauseInfo.isPaused
                  ? 'bg-slate-700 text-gray-400 cursor-not-allowed opacity-60'
                  : 'bg-gradient-to-r from-sky-500 to-blue-600 text-white hover:from-sky-600 hover:to-blue-700 hover:shadow-sky-500/20 active:scale-[0.99] cursor-pointer'
              }`}>
              {platformPauseInfo.isPaused ? (
                <FiPauseCircle className="size-4 text-amber-300" />
              ) : (
                <FiPlay className="size-4 text-emerald-300" />
              )}
              <span>
                {platformPauseInfo.isPaused
                  ? `Paused for Today (${selectedPlatform === 'naukri' ? 'Naukri' : selectedPlatform === 'indeed' ? 'Indeed' : 'LinkedIn'})`
                  : `Start Auto Apply (${selectedPlatform === 'naukri' ? 'Naukri' : selectedPlatform === 'indeed' ? 'Indeed' : 'LinkedIn'})`}
              </span>
            </button>
            {platformPauseInfo.isPaused && (
              <button
                type="button"
                onClick={async () => {
                  await queueSafetyStore.clearPlatformPause(selectedPlatform);
                  setPlatformPauseInfo({ isPaused: false });
                }}
                className="w-full flex items-center justify-center space-x-1.5 rounded-xl py-2 px-3 font-semibold text-xs bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40 transition-all cursor-pointer">
                <FiPlay className="size-3.5" />
                <span>Remove Safety Pause & Resume</span>
              </button>
            )}
            {platformPauseInfo.isPaused && (
              <p className="text-[11px] text-center opacity-70">Paused for today to protect your account.</p>
            )}
          </>
        )}

        {/* Visible Stop Application Button */}
        {isApplying && !isPlatformPaused && (
          <button
            onClick={onStop}
            className="w-full flex items-center justify-center space-x-2 rounded-xl py-2.5 px-4 font-bold text-xs bg-red-500 text-white hover:bg-red-600 shadow-md transition-all cursor-pointer animate-pulse">
            <FiSquare className="size-3.5" />
            <span>Stop Application</span>
          </button>
        )}
      </div>

      {/* Interactive Human-In-The-Loop Question Card */}
      {pendingQuestion && (
        <div className="rounded-xl border-2 border-amber-500/80 bg-amber-500/10 p-4 space-y-3 shadow-lg animate-pulse">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs font-bold text-amber-400">
              <span className="size-2 rounded-full bg-amber-400 animate-ping" />
              <span>Input Required to Proceed</span>
            </div>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
              {Math.floor(questionTimeRemaining / 60)}:{(questionTimeRemaining % 60).toString().padStart(2, '0')}{' '}
              remaining
            </span>
          </div>

          <p className="text-xs font-semibold text-white leading-relaxed">{pendingQuestion.questionText}</p>

          {/* Form controls based on fieldType */}
          {pendingQuestion.options && pendingQuestion.options.length > 0 ? (
            <div className="space-y-1.5 pt-1">
              {pendingQuestion.options.map(opt => (
                <label
                  key={opt}
                  className={`flex items-center space-x-2 p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                    userAnswerInput === opt
                      ? 'border-amber-400 bg-amber-500/20 text-white font-bold'
                      : 'border-slate-700 bg-slate-800/80 text-gray-300 hover:border-slate-600'
                  }`}>
                  <input
                    type="radio"
                    name="user-question-opt"
                    checked={userAnswerInput === opt}
                    onChange={() => setUserAnswerInput(opt)}
                    className="accent-amber-400"
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          ) : pendingQuestion.fieldType === 'number' ? (
            <div className="flex items-center space-x-2">
              <input
                type="number"
                min={pendingQuestion.min ?? 0}
                max={pendingQuestion.max ?? 99}
                value={userAnswerInput}
                onChange={e => setUserAnswerInput(e.target.value)}
                placeholder="Enter whole number (0 - 99)"
                className="flex-1 rounded-lg border border-amber-500/40 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-amber-400"
              />
              <span className="text-xs text-gray-400">years</span>
            </div>
          ) : (
            <input
              type="text"
              value={userAnswerInput}
              onChange={e => setUserAnswerInput(e.target.value)}
              placeholder="Type your answer here..."
              className="w-full rounded-lg border border-amber-500/40 bg-slate-900 px-3 py-2 text-xs text-white outline-none focus:border-amber-400"
            />
          )}

          <button
            onClick={() => {
              if (userAnswerInput !== '' && onAnswerQuestion) {
                onAnswerQuestion(pendingQuestion.questionId, userAnswerInput);
              }
            }}
            disabled={userAnswerInput === ''}
            className="w-full rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 py-2 text-xs font-bold text-slate-950 hover:from-amber-400 hover:to-orange-400 disabled:opacity-50 transition-all cursor-pointer shadow-md">
            Submit Answer & Continue Application
          </button>
        </div>
      )}

      {/* Interactive Human-In-The-Loop Question Batch Card */}
      {pendingBatch && pendingBatch.questions && pendingBatch.questions.length > 0 && (
        <div className="rounded-xl border-2 border-amber-500/80 bg-amber-500/10 p-4 space-y-3.5 shadow-lg">
          <div className="flex items-center justify-between border-b border-amber-500/20 pb-2.5">
            <div className="flex items-center space-x-2 text-xs font-bold text-amber-400">
              <span className="size-2 rounded-full bg-amber-400 animate-ping" />
              <span>Input Required ({pendingBatch.questions.length} questions)</span>
            </div>
            <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
              {Math.floor(batchTimeRemaining / 60)}:{(batchTimeRemaining % 60).toString().padStart(2, '0')} remaining
            </span>
          </div>

          <div className="max-h-[360px] overflow-y-auto space-y-3 pr-1">
            {pendingBatch.questions.map((q, idx) => (
              <div key={q.id} className="rounded-lg border border-slate-700/80 bg-slate-900/90 p-3 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[11px] font-bold text-amber-400">
                    Q{idx + 1} {q.required ? <span className="text-red-400">*</span> : ''}
                  </span>
                  {q.skillName && (
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] font-semibold text-gray-400">
                      Skill: {q.skillName}
                    </span>
                  )}
                </div>
                <p className="text-xs font-semibold text-white leading-relaxed">{q.questionText}</p>

                {/* Form controls based on fieldType */}
                {q.options && q.options.length > 0 ? (
                  <div className="grid grid-cols-2 gap-1.5 pt-1">
                    {q.options.map(opt => (
                      <label
                        key={opt}
                        className={`flex items-center space-x-2 p-2 rounded-lg border text-xs cursor-pointer transition-all ${
                          batchAnswers[q.id] === opt
                            ? 'border-amber-400 bg-amber-500/20 text-white font-bold'
                            : 'border-slate-700 bg-slate-800/80 text-gray-300 hover:border-slate-600'
                        }`}>
                        <input
                          type="radio"
                          name={`batch-opt-${q.id}`}
                          checked={batchAnswers[q.id] === opt}
                          onChange={() => setBatchAnswers(prev => ({ ...prev, [q.id]: opt }))}
                          className="accent-amber-400"
                        />
                        <span className="truncate">{opt}</span>
                      </label>
                    ))}
                  </div>
                ) : q.fieldType === 'number' ? (
                  <div className="flex items-center space-x-2">
                    <input
                      type="number"
                      min={q.min ?? 0}
                      max={q.max ?? 99}
                      value={batchAnswers[q.id] ?? ''}
                      onChange={e => setBatchAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder="Enter whole number"
                      className="flex-1 rounded-lg border border-amber-500/40 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-amber-400"
                    />
                    <span className="text-xs text-gray-400">years</span>
                  </div>
                ) : (
                  <input
                    type="text"
                    value={batchAnswers[q.id] ?? ''}
                    onChange={e => setBatchAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                    placeholder="Type your answer here..."
                    className="w-full rounded-lg border border-amber-500/40 bg-slate-950 px-3 py-2 text-xs text-white outline-none focus:border-amber-400"
                  />
                )}
              </div>
            ))}
          </div>

          <button
            onClick={() => {
              if (onAnswerQuestionBatch) {
                onAnswerQuestionBatch(pendingBatch.batchId, batchAnswers);
              }
            }}
            disabled={pendingBatch.questions.some(q => !batchAnswers[q.id] || batchAnswers[q.id].trim() === '')}
            className="w-full rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 py-2.5 text-xs font-bold text-slate-950 hover:from-amber-400 hover:to-orange-400 disabled:opacity-50 transition-all cursor-pointer shadow-md">
            Submit All Answers (
            {pendingBatch.questions.filter(q => batchAnswers[q.id] && batchAnswers[q.id].trim() !== '').length}/
            {pendingBatch.questions.length}) & Continue Application
          </button>
        </div>
      )}

      {/* Live Application Status Banner */}
      {(isApplying || isPlatformPaused) &&
        (() => {
          const isWaitingVerification =
            !isPlatformPaused &&
            (activeStatusText?.toLowerCase().includes('verification') ||
              activityItems.some(i => i.status === 'needs_verification'));

          return (
            <div
              className={`rounded-xl border p-3.5 space-y-2 transition-colors ${
                isPlatformPaused
                  ? isDarkMode
                    ? 'border-red-500/50 bg-red-950/30'
                    : 'border-red-300 bg-red-50/90'
                  : isWaitingVerification
                    ? isDarkMode
                      ? 'border-amber-500/50 bg-amber-950/40 animate-pulse'
                      : 'border-amber-400 bg-amber-50/95 shadow-sm'
                    : isDarkMode
                      ? 'border-sky-500/40 bg-sky-950/30'
                      : 'border-sky-200 bg-sky-50/90'
              }`}>
              <div
                className={`flex items-center space-x-2 text-xs font-bold ${
                  isPlatformPaused
                    ? isDarkMode
                      ? 'text-red-400'
                      : 'text-red-700'
                    : isWaitingVerification
                      ? isDarkMode
                        ? 'text-amber-300'
                        : 'text-amber-800'
                      : isDarkMode
                        ? 'text-sky-400'
                        : 'text-sky-700'
                }`}>
                {isPlatformPaused ? (
                  <FiPauseCircle className={`size-4 shrink-0 ${isDarkMode ? 'text-red-400' : 'text-red-600'}`} />
                ) : isWaitingVerification ? (
                  <FiAlertTriangle
                    className={`size-4 shrink-0 animate-bounce ${isDarkMode ? 'text-amber-300' : 'text-amber-600'}`}
                  />
                ) : (
                  <AiOutlineLoading3Quarters
                    className={`size-4 animate-spin shrink-0 ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}
                  />
                )}
                <span>
                  {isPlatformPaused
                    ? 'Application Paused for Today'
                    : isWaitingVerification
                      ? 'Manual Verification Required'
                      : 'Application in Progress...'}
                </span>
              </div>
              <p
                className={`text-xs font-medium leading-relaxed p-2.5 rounded-lg border ${
                  isPlatformPaused
                    ? isDarkMode
                      ? 'text-red-100 bg-slate-900/80 border-red-500/30'
                      : 'text-red-950 bg-white border-red-300 shadow-sm'
                    : isWaitingVerification
                      ? isDarkMode
                        ? 'text-amber-100 bg-slate-900/80 border-amber-500/40'
                        : 'text-amber-950 bg-white border-amber-300 shadow-sm'
                      : isDarkMode
                        ? 'text-[#f1f5f9] bg-slate-900/80 border-sky-500/20'
                        : 'text-[#0f172a] bg-white border-sky-200 shadow-sm'
                }`}>
                {activeStatusText ||
                  platformPauseInfo.reason ||
                  'Auto-apply is paused for today to protect your account.'}
              </p>
              {isWaitingVerification && (
                <button
                  type="button"
                  onClick={handleFocusRunnerTab}
                  className="w-full flex items-center justify-center gap-1.5 rounded-lg py-2 px-3 text-xs font-bold bg-amber-500 hover:bg-amber-600 text-slate-950 transition shadow-sm cursor-pointer active:scale-98">
                  <span>👉 Switch to Runner Tab to Solve</span>
                </button>
              )}
            </div>
          );
        })()}

      {/* Live Activity Logs */}
      <div
        className={`rounded-xl border p-3 flex flex-col space-y-2 ${activityItems.length > 0 || appliedLogs.length > 0 ? 'flex-1' : ''} ${isDarkMode ? 'border-[#334155] bg-[#0f172a]' : 'border-[#e2e8f0] bg-white shadow-sm'}`}>
        <div
          className={`flex items-center justify-between border-b pb-1.5 ${isDarkMode ? 'border-[#334155]' : 'border-[#e2e8f0]'}`}>
          <span
            className={`text-[11px] font-bold uppercase tracking-wider ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}>
            Live Activity
          </span>
          <div className="flex items-center gap-2">
            {(activityItems.length > 0 || appliedLogs.length > 0) && (
              <span className={`text-[10px] ${isDarkMode ? 'text-[#94a3b8]' : 'text-[#64748b]'}`}>
                {activityItems.length > 0 ? `${activityItems.length} jobs` : `${appliedLogs.length} updates`}
              </span>
            )}
            <button
              type="button"
              onClick={handleExportSidePanelCsv}
              disabled={isExporting}
              title="Export Applied & Processed Jobs to CSV / Excel"
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold transition shadow-xs cursor-pointer ${
                isDarkMode
                  ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-900/60'
                  : 'bg-emerald-50 text-emerald-700 border border-emerald-300 hover:bg-emerald-100'
              }`}>
              <FiDownload className={`size-3 ${isExporting ? 'animate-bounce' : ''}`} />
              <span>{isExporting ? 'Saved' : 'CSV'}</span>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2.5 text-xs">
          {activityItems.length > 0 && (
            <div className="space-y-2">
              {activityItems.map(item => (
                <div
                  key={item.id}
                  className={`rounded-xl border p-2.5 space-y-1.5 text-xs transition-colors ${
                    isDarkMode
                      ? item.status === 'needs_verification'
                        ? 'border-amber-500/60 bg-[#1e293b] hover:bg-[#273449]'
                        : item.status === 'modal_opened'
                          ? 'border-purple-900/60 bg-[#1e293b] hover:bg-[#273449]'
                          : item.status === 'modal_failed'
                            ? 'border-rose-900/60 bg-[#1e293b] hover:bg-[#273449]'
                            : item.status === 'applied'
                              ? 'border-emerald-900/60 bg-[#1e293b] hover:bg-[#273449]'
                              : item.status === 'skipped'
                                ? 'border-amber-900/60 bg-[#1e293b] hover:bg-[#273449]'
                                : item.status === 'failed'
                                  ? 'border-red-900/60 bg-[#1e293b] hover:bg-[#273449]'
                                  : 'border-[#334155] bg-[#1e293b] hover:bg-[#273449]'
                      : item.status === 'needs_verification'
                        ? 'border-amber-400 bg-amber-50/90 hover:bg-amber-100/90 shadow-sm'
                        : item.status === 'modal_opened'
                          ? 'border-purple-200 bg-white hover:bg-[#f8fafc] shadow-sm'
                          : item.status === 'modal_failed'
                            ? 'border-rose-200 bg-white hover:bg-[#f8fafc] shadow-sm'
                            : item.status === 'applied'
                              ? 'border-emerald-200 bg-white hover:bg-[#f8fafc] shadow-sm'
                              : item.status === 'skipped'
                                ? 'border-amber-200 bg-white hover:bg-[#f8fafc] shadow-sm'
                                : item.status === 'failed'
                                  ? 'border-red-200 bg-white hover:bg-[#f8fafc] shadow-sm'
                                  : 'border-[#e2e8f0] bg-white hover:bg-[#f8fafc] shadow-sm'
                  }`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className={`font-bold truncate ${isDarkMode ? 'text-[#f1f5f9]' : 'text-[#0f172a]'}`}>
                      {item.title || 'LinkedIn Job'}
                      {item.company && (
                        <span className={`font-normal ${isDarkMode ? 'text-[#94a3b8]' : 'text-[#64748b]'}`}>
                          {' '}
                          · {item.company}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase shrink-0 ${
                        item.status === 'needs_verification'
                          ? isDarkMode
                            ? 'bg-[#78350f] text-[#fbbf24] border border-amber-500/50 animate-pulse'
                            : 'bg-[#fef3c7] text-[#b45309] border border-[#fcd34d] animate-pulse'
                          : item.status === 'modal_opened'
                            ? isDarkMode
                              ? 'bg-[#4c1d95] text-[#c4b5fd] border border-purple-500/40'
                              : 'bg-[#ede9fe] text-[#6d28d9] border border-[#c4b5fd]'
                            : item.status === 'modal_failed'
                              ? isDarkMode
                                ? 'bg-rose-950/60 text-rose-300 border border-rose-500/40'
                                : 'bg-rose-100 text-rose-700 border border-rose-300'
                              : item.status === 'applied'
                                ? isDarkMode
                                  ? 'bg-[#14532d] text-[#4ade80] border border-emerald-500/40'
                                  : 'bg-[#dcfce7] text-[#15803d] border border-[#86efac]'
                                : item.status === 'skipped'
                                  ? isDarkMode
                                    ? 'bg-[#78350f] text-[#fbbf24] border border-amber-500/40'
                                    : 'bg-[#fef3c7] text-[#b45309] border border-[#fcd34d]'
                                  : item.status === 'failed'
                                    ? isDarkMode
                                      ? 'bg-red-950/60 text-red-300 border border-red-500/40'
                                      : 'bg-red-100 text-red-700 border border-red-300'
                                    : isDarkMode
                                      ? 'bg-sky-950/60 text-sky-300 border border-sky-500/40 animate-pulse'
                                      : 'bg-sky-100 text-sky-700 border border-sky-300 animate-pulse'
                      }`}>
                      {item.status === 'needs_verification'
                        ? 'Needs Verification'
                        : item.status === 'modal_opened'
                          ? 'Form Opened'
                          : item.status === 'modal_failed'
                            ? 'Form Failed'
                            : item.status === 'applied'
                              ? 'Applied'
                              : item.status === 'skipped'
                                ? 'Skipped'
                                : item.status === 'failed'
                                  ? 'Failed'
                                  : 'Running...'}
                    </span>
                  </div>

                  {item.url && (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`text-[10px] truncate block hover:underline ${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-600 hover:text-sky-700'}`}>
                      {item.url}
                    </a>
                  )}

                  {item.reason && (
                    <p className={`text-[11px] leading-tight ${isDarkMode ? 'text-[#f1f5f9]' : 'text-[#0f172a]'}`}>
                      {item.reason}
                    </p>
                  )}

                  <div
                    className={`flex items-center justify-between text-[9px] pt-0.5 ${isDarkMode ? 'text-[#94a3b8]' : 'text-[#64748b]'}`}>
                    <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    {item.status === 'applied' && (
                      <span className={isDarkMode ? 'text-[#4ade80] font-semibold' : 'text-[#15803d] font-semibold'}>
                        Applied & verified
                      </span>
                    )}
                    {item.status === 'modal_opened' && <span>Dry run</span>}
                    {!aiIncluded && item.status === 'skipped' && <span>0 credits used</span>}
                    {!aiIncluded && item.status === 'failed' && <span>Credits refunded</span>}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activityItems.length === 0 && appliedLogs.length === 0 ? (
            <p className={`py-2 text-center text-[11px] ${isDarkMode ? 'text-[#94a3b8]' : 'text-[#64748b]'}`}>
              No activity yet
            </p>
          ) : (
            appliedLogs.map(log => {
              const matchTag = log.text.match(/^\[(MATCHED|GENERATED|ASKED)\]\s*(.*)$/);
              const category = matchTag ? matchTag[1] : null;
              const rawText = matchTag ? matchTag[2] : log.text;

              // Clean internal technical tokens and make them user-friendly
              const displayText = rawText
                .replace(/\s*\|\s*DOM fill:\s*(SUCCESS|FAILED)/gi, '')
                .replace(/\(profile standard:\s*([^)]+)\)/gi, '($1 from profile)')
                .replace(/\(LLM generated\)/gi, '(Answered with AI)')
                .replace(/\(user input\)/gi, '(From your input)')
                .replace(/\(cached answer\)/gi, '(From saved answers)')
                .replace(/\(golden answer\)/gi, '(From saved answers)');

              const categoryBadge =
                category === 'MATCHED'
                  ? 'PROFILE MATCH'
                  : category === 'GENERATED'
                    ? 'AI ANSWER'
                    : category === 'ASKED'
                      ? 'YOUR INPUT'
                      : null;

              return (
                <div
                  key={log.id}
                  className={`flex items-start space-x-2 rounded-lg p-2.5 text-[11px] leading-relaxed transition-all ${
                    isDarkMode
                      ? category === 'MATCHED'
                        ? 'border border-emerald-900/60 bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                        : category === 'GENERATED'
                          ? 'border border-purple-900/60 bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                          : category === 'ASKED'
                            ? 'border border-amber-900/60 bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                            : log.status === 'ok'
                              ? 'border border-emerald-900/60 bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                              : log.status === 'fail'
                                ? 'border border-rose-900/60 bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                                : 'border border-[#334155] bg-[#1e293b] hover:bg-[#273449] text-[#f1f5f9]'
                      : category === 'MATCHED'
                        ? 'border border-emerald-200 bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                        : category === 'GENERATED'
                          ? 'border border-purple-200 bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                          : category === 'ASKED'
                            ? 'border border-amber-200 bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                            : log.status === 'ok'
                              ? 'border border-emerald-200 bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                              : log.status === 'fail'
                                ? 'border border-rose-200 bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                                : 'border border-[#e2e8f0] bg-white hover:bg-[#f8fafc] text-[#0f172a] shadow-sm'
                  }`}>
                  {category === 'MATCHED' ? (
                    <FiCheckCircle
                      className={`size-3.5 shrink-0 mt-0.5 ${isDarkMode ? 'text-[#4ade80]' : 'text-[#15803d]'}`}
                    />
                  ) : category === 'GENERATED' ? (
                    <FiZap className={`size-3.5 shrink-0 mt-0.5 ${isDarkMode ? 'text-[#c4b5fd]' : 'text-[#6d28d9]'}`} />
                  ) : category === 'ASKED' ? (
                    <FiHelpCircle
                      className={`size-3.5 shrink-0 mt-0.5 ${isDarkMode ? 'text-[#fbbf24]' : 'text-[#b45309]'}`}
                    />
                  ) : log.status === 'ok' ? (
                    <FiCheckCircle
                      className={`size-3.5 shrink-0 mt-0.5 ${isDarkMode ? 'text-[#4ade80]' : 'text-[#15803d]'}`}
                    />
                  ) : log.status === 'fail' ? (
                    <FiAlertTriangle
                      className={`size-3.5 shrink-0 mt-0.5 ${isDarkMode ? 'text-rose-400' : 'text-rose-600'}`}
                    />
                  ) : (
                    <span
                      className={`size-1.5 rounded-full shrink-0 mt-1.5 ${isDarkMode ? 'bg-sky-400' : 'bg-sky-600'}`}
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center flex-wrap gap-1.5 mb-0.5">
                      {categoryBadge && (
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                            isDarkMode
                              ? category === 'MATCHED'
                                ? 'bg-[#14532d] text-[#4ade80] border border-emerald-700/50'
                                : category === 'GENERATED'
                                  ? 'bg-[#4c1d95] text-[#c4b5fd] border border-purple-700/50'
                                  : 'bg-[#78350f] text-[#fbbf24] border border-amber-700/50'
                              : category === 'MATCHED'
                                ? 'bg-[#dcfce7] text-[#15803d] border border-[#86efac]'
                                : category === 'GENERATED'
                                  ? 'bg-[#ede9fe] text-[#6d28d9] border border-[#c4b5fd]'
                                  : 'bg-[#fef3c7] text-[#b45309] border border-[#fcd34d]'
                          }`}>
                          {categoryBadge}
                        </span>
                      )}
                    </div>
                    <div className={`break-words font-medium ${isDarkMode ? 'text-[#f1f5f9]' : 'text-[#0f172a]'}`}>
                      {displayText}
                    </div>
                    <span className={`block text-[9px] mt-1 ${isDarkMode ? 'text-[#94a3b8]' : 'text-[#64748b]'}`}>
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
export default LinkedInApplyDashboard;
