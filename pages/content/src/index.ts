// pages/content/src/index.ts
import { initJobHarvester } from './jobHarvester';
import { applyCurrentJobDirectly, type CandidateProfile } from './jobApplier';
import { initJobformWebsiteBridge, isJobformWebsitePage } from './jobformWebsiteBridge';

if (isJobformWebsitePage()) {
  // JobForm Automator website (injected at document_start): only the session bridge runs here
  // (sign-in / sign-out / payment events).
  initJobformWebsiteBridge();
} else {
  console.log('[Nanobrowser] Content script initialized for LinkedIn Automation');

  // 1. Initialize LinkedIn Job Harvester
  initJobHarvester();

  // 2. Initialize Direct LinkedIn Job Applier
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.type === 'APPLY_CURRENT_JOB_DIRECT') {
      const profile: CandidateProfile = request.profile || {};
      applyCurrentJobDirectly(profile)
        .then(result => {
          sendResponse(result);
        })
        .catch(err => {
          sendResponse({
            success: false,
            message: String(err?.message || err),
            title: 'Error',
          });
        });
      return true; // Keep channel open for async response
    }
    return false;
  });
}
