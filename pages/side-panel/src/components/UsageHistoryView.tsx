import React, { useState, useEffect } from 'react';
import { backendApiClient } from '@extension/shared';
import { FiActivity, FiX, FiRefreshCw, FiClock, FiCpu, FiCheckCircle, FiAlertCircle } from 'react-icons/fi';

interface UsageHistoryViewProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UsageHistoryView: React.FC<UsageHistoryViewProps> = ({ isOpen, onClose }) => {
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await backendApiClient.getLlmUsage(1, 20);
      if (res.data) {
        setItems(res.data.items || []);
        setTotal(res.data.total || 0);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch LLM usage history');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchUsage();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-gray-800 bg-gray-900 p-6 text-white shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-gray-800 pb-4">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <FiActivity className="text-purple-400" />
            LLM Proxy Usage History
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchUsage}
              disabled={loading}
              className="flex items-center gap-1 rounded-lg bg-gray-800 p-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-700">
              <FiRefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={onClose} className="p-1 text-gray-400 hover:text-white">
              <FiX className="size-5" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-800 bg-red-900/40 p-3 text-sm text-red-200">{error}</div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto pr-1">
          {items.length === 0 && !loading ? (
            <div className="py-10 text-center text-sm text-gray-500">No LLM proxy usage requests recorded yet.</div>
          ) : (
            items.map(item => (
              <div
                key={item._id || item.requestId}
                className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-800/60 p-3 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1 font-semibold text-gray-200">
                      <FiCpu className="text-blue-400" />
                      {item.model}
                    </span>
                    <span className="text-gray-500">• {item.provider}</span>
                    <span
                      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-bold ${
                        item.status === 'SUCCESS'
                          ? 'border border-green-800 bg-green-900/50 text-green-400'
                          : item.status === 'PARTIAL'
                            ? 'border border-yellow-800 bg-yellow-900/50 text-yellow-400'
                            : 'border border-red-800 bg-red-900/50 text-red-400'
                      }`}>
                      {item.status === 'SUCCESS' ? <FiCheckCircle /> : <FiAlertCircle />}
                      {item.status}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-gray-400">
                    <span className="flex items-center gap-1">
                      <FiClock className="size-3 text-gray-500" />
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </span>
                    <span>Tokens: {item.totalTokens || 0}</span>
                    <span>Latency: {item.latencyMs || 0}ms</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-sm font-bold text-amber-400">
                    -{item.creditsDeducted} {item.creditsDeducted === 1 ? 'credit' : 'credits'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-gray-800 pt-3 text-xs text-gray-400">
          <span>Total Requests: {total}</span>
          <span>Metered Server-Side</span>
        </div>
      </div>
    </div>
  );
};
