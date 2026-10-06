import React, { useState, useEffect } from 'react';
import { Button } from '@extension/ui';
import {
  FiTrendingUp,
  FiCheckCircle,
  FiPlay,
  FiAlertCircle,
  FiSearch,
  FiRefreshCw,
  FiChevronRight,
  FiDownload,
  FiCheck,
  FiExternalLink,
  FiTrash2,
} from 'react-icons/fi';
import {
  dryRunStore,
  dailyQuotaStore,
  processedJobsStore,
  exportApplicationsToCsv,
  detectPlatformFromUrl,
  type ExportableJobRecord,
  type DailyQuotaData,
} from '@extension/storage';

interface ApplicationAnalyticsProps {
  isDarkMode?: boolean;
}

export const ApplicationAnalytics: React.FC<ApplicationAnalyticsProps> = ({ isDarkMode = false }) => {
  const [records, setRecords] = useState<ExportableJobRecord[]>([]);
  const [quota, setQuota] = useState<DailyQuotaData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('APPLIED');
  const [platformFilter, setPlatformFilter] = useState<string>('ALL');
  const [selectedRecord, setSelectedRecord] = useState<ExportableJobRecord | null>(null);
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [processed, dryRun, quotaData] = await Promise.all([
        processedJobsStore.getAllRecords().catch(() => []),
        dryRunStore.getDryRunHistory().catch(() => []),
        dailyQuotaStore.getQuotaData().catch(() => null),
      ]);

      const unified: ExportableJobRecord[] = [];
      const seenKeys = new Set<string>();

      // 1. Processed Jobs from actual runner (live applications & early skips)
      for (const r of processed || []) {
        const key = `${r.jobId || r.url}_${r.timestamp}`;
        seenKeys.add(key);
        unified.push({
          id: `live_${r.jobId}_${r.timestamp}`,
          jobId: r.jobId,
          title: r.title || 'Job Listing',
          company: r.company || 'Unknown Company',
          location: r.location || 'Remote / Unspecified',
          platform: r.platform || detectPlatformFromUrl(r.url),
          status: r.status,
          reason: r.reason || '',
          fitScore: typeof r.fitScore === 'number' ? r.fitScore : null,
          creditsUsed: r.creditsUsed ?? (r.status === 'applied' ? 1 : 0),
          url: r.url,
          timestamp: r.timestamp || Date.now(),
        });
      }

      // 2. Dry run evaluation records
      for (const dr of dryRun || []) {
        const key = `${dr.jobData.jobId || dr.jobData.url}_${dr.timestamp}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const status = dr.wouldHaveApplied
            ? 'dry_run_success'
            : dr.blockedReason === 'skipped_low_fit'
              ? 'skipped'
              : 'needs_review';

          unified.push({
            id: `dry_${dr.id}`,
            jobId: dr.jobData.jobId,
            title: dr.jobData.title || 'Job Listing',
            company: dr.jobData.company || 'Unknown Company',
            location: dr.jobData.location || 'Remote',
            platform: detectPlatformFromUrl(dr.jobData.url),
            status,
            reason: dr.blockedReason || dr.notes || '',
            fitScore: typeof dr.fitScore === 'number' ? dr.fitScore : null,
            creditsUsed: 0,
            url: dr.jobData.url,
            timestamp: dr.timestamp || Date.now(),
            screeningAnswers: dr.screeningAnswers?.map(a => ({
              questionText: a.questionText,
              userAnswer: a.userAnswer,
            })),
          });
        }
      }

      // Sort descending by timestamp (freshest first)
      unified.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(unified);
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
  const appliedRecords = records.filter(r => r.status === 'applied' || r.status === 'dry_run_success');
  const appliedCount = appliedRecords.length;

  const validScores = appliedRecords
    .map(r => r.fitScore)
    .filter((s): s is number => typeof s === 'number' && !isNaN(s));
  const avgFitScore =
    validScores.length > 0 ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : 0;

  // Filtered Records
  const filteredRecords = records.filter(rec => {
    // Status Filter (Default to Applied)
    if (statusFilter === 'APPLIED') {
      if (rec.status !== 'applied' && rec.status !== 'dry_run_success') return false;
    }

    // Platform Filter
    if (platformFilter !== 'ALL') {
      const recPlatform = (rec.platform || detectPlatformFromUrl(rec.url)).toLowerCase();
      if (recPlatform !== platformFilter.toLowerCase()) return false;
    }

    // Search query
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const titleMatch = (rec.title || '').toLowerCase().includes(q);
      const companyMatch = (rec.company || '').toLowerCase().includes(q);
      const reasonMatch = (rec.reason || '').toLowerCase().includes(q);
      return titleMatch || companyMatch || reasonMatch;
    }

    return true;
  });

  // 1-Click Export of ONLY Applied Jobs
  const handleExportApplied = () => {
    if (appliedCount === 0) {
      setExportFeedback('No applied jobs to export yet.');
      setTimeout(() => setExportFeedback(null), 2500);
      return;
    }

    const success = exportApplicationsToCsv(appliedRecords, 'JobPilot_Applied_Jobs');

    if (success) {
      setExportFeedback(`Exported ${appliedCount} Applied Jobs to CSV!`);
      setTimeout(() => setExportFeedback(null), 3000);
    } else {
      setExportFeedback('Export failed');
      setTimeout(() => setExportFeedback(null), 2500);
    }
  };

  const handleClearHistory = async () => {
    if (window.confirm('Are you sure you want to clear your local job application history? This cannot be undone.')) {
      await Promise.all([
        processedJobsStore.clearRecords().catch(() => {}),
        dryRunStore.clearDryRunHistory().catch(() => {}),
      ]);
      await loadData();
    }
  };

  return (
    <div className="space-y-6 text-left">
      {/* Header with Title and Export Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Applied Jobs Dashboard</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Review your verified job submissions and 1-click export your applied jobs spreadsheet.
          </p>
        </div>

        <div className="relative flex items-center gap-2">
          {/* Refresh Button */}
          <Button variant="secondary" onClick={loadData} className="flex items-center gap-1.5 px-3 py-2 text-xs">
            <FiRefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>

          {/* 1-Click Export Applied Jobs Button */}
          <button
            type="button"
            onClick={handleExportApplied}
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-95 cursor-pointer">
            <FiDownload className="size-3.5" />
            <span>Export Applied Jobs ({appliedCount})</span>
          </button>

          {/* Clear History */}
          {records.length > 0 && (
            <button
              type="button"
              onClick={handleClearHistory}
              title="Clear Local History"
              className="rounded-lg border border-gray-200 p-2 text-gray-400 hover:border-red-300 hover:text-red-500 dark:border-slate-700 dark:hover:border-red-800 cursor-pointer">
              <FiTrash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Export Feedback Banner */}
      {exportFeedback && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800 shadow-sm dark:bg-emerald-950/40 dark:text-emerald-300">
          <FiCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <span>{exportFeedback}</span>
        </div>
      )}

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Applied / Success */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400">
            <span className="text-xs font-semibold uppercase tracking-wider">Applied Jobs</span>
            <FiCheckCircle className="size-4" />
          </div>
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{appliedCount}</div>
          <p className="text-xs text-gray-500">Successfully submitted & verified</p>
        </div>

        {/* Average Fit Score */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-indigo-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Average Match Fit</span>
            <FiTrendingUp className="size-4" />
          </div>
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{avgFitScore}%</div>
          <p className="text-xs text-gray-500">Candidate & JD alignment</p>
        </div>

        {/* Today's Safe Quota */}
        <div
          className={`rounded-xl border p-4 ${
            isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
          } space-y-1 shadow-sm`}>
          <div className="flex items-center justify-between text-amber-500">
            <span className="text-xs font-semibold uppercase tracking-wider">Today's Daily Quota</span>
            <FiPlay className="size-4" />
          </div>
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {quota?.appliedCount || 0} / {quota?.maxDailyQuota || 15}
          </div>
          <p className="text-xs text-gray-500">
            {Math.max(0, (quota?.maxDailyQuota || 15) - (quota?.appliedCount || 0))} submissions remaining today
          </p>
        </div>
      </div>

      {/* Filter, Platform & Search Bar */}
      <div
        className={`rounded-xl border p-4 ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } flex flex-col justify-between gap-3 shadow-sm md:flex-row md:items-center`}>
        {/* Status Toggle Buttons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatusFilter('APPLIED')}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition cursor-pointer ${
              statusFilter === 'APPLIED'
                ? 'bg-emerald-600 text-white shadow-xs'
                : isDarkMode
                  ? 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
            Applied Jobs ({appliedCount})
          </button>
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition cursor-pointer ${
              statusFilter === 'ALL'
                ? 'bg-sky-600 text-white shadow-xs'
                : isDarkMode
                  ? 'bg-slate-700 text-gray-300 hover:bg-slate-600'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}>
            All Evaluated ({totalCount})
          </button>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Platform Filter Dropdown */}
          <div className="relative">
            <select
              value={platformFilter}
              onChange={e => setPlatformFilter(e.target.value)}
              className={`rounded-lg border py-1.5 pl-2.5 pr-7 text-xs ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-200' : 'border-gray-300 bg-white text-gray-800'
              } focus:outline-none focus:ring-1 focus:ring-sky-500`}>
              <option value="ALL">All Platforms</option>
              <option value="linkedin">LinkedIn</option>
              <option value="naukri">Naukri</option>
              <option value="indeed">Indeed</option>
            </select>
          </div>

          {/* Search Input */}
          <div className="relative w-full sm:w-60">
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
      </div>

      {/* Applied Applications Table (Streamlined: No Date, Location, Credits, or Screening Q&A) */}
      <div
        className={`overflow-hidden rounded-xl border shadow-sm ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        }`}>
        {filteredRecords.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            <FiAlertCircle className="mx-auto mb-2 size-8 text-gray-400" />
            <p className="text-sm font-medium">No applied job records found.</p>
            <p className="mt-1 text-xs">Run an Easy Apply task from the sidebar to populate applied jobs.</p>
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
                  <th className="px-4 py-3">Platform</th>
                  <th className="px-4 py-3">Job Title & Company</th>
                  <th className="px-4 py-3">Fit Score</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Outcome / Reason</th>
                  <th className="px-4 py-3">Posting</th>
                  <th className="px-4 py-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                {filteredRecords.map(rec => {
                  const platformName = rec.platform || detectPlatformFromUrl(rec.url);
                  const isSuccess = rec.status === 'applied' || rec.status === 'dry_run_success';

                  return (
                    <tr
                      key={rec.id}
                      className={`cursor-pointer transition-colors hover:bg-gray-50/80 dark:hover:bg-slate-700/40 ${
                        selectedRecord?.id === rec.id ? 'bg-sky-50/50 dark:bg-sky-950/20' : ''
                      }`}
                      onClick={() => setSelectedRecord(rec)}>
                      {/* Platform Badge */}
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                            platformName.toLowerCase() === 'linkedin'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200'
                              : platformName.toLowerCase() === 'naukri'
                                ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200'
                                : platformName.toLowerCase() === 'indeed'
                                  ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/50 dark:text-indigo-200'
                                  : 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-gray-300'
                          }`}>
                          {platformName}
                        </span>
                      </td>

                      {/* Role & Company */}
                      <td className="px-4 py-3">
                        <div className="font-bold text-gray-900 dark:text-white">{rec.title}</div>
                        <div className="text-gray-500 dark:text-gray-400">{rec.company}</div>
                      </td>

                      {/* Fit Score */}
                      <td className="px-4 py-3">
                        {typeof rec.fitScore === 'number' ? (
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
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      {/* Status Badge */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                            isSuccess
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200'
                              : rec.status === 'skipped'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200'
                                : 'bg-rose-100 text-rose-800 dark:bg-rose-900/60 dark:text-rose-200'
                          }`}>
                          {isSuccess ? '✅ Applied' : rec.status === 'skipped' ? '⏭️ Skipped' : '⚠️ Failed'}
                        </span>
                      </td>

                      {/* Outcome / Reason */}
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 max-w-xs truncate">
                        {rec.reason || 'Successfully submitted via Easy Apply'}
                      </td>

                      {/* Job URL Link */}
                      <td className="px-4 py-3">
                        {rec.url ? (
                          <a
                            href={rec.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="inline-flex items-center gap-1 font-medium text-sky-600 hover:underline dark:text-sky-400">
                            <span>Link</span>
                            <FiExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      {/* Details Arrow */}
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            setSelectedRecord(rec);
                          }}
                          className="rounded-md p-1 text-sky-600 hover:text-sky-700 dark:text-sky-400 cursor-pointer">
                          <FiChevronRight className="size-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Record Details Modal */}
      {selectedRecord && (
        <div className="backdrop-blur-xs fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            className={`max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border p-6 shadow-2xl ${
              isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'
            } space-y-4 text-left`}>
            {/* Modal Header */}
            <div className="flex items-start justify-between border-b border-gray-200 pb-3 dark:border-slate-700">
              <div>
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {selectedRecord.platform || detectPlatformFromUrl(selectedRecord.url)} Application Record
                </span>
                <h3 className="text-lg font-bold">{selectedRecord.title}</h3>
                <p className="text-xs text-gray-500">{selectedRecord.company}</p>
              </div>
              <Button variant="secondary" onClick={() => setSelectedRecord(null)} className="px-2.5 py-1 text-xs">
                Close
              </Button>
            </div>

            {/* Modal Content */}
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-3 dark:bg-slate-900/50">
                <div>
                  <span className="block text-gray-400">Match Fit Score:</span>
                  <span className="text-sm font-bold text-sky-600 dark:text-sky-400">
                    {typeof selectedRecord.fitScore === 'number' ? `${selectedRecord.fitScore}%` : 'N/A'}
                  </span>
                </div>
                <div>
                  <span className="block text-gray-400">Application Status:</span>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                    {selectedRecord.status === 'applied' || selectedRecord.status === 'dry_run_success'
                      ? 'Applied'
                      : selectedRecord.status}
                  </span>
                </div>
              </div>

              {/* Job URL Link */}
              {selectedRecord.url && (
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-gray-400">Posting URL:</span>
                  <a
                    href={selectedRecord.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 font-medium text-sky-600 hover:underline dark:text-sky-400">
                    <span>Open in {selectedRecord.platform || 'Browser'}</span>
                    <FiExternalLink className="size-3" />
                  </a>
                </div>
              )}

              {/* Outcome Reason */}
              {selectedRecord.reason && (
                <div>
                  <span className="mb-1 block font-semibold text-gray-700 dark:text-gray-300">Outcome Details:</span>
                  <p className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-gray-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-gray-300">
                    {selectedRecord.reason}
                  </p>
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
