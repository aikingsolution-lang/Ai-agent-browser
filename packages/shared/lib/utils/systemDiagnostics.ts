/**
 * First-run / Diagnostic health checker for NanoBrowser Chrome Extension.
 *
 * Verifies:
 * 1. Backend API reachability & health probe
 * 2. Auth & Session status
 * 3. Career Brain profile completeness
 * 4. Required permissions & Chrome version
 */

import { BACKEND_API_URL } from '../config';
import { backendApiClient } from '../backend-api-client';
import { authStorage, careerBrainStore, validateProfileCompleteness } from '@extension/storage';

export interface SystemDiagnosticsReport {
  timestamp: string;
  isReadyToApply: boolean;
  chromeVersion: {
    version: string;
    isSupported: boolean;
  };
  api: {
    url: string;
    isReachable: boolean;
    status: number | null;
    error?: string;
  };
  auth: {
    isSignedIn: boolean;
    userEmail?: string;
    tier?: string;
    remainingCredits?: number;
  };
  profile: {
    isValid: boolean;
    missingFields: string[];
    skillsCount: number;
    hasResume: boolean;
  };
  permissions: {
    hasStorage: boolean;
    hasDebugger: boolean;
    hasSidePanel: boolean;
  };
  actionableAdvice: string[];
}

export async function runSystemDiagnostics(): Promise<SystemDiagnosticsReport> {
  const report: SystemDiagnosticsReport = {
    timestamp: new Date().toISOString(),
    isReadyToApply: true,
    chromeVersion: {
      version: 'unknown',
      isSupported: true,
    },
    api: {
      url: BACKEND_API_URL,
      isReachable: false,
      status: null,
    },
    auth: {
      isSignedIn: false,
    },
    profile: {
      isValid: false,
      missingFields: [],
      skillsCount: 0,
      hasResume: false,
    },
    permissions: {
      hasStorage: Boolean(chrome?.storage?.local),
      hasDebugger: Boolean(chrome?.debugger),
      hasSidePanel: Boolean(chrome?.sidePanel),
    },
    actionableAdvice: [],
  };

  // 1. Chrome Version check
  const uaMatch = navigator.userAgent.match(/Chrome\/(\d+)/);
  if (uaMatch && uaMatch[1]) {
    const major = parseInt(uaMatch[1], 10);
    report.chromeVersion.version = uaMatch[1];
    report.chromeVersion.isSupported = major >= 116;
    if (major < 116) {
      report.isReadyToApply = false;
      report.actionableAdvice.push('Update Google Chrome to version 116 or higher for Side Panel support.');
    }
  }

  // 2. API Reachability check
  try {
    const health = await backendApiClient.checkHealth();
    report.api.isReachable = health.status === 'ok' || (health as any).success === true;
    report.api.status = 200;
  } catch (err: any) {
    report.api.isReachable = false;
    report.api.status = err?.status || null;
    report.api.error = err?.message || 'Connection refused';
    report.actionableAdvice.push(
      `Backend API unreachable at ${BACKEND_API_URL}. Check network connection or Cloud Run status.`,
    );
  }

  // 3. Auth & Session status
  try {
    const session = await authStorage.getSession();
    if (session?.token) {
      report.auth.isSignedIn = true;
      report.auth.userEmail = session.user?.email || 'Authenticated user';
      report.auth.tier = session.premium?.tier || session.subscription?.planCode || 'Free';
      report.auth.remainingCredits = session.credits?.remainingCredits;
    } else {
      report.isReadyToApply = false;
      report.actionableAdvice.push('Sign in via JobForm Automator / extension to enable autonomous applications.');
    }
  } catch {}

  // 4. Career Brain Profile completeness
  try {
    const brain = await careerBrainStore.getCareerBrain();
    const check = validateProfileCompleteness(brain);
    report.profile.isValid = check.isValid;
    report.profile.missingFields = check.missingFields;
    report.profile.skillsCount = (brain.skills || []).length;
    report.profile.hasResume = Boolean(brain.resumeFileName || (brain.resumes && brain.resumes.length > 0));

    if (!check.isValid) {
      report.isReadyToApply = false;
      report.actionableAdvice.push(
        `Complete required profile fields: ${check.missingFields.join(', ')} in Resume & Profile tab.`,
      );
    }
    if (!report.profile.hasResume) {
      report.actionableAdvice.push('Upload your resume PDF in the Resume & Profile tab for accurate matching.');
    }
  } catch {}

  return report;
}
