import React, { useState } from 'react';
import { backendApiClient, launchGoogleWebAuthFlow } from '@extension/shared';
import { authStorage } from '@extension/storage';
import { FiLock, FiMail, FiUser, FiCheckCircle, FiShield, FiZap, FiFileText, FiBriefcase } from 'react-icons/fi';

interface AuthGateViewProps {
  isDarkMode?: boolean;
  onSuccess?: (user: any, token: string) => void;
}

export const AuthGateView: React.FC<AuthGateViewProps> = ({ isDarkMode = false, onSuccess }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    try {
      if (mode === 'register') {
        if (!name.trim()) throw new Error('Name is required');
        if (password.length < 8) throw new Error('Password must be at least 8 characters');

        const res = await backendApiClient.register({ name, email, password });
        if (res.data) {
          const authData = res.data;
          await authStorage.setSession({
            token: authData.token,
            refreshToken: authData.refreshToken,
            user: authData.user,
          });
          setSuccessMessage('Account registered successfully! Unlocking...');
          setTimeout(() => {
            onSuccess?.(authData.user, authData.token);
          }, 600);
        } else {
          throw new Error(res.error?.code || 'Registration failed');
        }
      } else {
        const res = await backendApiClient.login({ email, password });
        if (res.data) {
          const authData = res.data;
          await authStorage.setSession({
            token: authData.token,
            refreshToken: authData.refreshToken,
            user: authData.user,
          });
          setSuccessMessage('Signed in successfully! Unlocking...');
          setTimeout(() => {
            onSuccess?.(authData.user, authData.token);
          }, 600);
        } else {
          throw new Error(res.error?.code || 'Sign in failed');
        }
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setSuccessMessage(null);
    setLoading(true);

    try {
      const authData = await launchGoogleWebAuthFlow();
      await authStorage.setSession({
        token: authData.token,
        refreshToken: authData.refreshToken,
        user: authData.user,
        subscription: authData.subscription,
      });
      setSuccessMessage('Google sign-in successful! Unlocking...');
      setTimeout(() => {
        onSuccess?.(authData.user, authData.token);
      }, 600);
    } catch (err: any) {
      const errMsg = err.message || 'Google Sign-In failed';
      if (
        errMsg.includes('OAuth2 not granted or revoked') ||
        errMsg.includes('The user did not approve') ||
        errMsg.includes('User cancelled') ||
        errMsg.includes('closed the window')
      ) {
        setError('Google sign-in was cancelled by user.');
      } else if (errMsg.includes('Only one web auth flow is allowed') || errMsg.includes('already open')) {
        setError(
          'A Google sign-in window is already open. Check your open windows or taskbar, or reload the extension.',
        );
      } else {
        setError(errMsg);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className={`flex-1 flex flex-col justify-center items-center p-4 overflow-y-auto ${
        isDarkMode ? 'bg-slate-900 text-white' : 'bg-gray-50 text-gray-900'
      }`}>
      <div
        className={`w-full max-w-sm rounded-2xl p-6 shadow-xl border ${
          isDarkMode ? 'bg-slate-800/80 border-slate-700/80 backdrop-blur-sm' : 'bg-white border-gray-200'
        }`}>
        {/* App Header */}
        <div className="flex flex-col items-center text-center mb-5">
          <div className="size-14 rounded-2xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20 mb-3">
            <FiShield className="size-7 text-white" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">
            {mode === 'login' ? 'Sign In to Continue' : 'Create an Account'}
          </h2>
          <p className="text-xs text-gray-400 mt-1 max-w-[260px]">
            Log in or sign up to access Auto Apply, Resume Builder, and Career Copilot.
          </p>
        </div>

        {/* Feature Highlights Banner */}
        <div
          className={`mb-5 rounded-xl p-3 border text-xs space-y-1.5 ${
            isDarkMode
              ? 'bg-slate-900/60 border-slate-700/60 text-slate-300'
              : 'bg-sky-50/80 border-sky-100 text-sky-900'
          }`}>
          <div className="flex items-center gap-2">
            <FiBriefcase className="size-3.5 text-sky-400 shrink-0" />
            <span>Autonomous job apply on LinkedIn, Naukri & Indeed</span>
          </div>
          <div className="flex items-center gap-2">
            <FiFileText className="size-3.5 text-emerald-400 shrink-0" />
            <span>AI Resume parsing & tailored application forms</span>
          </div>
          <div className="flex items-center gap-2">
            <FiZap className="size-3.5 text-amber-400 shrink-0" />
            <span className="font-semibold text-amber-300">100 free credits + 5-day trial on signup</span>
          </div>
        </div>

        {/* Google Sign-In Button */}
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className={`w-full flex items-center justify-center gap-2.5 rounded-xl py-2.5 px-4 font-semibold text-xs border transition-all shadow-sm active:scale-[0.99] cursor-pointer mb-4 ${
            isDarkMode
              ? 'bg-slate-700 hover:bg-slate-600 border-slate-600 text-white'
              : 'bg-white hover:bg-gray-100 border-gray-300 text-gray-700'
          } disabled:opacity-50`}>
          <svg className="size-4" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          <span>Sign in with Google</span>
        </button>

        {/* Divider */}
        <div className="relative mb-4 flex items-center justify-center">
          <div className={`w-full border-t ${isDarkMode ? 'border-slate-700' : 'border-gray-200'}`} />
          <span
            className={`absolute px-2.5 text-[10px] uppercase font-bold tracking-wider ${
              isDarkMode ? 'bg-slate-800 text-gray-400' : 'bg-white text-gray-500'
            }`}>
            or with email
          </span>
        </div>

        {/* Tab Toggle */}
        <div
          className={`flex rounded-xl p-1 mb-4 text-xs font-semibold ${
            isDarkMode ? 'bg-slate-900/80' : 'bg-gray-100'
          }`}>
          <button
            type="button"
            onClick={() => {
              setMode('login');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-lg transition-all cursor-pointer ${
              mode === 'login'
                ? isDarkMode
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}>
            Sign In
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('register');
              setError(null);
            }}
            className={`flex-1 py-1.5 rounded-lg transition-all cursor-pointer ${
              mode === 'register'
                ? isDarkMode
                  ? 'bg-sky-500 text-white shadow-sm'
                  : 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-400 hover:text-gray-200'
            }`}>
            Register
          </button>
        </div>

        {/* Error / Success Feedback */}
        {error && (
          <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-xs text-red-400">
            {error}
          </div>
        )}
        {successMessage && (
          <div className="mb-3 flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-xs text-emerald-400">
            <FiCheckCircle className="size-4 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Credentials Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === 'register' && (
            <div>
              <label className="block text-[11px] font-semibold text-gray-400 mb-1">Full Name</label>
              <div className="relative">
                <FiUser className="absolute left-3 top-2.5 text-gray-400 size-3.5" />
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Alex Morgan"
                  required
                  className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition-colors ${
                    isDarkMode
                      ? 'border-slate-700 bg-slate-900 text-white focus:border-sky-500'
                      : 'border-gray-300 bg-gray-50 text-gray-900 focus:border-sky-500'
                  }`}
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Email Address</label>
            <div className="relative">
              <FiMail className="absolute left-3 top-2.5 text-gray-400 size-3.5" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="alex@company.com"
                required
                className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition-colors ${
                  isDarkMode
                    ? 'border-slate-700 bg-slate-900 text-white focus:border-sky-500'
                    : 'border-gray-300 bg-gray-50 text-gray-900 focus:border-sky-500'
                }`}
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-gray-400 mb-1">Password</label>
            <div className="relative">
              <FiLock className="absolute left-3 top-2.5 text-gray-400 size-3.5" />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className={`w-full rounded-xl border py-2 pl-9 pr-3 text-xs outline-none transition-colors ${
                  isDarkMode
                    ? 'border-slate-700 bg-slate-900 text-white focus:border-sky-500'
                    : 'border-gray-300 bg-gray-50 text-gray-900 focus:border-sky-500'
                }`}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center space-x-2 rounded-xl py-2.5 px-4 font-bold text-xs bg-gradient-to-r from-sky-500 to-indigo-600 text-white hover:from-sky-600 hover:to-indigo-700 shadow-md shadow-sky-500/20 active:scale-[0.99] cursor-pointer transition-all disabled:opacity-50">
            <span>{loading ? 'Processing...' : mode === 'login' ? 'Sign In' : 'Create Free Account'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
