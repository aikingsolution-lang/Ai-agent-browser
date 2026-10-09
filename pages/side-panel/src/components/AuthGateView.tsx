import React, { useEffect, useState } from 'react';
import { openJobformSignIn } from '@extension/shared';
import { FiExternalLink, FiLogIn, FiLoader } from 'react-icons/fi';

interface AuthGateViewProps {
  isDarkMode?: boolean;
}

/**
 * Shown while signed out. NanoBrowser has no login of its own: the user signs in on JobForm
 * Automator, and the website session reaches the extension automatically (verified by the backend
 * in the background), which replaces this view.
 */
export const AuthGateView: React.FC<AuthGateViewProps> = ({ isDarkMode = false }) => {
  const [opened, setOpened] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // Proactively check if any open JobForm Automator tab already has a candidate session
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SYNC_JOBFORM_SESSION' }).catch(() => undefined);
    }
  }, []);

  const handleLogin = async () => {
    setChecking(true);
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_JOBFORM_SESSION' });
        if (res?.ok) {
          setChecking(false);
          return;
        }
      }
    } catch {
      // Proceed to opening the sign-in page if query fails
    }
    setChecking(false);
    openJobformSignIn();
    setOpened(true);
  };

  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center overflow-y-auto p-4 ${
        isDarkMode ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'
      }`}>
      <div
        className={`w-full max-w-sm rounded-2xl border p-6 text-center shadow-xl ${
          isDarkMode ? 'border-slate-700/80 bg-slate-800/80' : 'border-gray-200 bg-white'
        }`}>
        <img src="/icon-128.png" alt="NanoBrowser" className="mx-auto mb-3 size-12" />
        <h2 className="text-lg font-bold tracking-tight">Sign in to NanoBrowser</h2>
        <p className={`mb-5 mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Use your JobForm Automator account.
        </p>

        <button
          type="button"
          onClick={handleLogin}
          disabled={checking}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-sky-500/20 transition-all hover:from-sky-600 hover:to-indigo-700 active:scale-[0.99] disabled:opacity-70">
          {checking ? (
            <>
              <FiLoader className="size-4 animate-spin" />
              <span>Checking session...</span>
            </>
          ) : (
            <>
              <FiLogIn className="size-4" />
              <span>Login with JobForm Automator</span>
              <FiExternalLink className="size-3.5 opacity-80" />
            </>
          )}
        </button>

        {opened && (
          <p role="status" className={`mt-3 text-[11px] ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Finish signing in on the JobForm Automator tab. NanoBrowser signs you in automatically.
          </p>
        )}
      </div>
    </div>
  );
};
