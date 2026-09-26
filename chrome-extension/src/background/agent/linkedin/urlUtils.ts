/**
 * URL Parser and Normalizer for LinkedIn Jobs
 *
 * Strict Validation:
 * - Protocol must be https:
 * - Host must be exactly linkedin.com or www.linkedin.com
 * - Job ID must be extracted and normalized to canonical https://www.linkedin.com/jobs/view/<jobId>/
 */

export interface NormalizedJobUrlResult {
  valid: boolean;
  jobId?: string;
  canonicalUrl?: string;
  error?: string;
}

export function normalizeLinkedInJobUrl(inputUrl: string): NormalizedJobUrlResult {
  if (!inputUrl || typeof inputUrl !== 'string') {
    return { valid: false, error: 'Please enter a LinkedIn job URL or Job ID' };
  }

  const trimmed = inputUrl.trim();

  // Allow pure numeric job IDs: e.g. "4012345678"
  if (/^\d{6,15}$/.test(trimmed)) {
    return {
      valid: true,
      jobId: trimmed,
      canonicalUrl: `https://www.linkedin.com/jobs/view/${trimmed}/`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL format. Please provide a valid https://www.linkedin.com link.' };
  }

  // Strict Protocol: https only
  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only secure https:// URLs are allowed.' };
  }

  // Strict Hostname: exactly linkedin.com or www.linkedin.com
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'linkedin.com' && hostname !== 'www.linkedin.com') {
    return { valid: false, error: 'Only official linkedin.com or www.linkedin.com URLs are accepted.' };
  }

  let jobId: string | null = null;

  // 1. Direct view format: /jobs/view/<id>
  const viewMatch = parsed.pathname.match(/\/jobs\/view\/(\d+)/i);
  if (viewMatch && viewMatch[1]) {
    jobId = viewMatch[1];
  }

  // 2. Query param format: ?currentJobId=<id>
  if (!jobId) {
    const currentJobId = parsed.searchParams.get('currentJobId');
    if (currentJobId && /^\d+$/.test(currentJobId)) {
      jobId = currentJobId;
    }
  }

  // 3. Query param format: ?jobId=<id>
  if (!jobId) {
    const qJobId = parsed.searchParams.get('jobId');
    if (qJobId && /^\d+$/.test(qJobId)) {
      jobId = qJobId;
    }
  }

  if (!jobId) {
    return {
      valid: false,
      error:
        'Could not extract a valid LinkedIn Job ID from the link. Please provide a /jobs/view/<id> or ?currentJobId=<id> URL.',
    };
  }

  return {
    valid: true,
    jobId,
    canonicalUrl: `https://www.linkedin.com/jobs/view/${jobId}/`,
  };
}
