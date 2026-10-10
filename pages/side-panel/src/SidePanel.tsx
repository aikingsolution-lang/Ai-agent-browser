/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react';
import { RxDiscordLogo } from 'react-icons/rx';
import { FiSettings, FiZap, FiUser, FiLogOut, FiStar, FiAlertTriangle, FiRefreshCw, FiX } from 'react-icons/fi';
import { PiPlusBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import {
  type Message,
  Actors,
  chatHistoryStore,
  agentModelStore,
  generalSettingsStore,
  cloudApiSettingsStore,
  type CloudApiSettingsConfig,
  authStorage,
  endAccountSession,
  type UserSessionData,
  careerBrainStore,
  validateProfileCompleteness,
  queueSafetyStore,
  normalizeLinkedInJobUrl,
  checkCopilotAccess,
  dailyQuotaStore,
} from '@extension/storage';
import {
  backendApiClient,
  isPremiumActive,
  openJobformSignIn,
  refreshAccountStatus,
  runSystemDiagnostics,
  type SystemDiagnosticsReport,
} from '@extension/shared';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList from './components/MessageList';
import ChatInput from './components/ChatInput';
import ChatHistoryList from './components/ChatHistoryList';
import BookmarkList from './components/BookmarkList';
import { AuthGateView } from './components/AuthGateView';
import { PremiumPlansModal } from './components/PremiumPlansModal';
import { EventType, type AgentEvent, ExecutionState } from './types/event';
import { FiBriefcase, FiFileText, FiMessageSquare, FiLock } from 'react-icons/fi';
import { ResumeProfileView } from './components/ResumeProfileView';
import { LinkedInApplyDashboard, type StructuredActivityItem } from './components/LinkedInApplyDashboard';
import { FailedRefundBanner } from './components/FailedRefundBanner';
import './SidePanel.css';

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

const SidePanel = () => {
  const progressMessage = 'Showing progress...';
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null); // null = loading, false = no models, true = has models
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [cloudSettings, setCloudSettings] = useState<CloudApiSettingsConfig | null>(null);
  const [authSession, setAuthSession] = useState<UserSessionData | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(true);
  const [isPlansModalOpen, setIsPlansModalOpen] = useState(false);
  const [userCredits, setUserCredits] = useState<{ remainingCredits: number; allocatedCredits: number } | null>(null);
  const [mainTab, setMainTab] = useState<'apply' | 'resume' | 'chat'>('apply');
  const [isApplying, setIsApplying] = useState(false);
  const [activeStatusText, setActiveStatusText] = useState('');
  const [appliedLogs, setAppliedLogs] = useState<
    Array<{ id: string; text: string; status: 'ok' | 'fail' | 'info'; timestamp: number }>
  >([]);
  const [activityItems, setActivityItems] = useState<StructuredActivityItem[]>([]);
  const [pendingQuestion, setPendingQuestion] = useState<any | null>(null);
  const [pendingBatch, setPendingBatch] = useState<any | null>(null);
  const [chatMode, setChatMode] = useState<'agent' | 'copilot'>('copilot');
  const [copilotMessages, setCopilotMessages] = useState<Message[]>([]);
  const [isCopilotTyping, setIsCopilotTyping] = useState(false);
  const [copilotAudit, setCopilotAudit] = useState<{ score: number; missingFields: any[] } | null>(null);
  const [diagnosticsReport, setDiagnosticsReport] = useState<SystemDiagnosticsReport | null>(null);
  const [isDismissedDiagnostics, setIsDismissedDiagnostics] = useState(false);
  const [showAuthRequiredBanner, setShowAuthRequiredBanner] = useState(false);
  const [failedRefundNotice, setFailedRefundNotice] = useState<Array<{ runId: string; reason: string }> | null>(null);

  const checkFailedRefunds = useCallback(async () => {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
        const data = await chrome.storage.local.get(['nanobrowser_failed_refunds']);
        const list = data?.nanobrowser_failed_refunds || [];
        if (Array.isArray(list) && list.length > 0) {
          setFailedRefundNotice(list);
        } else {
          setFailedRefundNotice(null);
        }
      }
    } catch {
      // Ignore
    }
  }, []);

  const runDiagnostics = useCallback(async () => {
    try {
      const report = await runSystemDiagnostics();
      setDiagnosticsReport(report);
      await checkFailedRefunds();
    } catch (err) {
      console.warn('[SidePanel] Diagnostics check failed:', err);
    }
  }, [checkFailedRefunds]);

  useEffect(() => {
    runDiagnostics();
  }, [runDiagnostics]);

  const refreshCopilotAudit = useCallback(async () => {
    try {
      chrome.runtime.sendMessage({ type: 'CAREER_COPILOT_AUDIT' }, (res: any) => {
        if (res && res.success && res.audit) {
          setCopilotAudit(res.audit);
        }
      });
    } catch (err) {
      console.error('Failed to fetch copilot audit:', err);
    }
  }, []);

  useEffect(() => {
    if (mainTab === 'chat' && chatMode === 'copilot') {
      refreshCopilotAudit();
    }
  }, [mainTab, chatMode, refreshCopilotAudit]);

  // Check if models are configured OR user is authenticated with Cloud API
  const checkModelConfiguration = useCallback(async () => {
    try {
      const configuredAgents = await agentModelStore.getConfiguredAgents();
      const session = await authStorage.getSession();

      // Check if at least one agent is configured locally OR user is logged in with Cloud API token
      const hasCloudAuth = Boolean(session?.token);
      const hasAtLeastOneModel = configuredAgents.length > 0 || hasCloudAuth;
      setHasConfiguredModels(hasAtLeastOneModel);
    } catch (error) {
      console.error('Error checking model configuration:', error);
      setHasConfiguredModels(false);
    }
  }, []);

  // 1. Pure Local Storage Sync (Does NOT make HTTP API calls, preventing storage subscription infinite loops)
  const syncAuthFromStorage = useCallback(async () => {
    try {
      let session = await authStorage.getSession();
      if (!session?.token && session?.refreshToken) {
        const refreshedToken = await backendApiClient.refreshAccessToken();
        if (refreshedToken) {
          session = await authStorage.getSession();
        }
      }
      setAuthSession(session);
      if (session?.credits) {
        setUserCredits({
          remainingCredits: session.credits.remainingCredits,
          allocatedCredits: session.credits.allocatedCredits,
        });
      } else {
        setUserCredits(null);
      }
      if (session?.token) {
        backendApiClient.setToken(session.token);
      }
      checkModelConfiguration();
    } catch (error) {
      console.error('Error syncing auth state from storage:', error);
    } finally {
      setIsAuthLoading(false);
    }
  }, [checkModelConfiguration]);

  // Subscription / JobForm Automator premium status, re-read from the backend at most every 5 minutes
  // (and right after sign-in or a website payment, which the background handles).
  const lastStatusRefreshRef = useRef(0);
  const refreshStatusIfStale = useCallback(async (force = false) => {
    if (!force && Date.now() - lastStatusRefreshRef.current < 5 * 60 * 1000) return;
    lastStatusRefreshRef.current = Date.now();
    await refreshAccountStatus().catch(error => console.error('Error refreshing subscription status:', error));
  }, []);

  // 2. Controlled API Credits Fetcher (Only called on mount, task finish, tab focus, or controlled 60s interval)
  const fetchCreditsBalance = useCallback(async () => {
    try {
      const session = await authStorage.getSession();
      if (!session?.token) {
        setUserCredits(null);
        return;
      }
      refreshStatusIfStale();
      backendApiClient.setToken(session.token);
      const creditsRes = await backendApiClient.getCreditsBalance();
      if (creditsRes.data) {
        setUserCredits({
          remainingCredits: creditsRes.data.remainingCredits,
          allocatedCredits: creditsRes.data.allocatedCredits,
        });
        await authStorage.setSession({ credits: creditsRes.data });
      }

      // Sync user subscription daily apply quota limit
      const quotaRes = await backendApiClient.getProfileQuota().catch(() => null);
      if (quotaRes?.dailyLimit) {
        await dailyQuotaStore.setMaxDailyLimit(quotaRes.dailyLimit);
      }
    } catch (error) {
      console.error('Error fetching credits balance from API:', error);
    }
  }, [refreshStatusIfStale]);

  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  // Load general settings to check if replay is enabled
  const loadGeneralSettings = useCallback(async () => {
    try {
      const settings = await generalSettingsStore.getSettings();
      setReplayEnabled(settings.replayHistoricalTasks);
    } catch (error) {
      console.error('Error loading general settings:', error);
      setReplayEnabled(false);
    }
  }, []);

  // Sync state from storage on mount & subscribe to storage changes (NO API calls inside listener!)
  useEffect(() => {
    syncAuthFromStorage();
    const unsubscribe = authStorage.subscribe(() => {
      syncAuthFromStorage();
    });
    return () => {
      unsubscribe();
    };
  }, [syncAuthFromStorage]);

  // Controlled initial remote fetch & 60-second polling interval
  useEffect(() => {
    fetchCreditsBalance();
    checkModelConfiguration();
    loadGeneralSettings();

    const intervalId = setInterval(() => {
      fetchCreditsBalance();
    }, 60000); // 60s controlled polling interval

    return () => {
      clearInterval(intervalId);
    };
  }, [fetchCreditsBalance, checkModelConfiguration, loadGeneralSettings]);

  // Refresh credits balance when side panel becomes visible or gains focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fetchCreditsBalance();
        checkModelConfiguration();
        loadGeneralSettings();
      }
    };

    const handleFocus = () => {
      fetchCreditsBalance();
      checkModelConfiguration();
      loadGeneralSettings();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [fetchCreditsBalance, checkModelConfiguration, loadGeneralSettings]);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    // Don't save progress messages
    const isProgressMessage = newMessage.content === progressMessage;

    setMessages(prev => {
      const filteredMessages = prev.filter((msg, idx) => !(msg.content === progressMessage && idx === prev.length - 1));
      return [...filteredMessages, newMessage];
    });

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    console.log('sessionId', effectiveSessionId);

    // Save message to storage if we have a session and it's not a progress message
    if (effectiveSessionId && !isProgressMessage) {
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const handleTaskState = useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details;
      let skip = true;
      let displayProgress = false;

      switch (actor) {
        case Actors.SYSTEM:
          switch (state) {
            case ExecutionState.TASK_START:
              setIsHistoricalSession(false);
              skip = false;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.TASK_OK:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              fetchCreditsBalance();
              break;
            case ExecutionState.TASK_FAIL:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              fetchCreditsBalance();
              break;
            case ExecutionState.TASK_CANCEL:
              setIsFollowUpMode(false);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              fetchCreditsBalance();
              break;
            case ExecutionState.TASK_PAUSE:
              break;
            case ExecutionState.TASK_RESUME:
              break;
            default:
              skip = false;
              break;
          }
          break;
        case Actors.USER:
          break;
        case Actors.PLANNER:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            default:
              console.error('Invalid step state', state);
              return;
          }
          break;
        case Actors.NAVIGATOR:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              displayProgress = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              displayProgress = false;
              break;
            case ExecutionState.STEP_CANCEL:
              displayProgress = false;
              break;
            case ExecutionState.ACT_START:
              if (content !== 'cache_content') {
                // skip to display caching content
                skip = false;
              }
              break;
            case ExecutionState.ACT_OK:
              skip = !isReplayingRef.current;
              break;
            case ExecutionState.ACT_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid action', state);
              return;
          }
          break;
        case Actors.VALIDATOR:
          // Handle legacy validator events from historical messages
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid validation', state);
              return;
          }
          break;
        default:
          console.error('Unknown actor', actor);
          return;
      }

      if (content && data?.taskId !== 'runner_status') {
        setActiveStatusText(content);
        setAppliedLogs(prev => {
          if (
            prev.length > 0 &&
            (prev[0].text === content ||
              (content.includes('Application stopped by user') &&
                prev.some(item => item.text.includes('Application stopped by user'))))
          ) {
            return prev;
          }
          return [
            {
              id: String(Date.now()) + Math.random(),
              text: content,
              status:
                state === ExecutionState.STEP_FAIL || state === ExecutionState.TASK_FAIL
                  ? 'fail'
                  : state === ExecutionState.TASK_OK || content.includes('Successfully')
                    ? 'ok'
                    : 'info',
              timestamp: Date.now(),
            },
            ...prev.slice(0, 49),
          ];
        });
        if (
          state === ExecutionState.TASK_OK ||
          state === ExecutionState.TASK_FAIL ||
          content.includes('Successfully applied') ||
          content.includes('🏁 All') ||
          content.includes('Halting queue') ||
          content.includes('Stopping queue') ||
          content.includes('Queue stopped') ||
          content.includes('Queue halted') ||
          content.includes('Queue locked')
        ) {
          setIsApplying(false);
        }
      }

      if (!skip) {
        appendMessage({
          actor,
          content: content || '',
          timestamp: timestamp,
        });
      }

      if (displayProgress) {
        appendMessage({
          actor,
          content: progressMessage,
          timestamp: timestamp,
        });
      }
    },
    [appendMessage],
  );

  // Stop heartbeat and close connection
  const stopConnection = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (portRef.current) {
      portRef.current.disconnect();
      portRef.current = null;
    }
  }, []);

  // Setup connection management
  const setupConnection = useCallback(() => {
    // Only setup if no existing connection
    if (portRef.current) {
      return;
    }

    try {
      portRef.current = chrome.runtime.connect({ name: 'side-panel-connection' });

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      portRef.current.onMessage.addListener((message: any) => {
        // Add type checking for message
        if (message && (message.type === EventType.EXECUTION || message.actor || message.data)) {
          handleTaskState(message);
        } else if (message && message.type === 'error') {
          // Handle error messages from service worker
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('errors_unknown'),
            timestamp: Date.now(),
          });
          setInputEnabled(true);
          setShowStopButton(false);
          setIsFollowUpMode(false);
        } else if (message && message.type === 'speech_to_text_result') {
          // Handle speech-to-text result
          if (message.text && setInputTextRef.current) {
            setInputTextRef.current(message.text);
          }
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'speech_to_text_error') {
          // Handle speech-to-text error
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('chat_stt_recognitionFailed'),
            timestamp: Date.now(),
          });
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'ASK_USER_QUESTION') {
          setPendingQuestion(message.data);
          setPendingBatch(null);
          setMainTab('apply');
        } else if (message && message.type === 'ASK_USER_QUESTION_BATCH') {
          setPendingBatch(message.data);
          setPendingQuestion(null);
          setMainTab('apply');
        } else if (message && message.type === 'LIVE_ACTIVITY_UPDATE' && message.data) {
          const act = message.data;
          setActivityItems(prev => {
            const idx = prev.findIndex(item => item.jobId === act.jobId);
            const newItem: StructuredActivityItem = {
              id: act.jobId || String(Date.now()),
              jobId: act.jobId,
              url: act.url,
              title: act.title,
              company: act.company,
              status: act.status,
              reason: act.reason,
              creditsUsed: act.creditsUsed,
              timestamp: Date.now(),
            };
            if (idx >= 0) {
              const copy = [...prev];
              copy[idx] = newItem;
              return copy;
            }
            return [newItem, ...prev.slice(0, 49)];
          });
        } else if (message && message.type === 'AUTH_REQUIRED') {
          setIsApplying(false);
          setShowAuthRequiredBanner(true);
          setActiveStatusText(message.error || message.message || 'Session expired. Please sign in again.');
        } else if (message && message.type === 'LINKEDIN_STATUS_UPDATE') {
          if (message.text) {
            setActiveStatusText(message.text);
            const lowerText = message.text.toLowerCase();
            if (
              lowerText.includes('stopped') ||
              lowerText.includes('window was closed') ||
              lowerText.includes('already in progress') ||
              lowerText.includes('quota reached') ||
              lowerText.includes('insufficient credit') ||
              lowerText.includes('timeout') ||
              lowerText.includes('pausing') ||
              lowerText.includes('paused') ||
              lowerText.includes('additional verification') ||
              lowerText.includes('session expired') ||
              lowerText.includes('auth_required') ||
              lowerText.includes('sign in again')
            ) {
              setIsApplying(false);
            }
            setAppliedLogs(prev => {
              if (
                prev.length > 0 &&
                (prev[0].text === message.text ||
                  (message.text.includes('Application stopped by user') &&
                    prev.some(item => item.text.includes('Application stopped by user'))))
              ) {
                return prev;
              }
              return [
                {
                  id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
                  text: message.text,
                  status: message.status || 'info',
                  timestamp: Date.now(),
                },
                ...prev.slice(0, 99),
              ];
            });
          }
        } else if (message && message.type === 'LINKEDIN_RUN_FINISHED') {
          setIsApplying(false);
          if (message.summary) {
            setActiveStatusText(message.summary);
            setAppliedLogs(prev => {
              if (
                prev.length > 0 &&
                (prev[0].text === message.summary ||
                  (message.summary.includes('Application stopped by user') &&
                    prev.some(item => item.text.includes('Application stopped by user'))))
              ) {
                return prev;
              }
              return [
                {
                  id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
                  text: message.summary,
                  status: 'ok',
                  timestamp: Date.now(),
                },
                ...prev.slice(0, 99),
              ];
            });
          }
        } else if (message && message.type === 'heartbeat_ack') {
          console.log('Heartbeat acknowledged');
        }
      });

      portRef.current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Connection disconnected', error ? `Error: ${error.message}` : '');
        portRef.current = null;
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        setInputEnabled(true);
        setShowStopButton(false);
      });

      // Setup heartbeat interval
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (portRef.current?.name === 'side-panel-connection') {
          try {
            portRef.current.postMessage({ type: 'heartbeat' });
          } catch (error) {
            console.error('Heartbeat failed:', error);
            stopConnection(); // Stop connection if heartbeat fails
          }
        } else {
          stopConnection(); // Stop if port is invalid
        }
      }, 25000);
    } catch (error) {
      console.error('Failed to establish connection:', error);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_conn_serviceWorker'),
        timestamp: Date.now(),
      });
      // Clear any references since connection failed
      portRef.current = null;
    }
  }, [handleTaskState, appendMessage, stopConnection]);

  // Automatically connect side panel port on mount
  useEffect(() => {
    setupConnection();
  }, [setupConnection]);

  // Add safety check for message sending
  const sendMessage = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (message: any) => {
      if (portRef.current?.name !== 'side-panel-connection') {
        throw new Error('No valid connection available');
      }
      try {
        portRef.current.postMessage(message);
      } catch (error) {
        console.error('Failed to send message:', error);
        stopConnection(); // Stop connection when message sending fails
        throw error;
      }
    },
    [stopConnection],
  );

  // Handle replay command
  const handleReplay = async (historySessionId: string): Promise<void> => {
    try {
      // Check if replay is enabled in settings
      if (!replayEnabled) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_disabled'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check if history exists using loadAgentStepHistory
      const historyData = await chatHistoryStore.loadAgentStepHistory(historySessionId);
      if (!historyData) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_noHistory', historySessionId.substring(0, 20)),
          timestamp: Date.now(),
        });
        return;
      }

      // Get current tab ID
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      // Clear messages if we're in a historical session
      if (isHistoricalSession) {
        setMessages([]);
      }

      // Create a new chat session for this replay task
      const newSession = await chatHistoryStore.createSession(`Replay of ${historySessionId.substring(0, 20)}...`);
      console.log('newSession for replay', newSession);

      // Store the new session ID in both state and ref
      const newTaskId = newSession.id;
      setCurrentSessionId(newTaskId);
      sessionIdRef.current = newTaskId;

      // Send replay command to background
      setInputEnabled(false);
      setShowStopButton(true);

      // Reset follow-up mode and historical session flags
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);

      const userMessage = {
        actor: Actors.USER,
        content: `/replay ${historySessionId}`,
        timestamp: Date.now(),
      };

      // Add the user message to the new session
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send replay command to background with the task from history
      portRef.current?.postMessage({
        type: 'replay',
        taskId: newTaskId,
        tabId: tabId,
        historySessionId: historySessionId,
        task: historyData.task, // Add the task from history
      });

      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_starting', historyData.task),
        timestamp: Date.now(),
      });
      setIsReplaying(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_failed', errorMessage),
        timestamp: Date.now(),
      });
    }
  };

  // Handle chat commands that start with /
  const handleCommand = async (command: string): Promise<boolean> => {
    try {
      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Handle different commands
      if (command === '/state') {
        portRef.current?.postMessage({
          type: 'state',
        });
        return true;
      }

      if (command === '/nohighlight') {
        portRef.current?.postMessage({
          type: 'nohighlight',
        });
        return true;
      }

      if (command.startsWith('/replay ')) {
        // Parse replay command: /replay <historySessionId>
        // Handle multiple spaces by filtering out empty strings
        const parts = command.split(' ').filter(part => part.trim() !== '');
        if (parts.length !== 2) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: t('chat_replay_invalidArgs'),
            timestamp: Date.now(),
          });
          return true;
        }

        const historySessionId = parts[1];
        await handleReplay(historySessionId);
        return true;
      }

      // Unsupported command
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_cmd_unknown', command),
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Command error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      return true;
    }
  };

  const handleCopilotSendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Check copilot tier access (future-proof subscription)
    const access = await checkCopilotAccess();
    if (!access.allowed) {
      setCopilotMessages(prev => [
        ...prev,
        {
          actor: Actors.SYSTEM,
          content: access.reason || 'Upgrade to Pro to unlock Career Copilot.',
          timestamp: Date.now(),
        },
      ]);
      return;
    }

    // 1. Add user message
    const userMsg: Message = {
      actor: Actors.USER,
      content: trimmed,
      timestamp: Date.now(),
    };
    setCopilotMessages(prev => [...prev, userMsg]);
    setIsCopilotTyping(true);

    // 2. Prepare chat history
    const history = copilotMessages
      .filter(m => m.actor === Actors.USER || m.actor === Actors.COPILOT)
      .slice(-6)
      .map(m => ({
        role: (m.actor === Actors.USER ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      }));

    // 3. Dispatch to background service worker
    chrome.runtime.sendMessage(
      {
        type: 'CAREER_COPILOT_CHAT',
        userMessage: trimmed,
        chatHistory: history,
      },
      (res: any) => {
        setIsCopilotTyping(false);
        if (chrome.runtime.lastError || !res?.success) {
          const errorText = res?.error || chrome.runtime.lastError?.message || 'Failed to connect to Career Copilot.';
          setCopilotMessages(prev => [
            ...prev,
            {
              actor: Actors.COPILOT,
              content: `⚠️ Error: ${errorText}`,
              timestamp: Date.now(),
            },
          ]);
          return;
        }

        const copilotResponse = res.response;
        let actionCard: any = undefined;

        if (copilotResponse.actionType === 'update' && copilotResponse.updatedFields) {
          actionCard = {
            type: 'profile_updated',
            title: 'Career Brain Updated',
            data: {
              updatedFields: copilotResponse.updatedFields,
              profileCompleteness: copilotResponse.profileCompleteness,
            },
          };
          refreshCopilotAudit();
        } else if (copilotResponse.actionType === 'job_fit' && copilotResponse.fitReport) {
          actionCard = {
            type: 'job_fit',
            title: 'Job Match Report',
            data: {
              fitReport: copilotResponse.fitReport,
            },
          };
        } else if (copilotResponse.actionType === 'pitch') {
          actionCard = {
            type: 'pitch',
            title: 'Recruiter Pitch',
            data: {
              pitch: copilotResponse.reply.replace(/\*\*/g, '').trim(),
            },
          };
        } else if (copilotResponse.actionType === 'cover_letter' && copilotResponse.coverLetter) {
          actionCard = {
            type: 'cover_letter',
            title: 'Tailored Cover Letter',
            data: {
              coverLetter: copilotResponse.coverLetter,
            },
          };
        }

        const assistantMsg: Message = {
          actor: Actors.COPILOT,
          content: copilotResponse.reply,
          timestamp: Date.now(),
          metadata: {
            actionCard,
            quickOptions: copilotResponse.quickOptions,
          },
        };

        setCopilotMessages(prev => [...prev, assistantMsg]);
      },
    );
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    console.log('handleSendMessage', text);

    // Trim the input text first
    const trimmedText = text.trim();

    if (!trimmedText) return;

    if (chatMode === 'copilot') {
      await handleCopilotSendMessage(trimmedText);
      return;
    }

    // Check if user is authenticated before sending task (fresh check from storage)
    const session = await authStorage.getSession();
    setAuthSession(session);

    if (!session?.token) {
      openJobformSignIn();
      appendMessage({
        actor: Actors.SYSTEM,
        content: 'Please log in with JobForm Automator to start executing AI browser tasks with NanoBrowser.',
        timestamp: Date.now(),
      });
      return;
    }

    // Check Premium monthly task usage quota
    const usageStatus = await cloudApiSettingsStore.checkUsageLimit();
    if (!usageStatus.allowed) {
      appendMessage({
        actor: Actors.SYSTEM,
        content: `Monthly Premium task limit reached (${usageStatus.count}/${usageStatus.limit} tasks). Please switch to Free Mode or upgrade your plan in Settings.`,
        timestamp: Date.now(),
      });
      return;
    }

    // Check if the input is a command (starts with /)
    if (trimmedText.startsWith('/')) {
      // Process command and return if it was handled
      const wasHandled = await handleCommand(trimmedText);
      if (wasHandled) return;
    }

    // Block sending messages in historical sessions
    if (isHistoricalSession) {
      console.log('Cannot send messages in historical sessions');
      return;
    }

    // Increment usage for premium tasks
    await cloudApiSettingsStore.incrementUsage();

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      setInputEnabled(false);
      setShowStopButton(true);

      // Create a new chat session for this task if not in follow-up mode
      if (!isFollowUpMode) {
        // Use display text for session title if available, otherwise use full text
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );
        console.log('newSession', newSession);

        // Store the session ID in both state and ref
        const sessionId = newSession.id;
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text, // Use display text for chat UI, full text for background service
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send message using the utility function
      if (isFollowUpMode) {
        // Send as follow-up task
        await sendMessage({
          type: 'follow_up_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
        });
        console.log('follow_up_task sent', text, tabId, sessionIdRef.current);
      } else {
        // Send as new task
        await sendMessage({
          type: 'new_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
        });
        console.log('new_task sent', text, tabId, sessionIdRef.current);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
      setShowStopButton(false);
      setIsFollowUpMode(false);
      stopConnection();
    }
  };

  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handleStartAutoApply = useCallback(
    async (platform: 'linkedin' | 'naukri' | 'indeed' = 'linkedin') => {
      // PART 2: UI Gate - Session check and refresh
      let currentSession = await authStorage.getSession();
      if (!currentSession?.token && currentSession?.refreshToken) {
        const refreshedToken = await backendApiClient.refreshAccessToken();
        if (refreshedToken) {
          currentSession = await authStorage.getSession();
        }
      }

      if (!currentSession?.token) {
        const authMsg = 'Authentication required. Please sign in to start applying.';
        setShowAuthRequiredBanner(true);
        setActiveStatusText(authMsg);
        setAppliedLogs(prev => [
          {
            id: String(Date.now()),
            text: `🔒 ${authMsg}`,
            status: 'fail',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
        setIsApplying(false);
        openJobformSignIn();
        return;
      }

      try {
        const brain = await careerBrainStore.getCareerBrain();
        const check = validateProfileCompleteness(brain);
        if (!check.isValid) {
          const msg = `⚠️ Incomplete profile. Missing required fields: ${check.missingFields.join(', ')}. Please complete your profile in the "Resume & Profile" tab before applying.`;
          setActiveStatusText(msg);
          setAppliedLogs(prev => [
            {
              id: String(Date.now()),
              text: msg,
              status: 'fail',
              timestamp: Date.now(),
            },
            ...prev,
          ]);
          setMainTab('resume');
          return;
        }
      } catch {}

      try {
        const pauseStatus = await queueSafetyStore.getPlatformPause(platform);
        if (pauseStatus.isPaused) {
          const pauseMsg =
            pauseStatus.reason ||
            `${platform === 'indeed' ? 'Indeed' : platform} auto-apply is paused for today to protect your account.`;
          setActiveStatusText(pauseMsg);
          setAppliedLogs(prev => [
            {
              id: String(Date.now()),
              text: `⏸️ ${pauseMsg}`,
              status: 'fail',
              timestamp: Date.now(),
            },
            ...prev,
          ]);
          return;
        }
      } catch {}

      if (!portRef.current) {
        setupConnection();
      }

      const platformName = platform === 'naukri' ? 'Naukri.com' : platform === 'indeed' ? 'Indeed' : 'LinkedIn';
      setIsApplying(true);
      setActiveStatusText(`Initializing autonomous search and apply loop on ${platformName}...`);
      setAppliedLogs(prev => [
        {
          id: String(Date.now()),
          text: `🚀 Starting Auto Apply loop on ${platformName}...`,
          status: 'info',
          timestamp: Date.now(),
        },
        ...prev,
      ]);

      try {
        portRef.current?.postMessage({ type: 'START_AUTO_APPLY', platform });
      } catch (err) {
        console.error('Failed to post START_AUTO_APPLY:', err);
        setIsApplying(false);
        setActiveStatusText('Failed to start application run.');
      }
    },
    [setupConnection],
  );

  const handleStopLinkedInApply = useCallback(() => {
    setIsApplying(false);
    setActiveStatusText('Application stopped by user.');
    setPendingQuestion(null);
    setPendingBatch(null);
    setAppliedLogs(prev => {
      if (prev.some(item => item.text.includes('Application stopped by user'))) return prev;
      return [
        {
          id: String(Date.now()),
          text: '⏹️ Application stopped by user.',
          status: 'info',
          timestamp: Date.now(),
        },
        ...prev,
      ];
    });
    try {
      portRef.current?.postMessage({ type: 'STOP_AUTO_APPLY' });
    } catch {}
    chrome.runtime.sendMessage({ type: 'STOP_JOB_APPLY' });
  }, []);

  const handleAnswerQuestion = useCallback(
    (questionId: string, answer: string) => {
      if (!portRef.current) {
        setupConnection();
      }
      portRef.current?.postMessage({
        type: 'USER_QUESTION_ANSWER',
        data: { questionId, answer },
      });
      setPendingQuestion(null);
    },
    [setupConnection],
  );

  const handleAnswerQuestionBatch = useCallback(
    (batchId: string, answers: Record<string, string>) => {
      if (!portRef.current) {
        setupConnection();
      }
      portRef.current?.postMessage({
        type: 'USER_QUESTION_BATCH_ANSWER',
        data: { batchId, answers },
      });
      setPendingBatch(null);
    },
    [setupConnection],
  );

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);

    // Disconnect any existing connection
    stopConnection();
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setMessages(fullSession.messages);
        setIsFollowUpMode(false);
        setIsHistoricalSession(true); // Mark this as a historical session
        console.log('history session selected', sessionId);
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);

      if (fullSession && fullSession.messages.length > 0) {
        // Get the session title
        const sessionTitle = fullSession.title;
        // Get the first 8 words of the title
        const title = sessionTitle.split(' ').slice(0, 8).join(' ');

        // Get the first message content (the task)
        const taskContent = fullSession.messages[0]?.content || '';

        // Add to favorites storage
        await favoritesStorage.addPrompt(title, taskContent);

        // Update favorites in the UI
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);

        // Return to chat view after pinning
        handleBackToChat(true);
      }
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (setInputTextRef.current) {
      setInputTextRef.current(content);
    }
  };

  const handleBookmarkUpdateTitle = async (id: number, title: string) => {
    try {
      await favoritesStorage.updatePromptTitle(id, title);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt title:', error);
    }
  };

  const handleBookmarkDelete = async (id: number) => {
    try {
      await favoritesStorage.removePrompt(id);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to delete favorite prompt:', error);
    }
  };

  const handleBookmarkReorder = async (draggedId: number, targetId: number) => {
    try {
      // Directly pass IDs to storage function - it now handles the reordering logic
      await favoritesStorage.reorderPrompts(draggedId, targetId);

      // Fetch the updated list from storage to get the new IDs and reflect the authoritative order
      const updatedPromptsFromStorage = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(updatedPromptsFromStorage);
    } catch (error) {
      console.error('Failed to reorder favorite prompts:', error);
    }
  };

  // Load favorite prompts from storage
  useEffect(() => {
    const loadFavorites = async () => {
      try {
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);
      } catch (error) {
        console.error('Failed to load favorite prompts:', error);
      }
    };

    loadFavorites();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording if active
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear recording timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      stopConnection();
    };
  }, [stopConnection]);

  // Scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleMicClick = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear the timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }

    try {
      // First check if permission is already granted
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

      if (permissionStatus.state === 'denied') {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_stt_microphone_permissionDenied'),
          timestamp: Date.now(),
        });
        return;
      }

      // If permission is not granted, open permission page
      if (permissionStatus.state !== 'granted') {
        const permissionUrl = chrome.runtime.getURL('permission/index.html');

        // Open permission page in a new window
        chrome.windows.create(
          {
            url: permissionUrl,
            type: 'popup',
            width: 500,
            height: 600,
          },
          createdWindow => {
            if (createdWindow?.id) {
              // Listen for window close to check permission status
              chrome.windows.onRemoved.addListener(function onWindowClose(windowId) {
                if (windowId === createdWindow.id) {
                  chrome.windows.onRemoved.removeListener(onWindowClose);
                  // Check permission status after window closes
                  setTimeout(async () => {
                    try {
                      const newPermissionStatus = await navigator.permissions.query({
                        name: 'microphone' as PermissionName,
                      });
                      // Only retry if permission was granted
                      if (newPermissionStatus.state === 'granted') {
                        handleMicClick();
                      }
                      // If denied or prompt, do nothing - let user manually try again
                    } catch (error) {
                      console.error('Failed to check permission status:', error);
                    }
                  }, 500);
                }
              });
            }
          },
        );
        return;
      }

      // Permission granted - proceed with recording
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Clear previous audio chunks
      audioChunksRef.current = [];

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      // Handle data available event
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle stop event
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());

        if (audioChunksRef.current.length > 0) {
          // Create audio blob
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          // Convert blob to base64
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Audio = reader.result as string;

            // Setup connection if not exists
            if (!portRef.current) {
              setupConnection();
            }

            // Send audio to backend for speech-to-text conversion
            try {
              setIsProcessingSpeech(true);
              portRef.current?.postMessage({
                type: 'speech_to_text',
                audio: base64Audio,
              });
            } catch (error) {
              console.error('Failed to send audio for speech-to-text:', error);
              appendMessage({
                actor: Actors.SYSTEM,
                content: t('chat_stt_processingFailed'),
                timestamp: Date.now(),
              });
              setIsRecording(false);
              setIsProcessingSpeech(false);
            }
          };
          reader.readAsDataURL(audioBlob);
        }
      };

      // Set up 2-minute duration limit
      const maxDuration = 2 * 60 * 1000;
      recordingTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        setIsProcessingSpeech(true);
        recordingTimerRef.current = null;
      }, maxDuration);

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);

      let errorMessage = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          errorMessage += t('chat_stt_microphone_grantPermission');
        } else if (error.name === 'NotFoundError') {
          errorMessage += t('chat_stt_microphone_notFound');
        } else {
          errorMessage += error.message;
        }
      }

      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setIsRecording(false);
    }
  };

  return (
    <div>
      <div
        className={`flex h-screen flex-col ${isDarkMode ? 'bg-slate-900' : "bg-[url('/bg.jpg')] bg-cover bg-no-repeat"} overflow-hidden border ${isDarkMode ? 'border-sky-800' : 'border-[rgb(186,230,253)]'} rounded-2xl`}>
        <header className="header relative">
          <div className="header-logo flex items-center space-x-2">
            {showHistory ? (
              <button
                type="button"
                onClick={() => handleBackToChat(false)}
                className={`${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-400 hover:text-sky-500'} cursor-pointer`}
                aria-label={t('nav_back_a11y')}>
                {t('nav_back')}
              </button>
            ) : (
              <>
                <img src="/icon-128.png" alt="Extension Logo" className="size-6" />
                {authSession?.token && authSession.user ? (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span
                      className="flex items-center gap-1 font-semibold text-sky-600 dark:text-sky-400"
                      title={`${authSession.user.name} (${authSession.user.email})`}>
                      <FiUser className="size-3.5 text-sky-500 dark:text-sky-400" />
                      {authSession.user.name.split(' ')[0]}
                      {isPremiumActive(authSession.premium) && (
                        <span
                          className="inline-flex size-4 items-center justify-center rounded-full bg-violet-600 text-white"
                          title={`JobForm Automator ${authSession.premium?.tier} (verified by the server)`}
                          aria-label={`JobForm Automator ${authSession.premium?.tier}`}
                          data-premium-tier={authSession.premium?.tier}>
                          <FiStar className="size-2.5" />
                        </span>
                      )}
                    </span>
                    {userCredits && (
                      <button
                        type="button"
                        onClick={() => setIsPlansModalOpen(true)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-300 hover:border-blue-500/50 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors"
                        title="View NanoBrowser Subscription & Credits">
                        <FiZap className="size-2.5 text-indigo-500" />
                        <span>{userCredits.remainingCredits.toLocaleString()}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setIsPlansModalOpen(true)}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-blue-600 hover:bg-blue-700 px-2 py-0.5 text-[11px] font-semibold text-white shadow-xs transition-colors"
                      title="View NanoBrowser Subscription Plans">
                      <span>Upgrade</span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        // Signs NanoBrowser out only: the JobForm Automator website session is untouched
                        // (no token revocation, no request to the website). Website pages then don't sign
                        // NanoBrowser back in until "Login with JobForm Automator" is clicked.
                        backendApiClient.logout();
                        await endAccountSession({ pauseWebsiteAutoLogin: true });
                        setAuthSession(null);
                        setUserCredits(null);
                      }}
                      title="Sign Out"
                      className="cursor-pointer p-1 text-slate-400 transition-colors hover:text-red-500 rounded-md">
                      <FiLogOut className="size-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                        const res = await chrome.runtime
                          .sendMessage({ type: 'SYNC_JOBFORM_SESSION' })
                          .catch(() => null);
                        if (res?.ok) return;
                      }
                      openJobformSignIn();
                    }}
                    title="Login with JobForm Automator"
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 px-3 py-1 text-xs font-semibold text-white shadow-xs transition-colors">
                    <FiUser className="size-3.5" />
                    <span>Login</span>
                  </button>
                )}
              </>
            )}
          </div>
          <div className="header-icons">
            {!showHistory && authSession?.token && (
              <>
                <button
                  type="button"
                  onClick={handleNewChat}
                  onKeyDown={e => e.key === 'Enter' && handleNewChat()}
                  className={`header-icon ${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-400 hover:text-sky-500'} cursor-pointer`}
                  aria-label={t('nav_newChat_a11y')}
                  tabIndex={0}>
                  <PiPlusBold size={20} />
                </button>
                <button
                  type="button"
                  onClick={handleLoadHistory}
                  onKeyDown={e => e.key === 'Enter' && handleLoadHistory()}
                  className={`header-icon ${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-400 hover:text-sky-500'} cursor-pointer`}
                  aria-label={t('nav_loadHistory_a11y')}
                  tabIndex={0}>
                  <GrHistory size={20} />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => chrome.runtime.openOptionsPage()}
              onKeyDown={e => e.key === 'Enter' && chrome.runtime.openOptionsPage()}
              className={`header-icon ${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-400 hover:text-sky-500'} cursor-pointer`}
              aria-label={t('nav_settings_a11y')}
              tabIndex={0}>
              <FiSettings size={20} />
            </button>
          </div>
        </header>

        {/* Session Expired / Auth Required Banner */}
        {showAuthRequiredBanner && (
          <div
            data-testid="auth-required-banner"
            className="mx-3 my-2 p-3 rounded-xl border text-xs bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-300 flex items-center justify-between gap-3 shadow-sm">
            <div className="flex items-center gap-2.5 min-w-0">
              <FiLock className="size-4 shrink-0 text-red-500" />
              <div className="min-w-0">
                <div className="font-bold text-xs text-red-800 dark:text-red-200">
                  Session expired. Please sign in again.
                </div>
                <div className="text-[11px] opacity-80 truncate">
                  Authentication is required to run automated job applications.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowAuthRequiredBanner(false);
                openJobformSignIn();
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-500 shadow-sm cursor-pointer transition-all shrink-0">
              Sign in
            </button>
          </div>
        )}

        {/* Failed Refund Audit Notice */}
        <FailedRefundBanner notices={failedRefundNotice} onDismiss={() => setFailedRefundNotice(null)} />

        {/* Navigation Tabs - ONLY SHOWN WHEN AUTHENTICATED */}
        {!showHistory && authSession?.token && (
          <div
            className={`flex border-b text-xs font-semibold shrink-0 ${isDarkMode ? 'border-sky-900 bg-slate-800/90' : 'border-sky-100 bg-white/90 shadow-sm'}`}>
            <button
              onClick={() => setMainTab('apply')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-2.5 transition-colors cursor-pointer border-b-2 ${
                mainTab === 'apply'
                  ? 'border-sky-500 text-sky-400 font-bold bg-sky-500/10'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}>
              <FiBriefcase className="size-3.5" />
              <span>Job Apply</span>
            </button>
            <button
              onClick={() => setMainTab('resume')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-2.5 transition-colors cursor-pointer border-b-2 ${
                mainTab === 'resume'
                  ? 'border-sky-500 text-sky-400 font-bold bg-sky-500/10'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}>
              <FiFileText className="size-3.5" />
              <span>Resume & Profile</span>
            </button>
            <button
              onClick={() => setMainTab('chat')}
              className={`flex-1 flex items-center justify-center space-x-1.5 py-2.5 transition-colors cursor-pointer border-b-2 ${
                mainTab === 'chat'
                  ? 'border-sky-500 text-sky-400 font-bold bg-sky-500/10'
                  : 'border-transparent opacity-70 hover:opacity-100'
              }`}>
              <FiMessageSquare className="size-3.5" />
              <span>AI Chat</span>
            </button>
          </div>
        )}

        {isAuthLoading ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="size-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          </div>
        ) : !authSession?.token ? (
          <AuthGateView isDarkMode={isDarkMode} />
        ) : showHistory ? (
          <div className="flex-1 overflow-hidden">
            <ChatHistoryList
              sessions={chatSessions}
              onSessionSelect={handleSessionSelect}
              onSessionDelete={handleSessionDelete}
              onSessionBookmark={handleSessionBookmark}
              visible={true}
              isDarkMode={isDarkMode}
            />
          </div>
        ) : mainTab === 'apply' ? (
          <LinkedInApplyDashboard
            isDarkMode={isDarkMode}
            onStartAutoApply={handleStartAutoApply}
            onStop={handleStopLinkedInApply}
            onOpenAuthModal={openJobformSignIn}
            onOpenPlansModal={() => setIsPlansModalOpen(true)}
            isApplying={isApplying}
            activeStatusText={activeStatusText}
            appliedLogs={appliedLogs}
            activityItems={activityItems}
            pendingQuestion={pendingQuestion}
            onAnswerQuestion={handleAnswerQuestion}
            pendingBatch={pendingBatch}
            onAnswerQuestionBatch={handleAnswerQuestionBatch}
          />
        ) : mainTab === 'resume' ? (
          <ResumeProfileView isDarkMode={isDarkMode} />
        ) : (
          <>
            {/* Show loading state while checking model configuration */}
            {hasConfiguredModels === null && (
              <div
                className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-sky-300' : 'text-sky-600'}`}>
                <div className="text-center">
                  <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-sky-400 border-t-transparent"></div>
                  <p>{t('status_checkingConfig')}</p>
                </div>
              </div>
            )}

            {/* Show setup message when no models are configured */}
            {hasConfiguredModels === false && (
              <div
                className={`flex flex-1 items-center justify-center p-8 ${isDarkMode ? 'text-sky-300' : 'text-sky-600'}`}>
                <div className="max-w-md text-center">
                  <img src="/icon-128.png" alt="Nanobrowser Logo" className="mx-auto mb-4 size-12" />
                  <h3 className={`mb-2 text-lg font-semibold ${isDarkMode ? 'text-sky-200' : 'text-sky-700'}`}>
                    {t('welcome_title')}
                  </h3>
                  <p className="mb-4 text-xs opacity-90">
                    Sign in to connect to NanoBrowser Cloud API (AWS Bedrock Nova & Credits Engine) or configure custom
                    local keys in Settings.
                  </p>

                  {!authSession?.token ? (
                    <button
                      onClick={openJobformSignIn}
                      className="my-2 w-full cursor-pointer rounded-lg bg-gradient-to-r from-sky-500 to-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-lg transition-all hover:from-sky-600 hover:to-indigo-700">
                      Login with JobForm Automator
                    </button>
                  ) : (
                    <div className="my-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-xs font-semibold text-sky-400">
                      Logged in as {authSession.user?.email} ({userCredits?.remainingCredits || 0} credits available)
                    </div>
                  )}

                  <button
                    onClick={() => chrome.runtime.openOptionsPage()}
                    className={`my-2 w-full cursor-pointer rounded-lg px-4 py-2 text-xs font-medium transition-colors ${
                      isDarkMode
                        ? 'bg-slate-700 text-white hover:bg-slate-600'
                        : 'bg-slate-200 text-slate-800 hover:bg-slate-300'
                    }`}>
                    {t('welcome_openSettings')}
                  </button>
                  <div className="mt-4 text-sm opacity-75">
                    <a
                      href="https://github.com/nanobrowser/nanobrowser?tab=readme-ov-file#-quick-start"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-700 hover:text-sky-600'}`}>
                      {t('welcome_quickStart')}
                    </a>
                    <span className="mx-2">•</span>
                    <a
                      href="https://discord.gg/NN3ABHggMK"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`${isDarkMode ? 'text-sky-400 hover:text-sky-300' : 'text-sky-700 hover:text-sky-600'}`}>
                      {t('welcome_joinCommunity')}
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* Show normal chat interface when models are configured */}
            {hasConfiguredModels === true && (
              <>
                {/* DUAL MODE SELECTOR HEADER */}
                <div
                  className={`flex items-center justify-between border-b px-3 py-2 shrink-0 ${
                    isDarkMode ? 'border-sky-900 bg-slate-800/80' : 'border-sky-100 bg-slate-50'
                  }`}>
                  <div className="flex items-center space-x-1 rounded-lg border border-slate-700/50 bg-slate-900/60 p-0.5">
                    <button
                      type="button"
                      onClick={() => setChatMode('agent')}
                      className={`flex cursor-pointer items-center space-x-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${
                        chatMode === 'agent' ? 'bg-sky-500 text-white shadow-sm' : 'text-slate-400 hover:text-slate-200'
                      }`}>
                      <span>🌐 Web Agent</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setChatMode('copilot')}
                      className={`flex cursor-pointer items-center space-x-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-all ${
                        chatMode === 'copilot'
                          ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-sm'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}>
                      <span>✨ 🧠 Career Copilot</span>
                      <span className="rounded bg-purple-400/25 px-1 py-0.2 text-[9px] font-bold uppercase tracking-wider text-purple-200">
                        Pro
                      </span>
                    </button>
                  </div>

                  {chatMode === 'copilot' && copilotAudit && (
                    <div className="flex items-center space-x-1.5 text-[11px] font-semibold">
                      <span className="opacity-70">Readiness:</span>
                      <span
                        className={`font-bold ${
                          copilotAudit.score >= 80
                            ? 'text-emerald-400'
                            : copilotAudit.score >= 50
                              ? 'text-amber-400'
                              : 'text-rose-400'
                        }`}>
                        {copilotAudit.score}%
                      </span>
                    </div>
                  )}
                </div>

                {chatMode === 'copilot' ? (
                  <>
                    {/* Career Copilot Mode View */}
                    {copilotMessages.length === 0 ? (
                      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
                        {/* Futuristic Hero Card */}
                        <div
                          className={`rounded-2xl border p-4 shadow-lg transition-all ${
                            isDarkMode
                              ? 'border-purple-500/30 bg-gradient-to-br from-purple-950/40 via-slate-900 to-slate-900 text-purple-100'
                              : 'border-purple-200 bg-gradient-to-br from-purple-50 via-white to-indigo-50/50 text-purple-950'
                          }`}>
                          <div className="flex items-center space-x-2">
                            <span className="text-xl">✨</span>
                            <h3 className="font-extrabold text-sm tracking-wide bg-gradient-to-r from-purple-400 to-indigo-400 bg-clip-text text-transparent">
                              AI Career Copilot Pro
                            </h3>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed opacity-85">
                            Your personal AI career intelligence copilot. Audits missing profile details, evaluates live
                            job fit on open tabs, and generates high-converting recruiter pitches.
                          </p>

                          {/* Live Readiness Meter */}
                          <div className="mt-3.5 rounded-xl border border-purple-500/20 bg-purple-500/10 p-3">
                            <div className="flex items-center justify-between text-xs font-bold">
                              <span>Profile Readiness</span>
                              <span className="text-purple-300">{copilotAudit?.score ?? 0}% Complete</span>
                            </div>
                            <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-800/80">
                              <div
                                className="h-full rounded-full bg-gradient-to-r from-purple-500 to-indigo-400 transition-all duration-700"
                                style={{ width: `${copilotAudit?.score ?? 0}%` }}
                              />
                            </div>
                            {copilotAudit?.missingFields?.[0] && (
                              <p className="mt-2 text-[11px] font-medium text-purple-200/90 flex items-center space-x-1">
                                <span className="text-amber-400 font-bold">⚡ Priority:</span>
                                <span>{copilotAudit.missingFields[0].promptQuestion}</span>
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Quick Action Prompt Cards */}
                        <div className="space-y-1.5 pt-1">
                          <span className="text-[10px] uppercase font-bold tracking-wider opacity-60">
                            Quick Actions:
                          </span>
                          <div className="grid grid-cols-1 gap-2">
                            <button
                              type="button"
                              onClick={() => handleSendMessage('Audit my profile')}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-left text-xs font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer ${
                                isDarkMode
                                  ? 'border-slate-800 bg-slate-800/70 hover:border-purple-500/50 hover:bg-purple-950/20 text-slate-200'
                                  : 'border-slate-200 bg-white hover:border-purple-300 hover:bg-purple-50/50 text-slate-800 shadow-sm'
                              }`}>
                              <div className="flex items-center space-x-2.5">
                                <span className="text-base">🔍</span>
                                <div>
                                  <div className="font-bold">Audit Profile & Missing Info</div>
                                  <div className="text-[10px] font-normal opacity-70">
                                    Check completeness & fill missing screening fields
                                  </div>
                                </div>
                              </div>
                              <span className="text-purple-400">→</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleSendMessage('Check fit for open job page')}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-left text-xs font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer ${
                                isDarkMode
                                  ? 'border-slate-800 bg-slate-800/70 hover:border-purple-500/50 hover:bg-purple-950/20 text-slate-200'
                                  : 'border-slate-200 bg-white hover:border-purple-300 hover:bg-purple-50/50 text-slate-800 shadow-sm'
                              }`}>
                              <div className="flex items-center space-x-2.5">
                                <span className="text-base">🎯</span>
                                <div>
                                  <div className="font-bold">Check Fit for Current Tab Job</div>
                                  <div className="text-[10px] font-normal opacity-70">
                                    Scrape active job tab & calculate skills match score
                                  </div>
                                </div>
                              </div>
                              <span className="text-purple-400">→</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleSendMessage('Draft tailored recruiter pitch')}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-left text-xs font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer ${
                                isDarkMode
                                  ? 'border-slate-800 bg-slate-800/70 hover:border-purple-500/50 hover:bg-purple-950/20 text-slate-200'
                                  : 'border-slate-200 bg-white hover:border-purple-300 hover:bg-purple-50/50 text-slate-800 shadow-sm'
                              }`}>
                              <div className="flex items-center space-x-2.5">
                                <span className="text-base">📝</span>
                                <div>
                                  <div className="font-bold">Draft Tailored Recruiter Note</div>
                                  <div className="text-[10px] font-normal opacity-70">
                                    High-converting 3-sentence application pitch
                                  </div>
                                </div>
                              </div>
                              <span className="text-purple-400">→</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleSendMessage('Start mock screening interview')}
                              className={`flex items-center justify-between p-2.5 rounded-xl border text-left text-xs font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer ${
                                isDarkMode
                                  ? 'border-slate-800 bg-slate-800/70 hover:border-purple-500/50 hover:bg-purple-950/20 text-slate-200'
                                  : 'border-slate-200 bg-white hover:border-purple-300 hover:bg-purple-50/50 text-slate-800 shadow-sm'
                              }`}>
                              <div className="flex items-center space-x-2.5">
                                <span className="text-base">🎙️</span>
                                <div>
                                  <div className="font-bold">Start Mock Recruiter Interview</div>
                                  <div className="text-[10px] font-normal opacity-70">
                                    Simulate screening questions with feedback
                                  </div>
                                </div>
                              </div>
                              <span className="text-purple-400">→</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll scroll-smooth p-2 ${
                          isDarkMode ? 'bg-slate-900/80' : ''
                        }`}>
                        <MessageList
                          messages={copilotMessages}
                          isDarkMode={isDarkMode}
                          onSelectOption={handleSendMessage}
                        />
                        {isCopilotTyping && (
                          <div className="flex items-center space-x-2 px-3 py-2 text-xs font-semibold text-purple-400 animate-pulse">
                            <div className="size-2 rounded-full bg-purple-400" />
                            <span>Career Copilot analyzing & formulating response...</span>
                          </div>
                        )}
                        <div ref={messagesEndRef} />
                      </div>
                    )}

                    {/* Copilot Input */}
                    <div
                      className={`border-t ${
                        isDarkMode ? 'border-sky-900' : 'border-sky-100'
                      } p-2 shadow-sm backdrop-blur-sm`}>
                      <ChatInput
                        onSendMessage={handleSendMessage}
                        onStopTask={handleStopTask}
                        onMicClick={handleMicClick}
                        isRecording={isRecording}
                        isProcessingSpeech={isProcessingSpeech}
                        disabled={isCopilotTyping}
                        showStopButton={false}
                        setContent={setter => {
                          setInputTextRef.current = setter;
                        }}
                        isDarkMode={isDarkMode}
                        placeholder="Ask about your profile, update details (e.g. 15 days notice), check job fit..."
                      />
                    </div>
                  </>
                ) : (
                  /* Web Agent Mode View (Original & Untouched) */
                  <>
                    {messages.length === 0 && (
                      <>
                        <div
                          className={`border-t ${isDarkMode ? 'border-sky-900' : 'border-sky-100'} mb-2 p-2 shadow-sm backdrop-blur-sm`}>
                          <ChatInput
                            onSendMessage={handleSendMessage}
                            onStopTask={handleStopTask}
                            onMicClick={handleMicClick}
                            isRecording={isRecording}
                            isProcessingSpeech={isProcessingSpeech}
                            disabled={!inputEnabled || isHistoricalSession}
                            showStopButton={showStopButton}
                            setContent={setter => {
                              setInputTextRef.current = setter;
                            }}
                            isDarkMode={isDarkMode}
                            historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
                            onReplay={handleReplay}
                          />
                        </div>
                        <div className="flex-1 overflow-y-auto">
                          <BookmarkList
                            bookmarks={favoritePrompts}
                            onBookmarkSelect={handleBookmarkSelect}
                            onBookmarkUpdateTitle={handleBookmarkUpdateTitle}
                            onBookmarkDelete={handleBookmarkDelete}
                            onBookmarkReorder={handleBookmarkReorder}
                            isDarkMode={isDarkMode}
                          />
                        </div>
                      </>
                    )}
                    {messages.length > 0 && (
                      <div
                        className={`scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll scroll-smooth p-2 ${isDarkMode ? 'bg-slate-900/80' : ''}`}>
                        <MessageList messages={messages} isDarkMode={isDarkMode} />
                        <div ref={messagesEndRef} />
                      </div>
                    )}
                    {messages.length > 0 && (
                      <div
                        className={`border-t ${isDarkMode ? 'border-sky-900' : 'border-sky-100'} p-2 shadow-sm backdrop-blur-sm`}>
                        <ChatInput
                          onSendMessage={handleSendMessage}
                          onStopTask={handleStopTask}
                          onMicClick={handleMicClick}
                          isRecording={isRecording}
                          isProcessingSpeech={isProcessingSpeech}
                          disabled={!inputEnabled || isHistoricalSession}
                          showStopButton={showStopButton}
                          setContent={setter => {
                            setInputTextRef.current = setter;
                          }}
                          isDarkMode={isDarkMode}
                          historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
                          onReplay={handleReplay}
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>

      <PremiumPlansModal
        isOpen={isPlansModalOpen}
        onClose={() => setIsPlansModalOpen(false)}
        isDarkMode={isDarkMode}
        userCredits={userCredits}
      />
    </div>
  );
};

export default SidePanel;
