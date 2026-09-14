import React, { useState, useEffect } from 'react';
import { Button } from '@extension/ui';
import {
  FiTrendingUp,
  FiCheckCircle,
  FiPlay,
  FiAlertCircle,
  FiClock,
  FiSearch,
  FiRefreshCw,
  FiChevronRight,
  FiCalendar,
} from 'react-icons/fi';
import { dryRunStore, dailyQuotaStore, type IDryRunRecord, type DailyQuotaData } from '@extension/storage';

interface ApplicationAnalyticsProps {
  isDarkMode?: boolean;
}

export const ApplicationAnalytics: React.FC<ApplicationAnalyticsProps> = ({ isDarkMode = false }) => {
  const [records, setRecords] = useState<IDryRunRecord[]>([]);
  const [quota, setQuota] = useState<DailyQuotaData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedRecord, setSelectedRecord] = useState<IDryRunRecord | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [history, quotaData] = await Promise.all([dryRunStore.getDryRunHistory(), dailyQuotaStore.getQuotaData()]);
      setRecords(history || []);
      setQuota(quotaData);
    } catch (err) {
      console.error('Failed to load application analytics data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // Compute Metrics
  const totalCount = records.length;
  const dryRunSuccessCount = records.filter(r => r.wouldHaveApplied).length;
  const needsReviewCount = records.filter(r => !r.wouldHaveApplied && r.blockedReason !== 'skipped_low_fit').length;
  const skippedLowFitCount = records.filter(r => r.blockedReason === 'skipped_low_fit').length;

  const validScores = records.map(r => r.fitScore).filter((s): s is number => typeof s === 'number' && !isNaN(s));
  const avgFitScore =
    validScores.length > 0 ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : 0;

  // Filtered Records
  const filteredRecords = records.filter(rec => {
    // Status Filter
    if (statusFilter === 'SUCCESS' && !rec.wouldHaveApplied) return false;
    if (statusFilter === 'REVIEW' && (rec.wouldHaveApplied || rec.blockedReason === 'skipped_low_fit')) return false;
    if (statusFilter === 'SKIPPED' && rec.blockedReason !== 'skipped_low_fit') return false;

    // Search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const titleMatch = rec.jobData.title.toLowerCase().includes(q);
      const companyMatch = rec.jobData.company.toLowerCase().includes(q);
      const locationMatch = rec.jobData.location.toLowerCase().includes(q);
      return titleMatch || companyMatch || locationMatch;
    }

    return true;
  });

  return (
    <div className="space-y-6 text-left">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Easy Apply Applications Dashboard</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Track performance metrics, screening answers, fit scores, and application outcomes.
          </p>
        </div>
        <Button variant="secondary" onClick={loadData} className="flex items-center gap-1.5 text-xs px-3 py-2">
          <FiRefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Processed */}
        <div
          className={`p-4 rounded-xl border ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } shadow-sm space-y-1`}>
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Processed Jobs</span>
            <FiPlay className="w-4 h-4 text-sky-500" />
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{totalCount}</div>
          <p className="text-xs text-gray-500">Total jobs evaluated</p>
        </div>

        {/* Dry Run / Applied Success */}
        <div
          className={`p-4 rounded-xl border ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } shadow-sm space-y-1`}>
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Success / Ready</span>
            <FiCheckCircle className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{dryRunSuccessCount}</div>
          <p className="text-xs text-gray-500">Would apply / Applied</p>
        </div>

        {/* Average Fit Score */}
        <div
          className={`p-4 rounded-xl border ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } shadow-sm space-y-1`}>
          <div className="flex items-center justify-between text-indigo-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Avg Fit Score</span>
            <FiTrendingUp className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{avgFitScore}%</div>
          <p className="text-xs text-gray-500">RAG profile alignment</p>
        </div>

        {/* Today's Safe Quota */}
        <div
          className={`p-4 rounded-xl border ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } shadow-sm space-y-1`}>
          <div className="flex items-center justify-between text-amber-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Today's Quota</span>
            <FiClock className="w-4 h-4" />
          </div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {quota?.appliedCount || 0} / {quota?.maxDailyQuota || 15}
          </div>
          <p className="text-xs text-gray-500">
            {Math.max(0, (quota?.maxDailyQuota || 15) - (quota?.appliedCount || 0))} slots remaining
          </p>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div
        className={`p-4 rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3`}>
        {/* Status Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {[
            { id: 'ALL', label: `All (${totalCount})` },
            { id: 'SUCCESS', label: `Success (${dryRunSuccessCount})` },
            { id: 'REVIEW', label: `Needs Review (${needsReviewCount})` },
            { id: 'SKIPPED', label: `Low Fit (${skippedLowFitCount})` },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors shrink-0 ${
                statusFilter === f.id
                  ? 'bg-sky-600 text-white shadow-xs'
                  : isDarkMode
                    ? 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}>
              {f.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-64">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search role or company..."
            className={`w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border ${
              isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-800'
            } focus:outline-none focus:ring-1 focus:ring-sky-500`}
          />
        </div>
      </div>

      {/* Applications Table */}
      <div
        className={`rounded-xl border overflow-hidden shadow-sm ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        }`}>
        {filteredRecords.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            <FiAlertCircle className="w-8 h-8 mx-auto text-gray-400 mb-2" />
            <p className="text-sm font-medium">No application records found.</p>
            <p className="text-xs mt-1">Run an Easy Apply task from the sidebar to populate data.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`border-b font-semibold uppercase tracking-wider ${
                  isDarkMode
                    ? 'border-slate-700 bg-slate-900/50 text-gray-400'
                    : 'border-gray-200 bg-gray-50 text-gray-600'
                }`}>
                <tr>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Role & Company</th>
                  <th className="py-3 px-4">Location</th>
                  <th className="py-3 px-4">Fit Score</th>
                  <th className="py-3 px-4">Outcome</th>
                  <th className="py-3 px-4 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {filteredRecords.map(rec => (
                  <tr
                    key={rec.id}
                    className={`hover:bg-gray-50/80 dark:hover:bg-slate-700/40 transition-colors cursor-pointer ${
                      selectedRecord?.id === rec.id ? 'bg-sky-50/50 dark:bg-sky-950/20' : ''
                    }`}
                    onClick={() => setSelectedRecord(rec)}>
                    <td className="py-3 px-4 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <FiCalendar className="w-3.5 h-3.5 text-gray-400" />
                        {new Date(rec.timestamp).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-bold text-gray-900 dark:text-white">{rec.jobData.title}</div>
                      <div className="text-gray-500 dark:text-gray-400">{rec.jobData.company}</div>
                    </td>
                    <td className="py-3 px-4 text-gray-600 dark:text-gray-300">{rec.jobData.location || 'Remote'}</td>
                    <td className="py-3 px-4">
                      {typeof rec.fitScore === 'number' ? (
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-bold ${
                              rec.fitScore >= 75
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : rec.fitScore >= 50
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-red-500'
                            }`}>
                            {rec.fitScore}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          rec.wouldHaveApplied
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200'
                            : rec.blockedReason === 'skipped_low_fit'
                              ? 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'
                              : (rec.blockedReason || '').toLowerCase().includes('external') ||
                                  (rec.notes || '').toLowerCase().includes('external')
                                ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border border-dashed border-slate-300 dark:border-slate-700'
                                : (rec.blockedReason || '').toLowerCase().includes('duplicate') ||
                                    (rec.notes || '').toLowerCase().includes('duplicate')
                                  ? 'bg-gray-100 text-gray-500 dark:bg-slate-800 dark:text-gray-400'
                                  : 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200'
                        }`}>
                        {rec.wouldHaveApplied
                          ? '✅ Success (Dry-Run)'
                          : rec.blockedReason === 'skipped_low_fit'
                            ? '⏭️ Skipped (<75 fit)'
                            : (rec.blockedReason || '').toLowerCase().includes('external') ||
                                (rec.notes || '').toLowerCase().includes('external')
                              ? '🛡️ Skipped (External Site)'
                              : (rec.blockedReason || '').toLowerCase().includes('duplicate') ||
                                  (rec.notes || '').toLowerCase().includes('duplicate')
                                ? '⏭️ Skipped (Duplicate)'
                                : '⚠️ Needs Review'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedRecord(rec);
                        }}
                        className="text-sky-600 dark:text-sky-400 hover:text-sky-700 p-1 rounded-md">
                        <FiChevronRight className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Record Details Modal */}
      {selectedRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`max-w-xl w-full max-h-[85vh] overflow-y-auto rounded-2xl p-6 shadow-2xl border ${
              isDarkMode ? 'bg-slate-800 border-slate-700 text-gray-100' : 'bg-white border-gray-200 text-gray-900'
            } space-y-4 text-left`}>
            <div className="flex items-center justify-between pb-3 border-b border-gray-200 dark:border-slate-700">
              <div>
                <span className="text-xs uppercase font-semibold text-gray-400">Application Record Details</span>
                <h3 className="text-lg font-bold">{selectedRecord.jobData.title}</h3>
                <p className="text-xs text-gray-500">
                  {selectedRecord.jobData.company} • {selectedRecord.jobData.location || 'Remote'}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setSelectedRecord(null)} className="text-xs px-2.5 py-1">
                Close
              </Button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 p-3 bg-gray-50 dark:bg-slate-900/50 rounded-lg">
                <div>
                  <span className="text-gray-400 block">Fit Score:</span>
                  <span className="font-bold text-sm text-sky-600 dark:text-sky-400">
                    {selectedRecord.fitScore ? `${selectedRecord.fitScore}/100` : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400 block">Status:</span>
                  <span className="font-semibold">
                    {selectedRecord.wouldHaveApplied
                      ? 'Dry Run Success (Ready to Apply)'
                      : selectedRecord.blockedReason || 'Needs Review'}
                  </span>
                </div>
              </div>

              {selectedRecord.notes && (
                <div>
                  <span className="font-semibold block mb-1">Notes:</span>
                  <p className="p-2.5 bg-gray-50 dark:bg-slate-900/40 rounded border border-gray-100 dark:border-slate-700 text-gray-600 dark:text-gray-300">
                    {selectedRecord.notes}
                  </p>
                </div>
              )}

              {selectedRecord.screeningAnswers && selectedRecord.screeningAnswers.length > 0 && (
                <div>
                  <span className="font-semibold block mb-1.5">Screening Questions & AI Answers:</span>
                  <div className="space-y-2">
                    {selectedRecord.screeningAnswers.map(
                      (sq: { questionText: string; userAnswer: string | null }, i: number) => (
                        <div
                          key={i}
                          className="p-2.5 bg-gray-50 dark:bg-slate-900/40 rounded border border-gray-100 dark:border-slate-700">
                          <div className="font-medium text-gray-800 dark:text-gray-200">Q: {sq.questionText}</div>
                          <div className="text-sky-600 dark:text-sky-400 font-semibold mt-1">
                            A: {sq.userAnswer || '(Empty / Not filled)'}
                          </div>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApplicationAnalytics;
