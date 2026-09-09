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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-2xl p-6 text-white shadow-2xl relative max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-800 pb-4 mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <FiActivity className="text-purple-400" />
            LLM Proxy Usage History
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchUsage}
              disabled={loading}
              className="p-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs flex items-center gap-1 transition-colors">
              <FiRefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
              <FiX className="w-5 h-5" />
            </button>
          </div>
        </div>

        {error && (
          <div className="p-3 mb-4 rounded bg-red-900/40 border border-red-800 text-red-200 text-sm">{error}</div>
        )}

        <div className="flex-1 overflow-y-auto space-y-3 pr-1">
          {items.length === 0 && !loading ? (
            <div className="text-center py-10 text-gray-500 text-sm">No LLM proxy usage requests recorded yet.</div>
          ) : (
            items.map(item => (
              <div
                key={item._id || item.requestId}
                className="bg-gray-800/60 border border-gray-800 rounded-lg p-3 flex items-center justify-between text-xs">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-200 flex items-center gap-1">
                      <FiCpu className="text-blue-400" />
                      {item.model}
                    </span>
                    <span className="text-gray-500">• {item.provider}</span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold flex items-center gap-1 ${
                        item.status === 'SUCCESS'
                          ? 'bg-green-900/50 text-green-400 border border-green-800'
                          : item.status === 'PARTIAL'
                            ? 'bg-yellow-900/50 text-yellow-400 border border-yellow-800'
                            : 'bg-red-900/50 text-red-400 border border-red-800'
                      }`}>
                      {item.status === 'SUCCESS' ? <FiCheckCircle /> : <FiAlertCircle />}
                      {item.status}
                    </span>
                  </div>

                  <div className="text-gray-400 text-[11px] flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <FiClock className="w-3 h-3 text-gray-500" />
                      {new Date(item.createdAt).toLocaleTimeString()}
                    </span>
                    <span>Tokens: {item.totalTokens || 0}</span>
                    <span>Latency: {item.latencyMs || 0}ms</span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="font-bold text-amber-400 text-sm">
                    -{item.creditsDeducted} {item.creditsDeducted === 1 ? 'credit' : 'credits'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="border-t border-gray-800 pt-3 mt-4 flex items-center justify-between text-xs text-gray-400">
          <span>Total Requests: {total}</span>
          <span>Metered Server-Side</span>
        </div>
      </div>
    </div>
  );
};
