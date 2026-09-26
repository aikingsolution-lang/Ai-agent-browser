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
        <Button variant="secondary" onClick={loadData} className="flex items-center gap-1.5 px-3 py-2 text-xs">
          <FiRefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* Total Processed */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Processed Jobs</span>
            <FiPlay className="size-4 text-sky-500" />
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-white">{totalCount}</div>
          <p className="text-xs text-gray-500">Total jobs evaluated</p>
        </div>

        {/* Dry Run / Applied Success */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Success / Ready</span>
            <FiCheckCircle className="size-4" />
          </div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{dryRunSuccessCount}</div>
          <p className="text-xs text-gray-500">Would apply / Applied</p>
        </div>

        {/* Average Fit Score */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-indigo-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Avg Fit Score</span>
            <FiTrendingUp className="size-4" />
          </div>
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{avgFitScore}%</div>
          <p className="text-xs text-gray-500">RAG profile alignment</p>
        </div>

        {/* Today's Safe Quota */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-amber-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Today's Quota</span>
            <FiClock className="size-4" />
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
        className={`rounded-xl border p-4 ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } flex flex-col justify-between gap-3 shadow-sm sm:flex-row sm:items-center`}>
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
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                statusFilter === f.id
                  ? 'shadow-xs bg-sky-600 text-white'
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
          <FiSearch className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search role or company..."
            className={`w-full rounded-lg border py-1.5 pl-9 pr-3 text-xs ${
              isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-800'
            } focus:outline-none focus:ring-1 focus:ring-sky-500`}
          />
        </div>
      </div>

      {/* Applications Table */}
      <div
        className={`overflow-hidden rounded-xl border shadow-sm ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        }`}>
        {filteredRecords.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            <FiAlertCircle className="mx-auto mb-2 size-8 text-gray-400" />
            <p className="text-sm font-medium">No application records found.</p>
            <p className="mt-1 text-xs">Run an Easy Apply task from the sidebar to populate data.</p>
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
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Role & Company</th>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Fit Score</th>
                  <th className="px-4 py-3">Outcome</th>
                  <th className="px-4 py-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {filteredRecords.map(rec => (
                  <tr
                    key={rec.id}
                    className={`cursor-pointer transition-colors hover:bg-gray-50/80 dark:hover:bg-slate-700/40 ${
                      selectedRecord?.id === rec.id ? 'bg-sky-50/50 dark:bg-sky-950/20' : ''
                    }`}
                    onClick={() => setSelectedRecord(rec)}>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500 dark:text-gray-400">
                      <div className="flex items-center gap-1.5">
                        <FiCalendar className="size-3.5 text-gray-400" />
                        {new Date(rec.timestamp).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-bold text-gray-900 dark:text-white">{rec.jobData.title}</div>
                      <div className="text-gray-500 dark:text-gray-400">{rec.jobData.company}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{rec.jobData.location || 'Remote'}</td>
                    <td className="px-4 py-3">
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
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          rec.wouldHaveApplied
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200'
                            : rec.blockedReason === 'skipped_low_fit'
                              ? 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'
                              : (rec.blockedReason || '').toLowerCase().includes('external') ||
                                  (rec.notes || '').toLowerCase().includes('external')
                                ? 'border border-dashed border-slate-300 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'
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
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setSelectedRecord(rec);
                        }}
                        className="rounded-md p-1 text-sky-600 hover:text-sky-700 dark:text-sky-400">
                        <FiChevronRight className="size-4" />
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
        <div className="backdrop-blur-xs fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            className={`max-h-[85vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-6 shadow-2xl ${
              isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'
            } space-y-4 text-left`}>
            <div className="flex items-center justify-between border-b border-gray-200 pb-3 dark:border-slate-700">
              <div>
                <span className="text-xs font-semibold uppercase text-gray-400">Application Record Details</span>
                <h3 className="text-lg font-bold">{selectedRecord.jobData.title}</h3>
                <p className="text-xs text-gray-500">
                  {selectedRecord.jobData.company} • {selectedRecord.jobData.location || 'Remote'}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setSelectedRecord(null)} className="px-2.5 py-1 text-xs">
                Close
              </Button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-3 dark:bg-slate-900/50">
                <div>
                  <span className="block text-gray-400">Fit Score:</span>
                  <span className="text-sm font-bold text-sky-600 dark:text-sky-400">
                    {selectedRecord.fitScore ? `${selectedRecord.fitScore}/100` : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="block text-gray-400">Status:</span>
                  <span className="font-semibold">
                    {selectedRecord.wouldHaveApplied
                      ? 'Dry Run Success (Ready to Apply)'
                      : selectedRecord.blockedReason || 'Needs Review'}
                  </span>
                </div>
              </div>

              {selectedRecord.notes && (
                <div>
                  <span className="mb-1 block font-semibold">Notes:</span>
                  <p className="rounded border border-gray-100 bg-gray-50 p-2.5 text-gray-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-gray-300">
                    {selectedRecord.notes}
                  </p>
                </div>
              )}

              {selectedRecord.screeningAnswers && selectedRecord.screeningAnswers.length > 0 && (
                <div>
                  <span className="mb-1.5 block font-semibold">Screening Questions & AI Answers:</span>
                  <div className="space-y-2">
                    {selectedRecord.screeningAnswers.map(
                      (sq: { questionText: string; userAnswer: string | null }, i: number) => (
                        <div
                          key={i}
                          className="rounded border border-gray-100 bg-gray-50 p-2.5 dark:border-slate-700 dark:bg-slate-900/40">
                          <div className="font-medium text-gray-800 dark:text-gray-200">Q: {sq.questionText}</div>
                          <div className="mt-1 font-semibold text-sky-600 dark:text-sky-400">
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
