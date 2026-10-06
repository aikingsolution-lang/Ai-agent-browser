/**
 * CSV / Excel Export Utility for Job Applications.
 *
 * Implements RFC 4180 compliant CSV serialization with UTF-8 BOM (\uFEFF)
 * ensuring full compatibility with Microsoft Excel, Google Sheets, LibreOffice,
 * and Apple Numbers without character encoding corruption.
 *
 * Streamlined to strictly export verified APPLIED jobs with clean, essential columns.
 */

export interface ExportableJobRecord {
  id?: string;
  jobId?: string;
  title: string;
  company: string;
  location?: string;
  platform?: string;
  status: string; // 'applied' | 'skipped' | 'failed' | 'dry_run_success' | etc.
  reason?: string;
  fitScore?: number | null;
  creditsUsed?: number;
  url?: string;
  timestamp: number;
  screeningAnswers?: Array<{ questionText: string; userAnswer: string | null }>;
}

/**
 * Detects job board platform from URL if not explicitly provided.
 */
export function detectPlatformFromUrl(url?: string): string {
  if (!url) return 'Unknown';
  const lower = url.toLowerCase();
  if (lower.includes('linkedin.com')) return 'LinkedIn';
  if (lower.includes('naukri.com')) return 'Naukri';
  if (lower.includes('indeed.com')) return 'Indeed';
  if (lower.includes('glassdoor.com')) return 'Glassdoor';
  if (lower.includes('wellfound.com') || lower.includes('angel.co')) return 'Wellfound';
  return 'Web';
}

/**
 * Escapes a single CSV field value according to RFC 4180 rules.
 * Encloses the field in double quotes if it contains commas, double quotes,
 * newlines, or leading/trailing whitespace, and escapes internal quotes with double quotes.
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);

  const needsQuotes =
    str.includes(',') ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r') ||
    str.startsWith(' ') ||
    str.endsWith(' ');

  if (needsQuotes) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates an RFC 4180 compliant CSV string with a UTF-8 BOM prefix.
 * Strictly includes verified APPLIED jobs with essential columns:
 * Platform, Job Title, Company, Status, Fit Score (%), Outcome / Reason, Job URL.
 */
export function generateJobsCsv(records: ExportableJobRecord[]): string {
  // Filter ONLY applied jobs (live applied and verified dry run success)
  const appliedRecords = (records || []).filter(rec => {
    const s = (rec.status || '').toLowerCase().trim();
    return s === 'applied' || s === 'dry_run_success';
  });

  const headers = ['Platform', 'Job Title', 'Company', 'Status', 'Fit Score (%)', 'Outcome / Reason', 'Job URL'];

  const headerLine = headers.map(escapeCsvField).join(',');

  const rows = appliedRecords.map(rec => {
    const platformStr = rec.platform || detectPlatformFromUrl(rec.url);
    const titleStr = rec.title || 'Untitled Role';
    const companyStr = rec.company || 'Unknown Company';
    const statusLabel = 'Applied';
    const fitScoreStr = typeof rec.fitScore === 'number' ? `${rec.fitScore}%` : 'N/A';
    const reasonStr = rec.reason || 'Successfully submitted via Easy Apply';
    const urlStr = rec.url || '';

    return [
      escapeCsvField(platformStr),
      escapeCsvField(titleStr),
      escapeCsvField(companyStr),
      escapeCsvField(statusLabel),
      escapeCsvField(fitScoreStr),
      escapeCsvField(reasonStr),
      escapeCsvField(urlStr),
    ].join(',');
  });

  // UTF-8 BOM (\uFEFF) ensures Microsoft Excel immediately recognizes UTF-8 encoding
  return '\uFEFF' + [headerLine, ...rows].join('\r\n');
}

/**
 * Triggers a browser file download using standard Blob and temporary <a> anchor.
 */
export function downloadCsvFile(csvContent: string, fileName?: string): boolean {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return false;
    }

    const dateStr = new Date().toISOString().split('T')[0];
    const defaultName = `JobPilot_Applied_Jobs_${dateStr}.csv`;
    const finalName = fileName || defaultName;

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.setAttribute('href', url);
    link.setAttribute('download', finalName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error('Failed to trigger CSV download:', err);
    return false;
  }
}

/**
 * Convenience single-call function that transforms applied application records
 * into an Excel-ready CSV file and triggers immediate browser download.
 */
export function exportApplicationsToCsv(
  records: ExportableJobRecord[],
  fileNamePrefix: string = 'JobPilot_Applied_Jobs',
): boolean {
  const appliedRecords = (records || []).filter(rec => {
    const s = (rec.status || '').toLowerCase().trim();
    return s === 'applied' || s === 'dry_run_success';
  });

  if (appliedRecords.length === 0) {
    return false;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const finalName = `${fileNamePrefix}_${dateStr}.csv`;
  const csvContent = generateJobsCsv(appliedRecords);
  return downloadCsvFile(csvContent, finalName);
}
