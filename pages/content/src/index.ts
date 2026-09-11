console.log('Nanobrowser content script active');

/**
 * Real-time YouTube Ad Skipper & Fast-Forwarder
 * Continuously detects and skips video ads on YouTube tabs.
 */
function initYouTubeAdSkipper() {
  if (!window.location.hostname.includes('youtube.com')) {
    return;
  }

  let wasAdShowing = false;

  const skipAd = () => {
    // 1. Check for standard skip buttons by selector
    const skipSelectors = [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      '.ytp-ad-skip-button-modern',
      'button.ytp-ad-skip-button',
      'button.ytp-ad-skip-button-modern',
      '.ytp-ad-skip-button-container button',
      'button[id^="skip-button"]',
      '.videoAdUiSkipButton',
      '.ytp-ad-overlay-close-button',
      'button[aria-label*="Skip"]',
      'button[aria-label*="skip"]',
    ];

    for (const sel of skipSelectors) {
      const btn = document.querySelector<HTMLElement>(sel);
      if (btn && btn.offsetParent !== null) {
        try {
          btn.click();
          return;
        } catch {}
      }
    }

    // 2. Scan buttons with text content starting with "Skip"
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.innerText?.trim() || btn.textContent?.trim() || '';
      if (text && (/^skip/i.test(text) || text.includes('Skip ad') || text.includes('Skip Ad'))) {
        try {
          btn.click();
          return;
        } catch {}
      }
    }

    // 3. Mute ad while playing, and click skip as soon as enabled
    const isAdShowing = Boolean(document.querySelector('.ad-showing, .ad-interrupting, .ytp-ad-player-overlay'));
    const video = document.querySelector('video');

    if (isAdShowing && video) {
      wasAdShowing = true;
      try {
        video.muted = true;
      } catch {}

      // Try to click any skip button in the container
      const adSkipBtn = document.querySelector<HTMLElement>(
        '.ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-slot button',
      );
      if (adSkipBtn) {
        try {
          adSkipBtn.click();
        } catch {}
      }
    } else if (wasAdShowing && video && !isAdShowing) {
      // Restore audio once real video starts
      wasAdShowing = false;
      try {
        video.muted = false;
      } catch {}
    }
  };

  // Run at 250ms interval
  setInterval(skipAd, 250);

  // Also hook into DOM mutations for instant response
  const observer = new MutationObserver(() => {
    skipAd();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

initYouTubeAdSkipper();
