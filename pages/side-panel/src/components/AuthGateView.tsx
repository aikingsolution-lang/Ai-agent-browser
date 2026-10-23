import React, { useEffect, useState } from 'react';
import { JOBFORM_PRIVACY_URL, openJobformSignIn } from '@extension/shared';
import { FiExternalLink, FiLogIn, FiLoader } from 'react-icons/fi';

interface AuthGateViewProps {
  isDarkMode?: boolean;
}

/**
 * Shown while signed out. The extension has no login of its own: the user signs in on JobForm
 * Automator, and the website session reaches the extension automatically (verified by the backend
 * in the background), which replaces this view.
 */
export const AuthGateView: React.FC<AuthGateViewProps> = ({ isDarkMode = false }) => {
  const [status, setStatus] = useState<'idle' | 'opened' | 'different-account'>('idle');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // Adopt an open JobForm Automator tab's session of the same account (never lifts an
    // extension-only sign-out and never switches accounts).
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'SYNC_JOBFORM_SESSION' }).catch(() => undefined);
    }
  }, []);

  const handleLogin = async () => {
    setChecking(true);
    let differentAccount = false;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const res = await chrome.runtime.sendMessage({ type: 'SYNC_JOBFORM_SESSION', interactive: true });
        if (res?.ok) {
          setChecking(false);
          return;
        }
        differentAccount = res?.reason === 'different-account';
      }
    } catch {
      // Proceed to opening the sign-in page if query fails
    }
    setChecking(false);
    openJobformSignIn();
    setStatus(differentAccount ? 'different-account' : 'opened');
  };

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';

  return (
    <div
      className={`flex flex-1 flex-col items-center justify-center overflow-y-auto p-4 ${
        isDarkMode ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'
      }`}>
      <div
        className={`w-full max-w-sm rounded-2xl border p-6 text-center shadow-xl ${
          isDarkMode ? 'border-slate-700/80 bg-slate-800/80' : 'border-gray-200 bg-white'
        }`}>
        <img src="/icon-128.png" alt="JobForm Automator" className="mx-auto mb-3 size-12" />
        <h2 className="text-lg font-bold tracking-tight">Sign in to JobForm Automator</h2>
        <p className={`mb-5 mt-1 text-xs ${muted}`}>Use your JobForm Automator account.</p>

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

        {status === 'opened' && (
          <p role="status" className={`mt-3 text-[11px] ${muted}`}>
            Finish signing in on the JobForm Automator tab. The extension signs you in automatically.
          </p>
        )}
        {status === 'different-account' && (
          <p role="status" className="mt-3 text-[11px] text-amber-600">
            The JobForm Automator website is signed in with a different account than the one last used in this
            extension. To switch, sign out on the website and sign in again with the account you want.
          </p>
        )}

        <p className={`mt-5 text-left text-[11px] leading-relaxed ${muted}`}>
          To automate job applications, the extension reads the pages you ask it to work on and sends their content,
          your instructions and the résumé details needed to fill forms to the JobForm Automator AI service. Your résumé
          profile, job applications, AI responses and credit usage are stored with your account. By signing in, you
          agree to this use as described in our{' '}
          <a href={JOBFORM_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </div>
  );
};
