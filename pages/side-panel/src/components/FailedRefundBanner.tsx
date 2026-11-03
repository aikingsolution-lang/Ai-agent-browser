import React from 'react';
import { FiAlertTriangle, FiX } from 'react-icons/fi';

export interface FailedRefundItem {
  runId: string;
  reason: string;
}

export interface FailedRefundBannerProps {
  notices: FailedRefundItem[] | null;
  onDismiss: () => void;
}

export const FailedRefundBanner: React.FC<FailedRefundBannerProps> = ({ notices, onDismiss }) => {
  if (!notices || notices.length === 0) return null;

  return (
    <div
      data-testid="failed-refund-banner"
      className="mx-3 my-1.5 rounded-lg border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-1.5">
          <FiAlertTriangle className="mt-0.5 size-3.5 shrink-0 text-red-500" />
          <div className="space-y-0.5">
            <div className="text-[11px] font-semibold" data-testid="failed-refund-title">
              Refund notice ({notices.length} pending support review)
            </div>
            <div className="text-[10px] opacity-90" data-testid="failed-refund-description">
              A previous application credit refund could not be automatically finalized. The incident has been recorded
              for credit reconciliation.
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          data-testid="dismiss-failed-refund-btn"
          className="shrink-0 cursor-pointer rounded p-1 transition-colors hover:bg-red-500/20"
          title="Dismiss">
          <FiX className="size-3.5" />
        </button>
      </div>
    </div>
  );
};
