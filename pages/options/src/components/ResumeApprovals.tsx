import React, { useState, useEffect } from 'react';
import { Button } from '@extension/ui';
import { FiFileText, FiCheck, FiX, FiRefreshCw, FiDownload } from 'react-icons/fi';
import { resumeApprovalStore, type IPendingResumeItem } from '@extension/storage';

export const ResumeApprovals: React.FC = () => {
  const [items, setItems] = useState<IPendingResumeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const loadApprovals = async () => {
    setLoading(true);
    try {
      const list = await resumeApprovalStore.getAllApprovals();
      setItems(list);
    } catch (err) {
      console.error('Failed to load approvals:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApprovals();
  }, []);

  const handleApprove = async (id: string) => {
    await resumeApprovalStore.approveResume(id);
    await loadApprovals();
  };

  const handleReject = async (id: string) => {
    await resumeApprovalStore.rejectResume(id);
    await loadApprovals();
  };

  const downloadPdf = (item: IPendingResumeItem) => {
    const byteCharacters = atob(item.base64Pdf);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Resume Approval Gate</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Review and approve AI-tailored PDF resumes before they are submitted to LinkedIn Easy Apply.
          </p>
        </div>
        <Button variant="secondary" onClick={loadApprovals} className="flex items-center gap-2">
          <FiRefreshCw className={loading ? 'animate-spin' : ''} />
          Refresh
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="p-8 text-center bg-gray-50 dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700">
          <FiFileText className="w-12 h-12 mx-auto text-gray-400 mb-3" />
          <h3 className="text-base font-semibold text-gray-700 dark:text-gray-200">No Resumes Pending Approval</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            When the LinkedIn automation generates a tailored resume for a job opening, it will appear here for your
            review.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {items.map(item => (
            <div
              key={item.id}
              className={`p-5 rounded-xl border transition-all ${
                item.status === 'PENDING'
                  ? 'border-amber-300 dark:border-amber-600 bg-amber-50/40 dark:bg-amber-950/20'
                  : item.status === 'APPROVED'
                    ? 'border-green-300 dark:border-green-700 bg-green-50/30 dark:bg-green-950/10'
                    : 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/40 opacity-70'
              }`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold uppercase ${
                        item.status === 'PENDING'
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/60 dark:text-amber-200'
                          : item.status === 'APPROVED'
                            ? 'bg-green-100 text-green-800 dark:bg-green-900/60 dark:text-green-200'
                            : 'bg-red-100 text-red-800 dark:bg-red-900/60 dark:text-red-200'
                      }`}>
                      {item.status === 'PENDING' ? '⏳ Pending Approval' : item.status}
                    </span>
                    <h3 className="text-base font-bold text-gray-900 dark:text-white">{item.jobTitle}</h3>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300">
                    <span className="font-semibold">{item.company}</span> • {item.location || 'Remote'}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    File: <span className="font-mono">{item.fileName}</span> ({(item.fileSize / 1024).toFixed(1)} KB) •
                    Created: {new Date(item.createdAt).toLocaleString()}
                  </p>
                  {item.highlightedKeywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      <span className="text-xs text-gray-500 self-center">Keywords tailored:</span>
                      {item.highlightedKeywords.map((kw: string) => (
                        <span
                          key={kw}
                          className="text-xs bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded border border-indigo-200 dark:border-indigo-800">
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="secondary"
                    onClick={() => downloadPdf(item)}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5">
                    <FiDownload className="w-4 h-4" />
                    Download PDF
                  </Button>

                  {item.status === 'PENDING' && (
                    <>
                      <Button
                        variant="primary"
                        onClick={() => handleApprove(item.id)}
                        className="bg-green-600 hover:bg-green-700 text-white flex items-center gap-1.5 text-xs px-2.5 py-1.5">
                        <FiCheck className="w-4 h-4" />
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => handleReject(item.id)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5">
                        <FiX className="w-4 h-4" />
                        Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ResumeApprovals;
