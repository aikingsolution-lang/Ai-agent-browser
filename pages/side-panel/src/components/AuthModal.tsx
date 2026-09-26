import React, { useState } from 'react';
import { backendApiClient } from '@extension/shared';
import { authStorage } from '@extension/storage';
import { FiLock, FiMail, FiUser, FiX, FiCheckCircle } from 'react-icons/fi';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (user: any, token: string) => void;
}

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  if (!isOpen) return null;

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
            user: authData.user,
          });
          setSuccessMessage('Account registered successfully!');
          setTimeout(() => {
            onSuccess(authData.user, authData.token);
            onClose();
          }, 800);
        }
      } else {
        const res = await backendApiClient.login({ email, password });
        if (res.data) {
          const authData = res.data;
          await authStorage.setSession({
            token: authData.token,
            user: authData.user,
          });
          setSuccessMessage('Logged in successfully!');
          setTimeout(() => {
            onSuccess(authData.user, authData.token);
            onClose();
          }, 800);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-6 text-white shadow-2xl">
        <button onClick={onClose} className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-white">
          <FiX className="size-5" />
        </button>

        <h2 className="mb-1 flex items-center gap-2 text-xl font-bold">
          <FiLock className="text-blue-500" />
          {mode === 'login' ? 'Sign In to NanoBrowser' : 'Create NanoBrowser Account'}
        </h2>
        <p className="mb-6 text-sm text-gray-400">
          Access cloud LLM proxy, credits engine, and commercial browser automation.
        </p>

        {/* Tab Selector */}
        <div className="mb-6 flex border-b border-gray-800">
          <button
            className={`border-b-2 px-4 pb-2 text-sm font-medium transition-colors ${
              mode === 'login'
                ? 'border-blue-500 font-semibold text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
            onClick={() => {
              setMode('login');
              setError(null);
            }}>
            Sign In
          </button>
          <button
            className={`border-b-2 px-4 pb-2 text-sm font-medium transition-colors ${
              mode === 'register'
                ? 'border-blue-500 font-semibold text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
            onClick={() => {
              setMode('register');
              setError(null);
            }}>
            Create Account
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">{error}</div>
        )}

        {successMessage && (
          <div className="mb-4 flex items-center gap-2 rounded border border-green-800 bg-green-900/40 p-3 text-sm text-green-200">
            <FiCheckCircle className="text-green-400" />
            {successMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase text-gray-400">Full Name</label>
              <div className="relative">
                <FiUser className="absolute left-3 top-3 text-gray-500" />
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Alex Morgan"
                  required
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-10 pr-4 text-sm text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>
          )}

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-400">Email Address</label>
            <div className="relative">
              <FiMail className="absolute left-3 top-3 text-gray-500" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="alex@company.com"
                required
                className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-10 pr-4 text-sm text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase text-gray-400">Password</label>
            <div className="relative">
              <FiLock className="absolute left-3 top-3 text-gray-500" />
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full rounded-lg border border-gray-700 bg-gray-800 py-2 pl-10 pr-4 text-sm text-white placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="mt-2 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:opacity-50">
            {loading ? 'Processing...' : mode === 'login' ? 'Sign In' : 'Register Account'}
          </button>
        </form>
      </div>
    </div>
  );
};
