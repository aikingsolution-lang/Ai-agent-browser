/**
 * Evaluation and Verification Helper
 * Verifies that the actual browser page state and results match user intent
 * before the task is allowed to be marked complete.
 */

export interface TaskVerificationResult {
  isComplete: boolean;
  reason?: string;
  retryAction?: string;
}

export interface AdSkipMatcherResult {
  isSkipButton: boolean;
  confidence: 'high' | 'medium' | 'none';
}

/**
 * Evaluates whether a candidate element matches common Ad Skip patterns across platforms
 */
export function matchAdSkipPattern(el: {
  text?: string;
  ariaLabel?: string;
  className?: string;
  tagName?: string;
}): AdSkipMatcherResult {
  const text = (el.text || '').trim().toLowerCase();
  const aria = (el.ariaLabel || '').trim().toLowerCase();
  const className = (el.className || '').toLowerCase();

  // Known class names
  if (
    className.includes('ytp-ad-skip-button') ||
    className.includes('videoaduiskipbutton') ||
    className.includes('ytp-skip-ad-button') ||
    className.includes('ytp-ad-overlay-close-button')
  ) {
    return { isSkipButton: true, confidence: 'high' };
  }

  // Exact text matches
  if (text === 'skip' || text === 'skip ad' || text === 'skip ads' || text === 'skip advertisement') {
    return { isSkipButton: true, confidence: 'high' };
  }

  // Starts with skip ad
  if (text.startsWith('skip ad in') || text.startsWith('skip ad ') || text.startsWith('skip in ')) {
    return { isSkipButton: true, confidence: 'high' };
  }

  // Aria label matches
  if (aria.includes('skip ad') || aria.includes('skip advertisement')) {
    return { isSkipButton: true, confidence: 'high' };
  }

  return { isSkipButton: false, confidence: 'none' };
}

/**
 * Evaluates whether the current page state actually fulfills the requested user task.
 */
export function verifyTaskResult(
  task: string,
  currentState: {
    url: string;
    title: string;
    lastActionExtractedContent?: string;
    pageTextSnippet?: string;
  },
): TaskVerificationResult {
  const taskLower = task.toLowerCase();
  const urlLower = currentState.url.toLowerCase();
  const titleLower = currentState.title.toLowerCase();
  const lastMsg = currentState.lastActionExtractedContent || '';

  // 1. Unsubmitted Search Check:
  // If the last action explicitly indicated the query was typed but the page did not navigate
  if (lastMsg.includes('Verification Note: Page did not navigate to a new URL')) {
    return {
      isComplete: false,
      reason: 'Search query was typed into the input field but never submitted to a results page.',
      retryAction: 'Submit the search by pressing Enter or clicking the Search button.',
    };
  }

  // Wikipedia search check: If user wants to search Wikipedia for X, and URL is still Wikipedia Main Page
  if (
    taskLower.includes('wikipedia') &&
    (urlLower.includes('wikipedia.org/wiki/main_page') ||
      urlLower.endsWith('wikipedia.org/') ||
      urlLower.endsWith('wikipedia.org'))
  ) {
    // Extract query terms (excluding generic stopwords)
    const keywords = taskLower
      .replace(/search|for|on|wikipedia|find|about|article/gi, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 2);

    const hasTermInTitle = keywords.some(k => titleLower.includes(k));
    if (!hasTermInTitle && keywords.length > 0) {
      return {
        isComplete: false,
        reason: `Still on Wikipedia Main Page. The target article for '${keywords.join(' ')}' was not opened.`,
        retryAction: 'Submit the search query to navigate to the target Wikipedia article.',
      };
    }
  }

  // 2. YouTube Music / Video Relevance Check:
  if (urlLower.includes('youtube.com/watch')) {
    // If user specified a specific genre or style (e.g. 'lofi', 'chill', 'rock', 'jazz')
    const genres = ['lofi', 'lo-fi', 'chill', 'jazz', 'classical', 'meditation', 'sleep', 'workout', 'rock', 'pop'];
    const requestedGenres = genres.filter(g => taskLower.includes(g));

    if (requestedGenres.length > 0) {
      // Check if title or snippet matches at least one requested genre
      const contentMatchesGenre = requestedGenres.some(
        g => titleLower.includes(g) || (currentState.pageTextSnippet || '').toLowerCase().includes(g),
      );

      if (!contentMatchesGenre) {
        return {
          isComplete: false,
          reason: `Current video '${currentState.title}' does not match requested genre '${requestedGenres.join(', ')}'.`,
          retryAction: `Go back or search specifically for '${requestedGenres.join(' ')} music' and select a matching video.`,
        };
      }
    }

    // If user asked for a specific song or artist name
    const specificArtistMatches = taskLower.match(/play\s+(?:the\s+song\s+)?([a-z0-9\s]+?)(?:\s+on\s+youtube|$)/i);
    if (specificArtistMatches && specificArtistMatches[1]) {
      const targetQuery = specificArtistMatches[1].trim();
      if (!['any song', 'a song', 'song', 'music', 'video'].includes(targetQuery)) {
        const queryTerms = targetQuery.split(/\s+/).filter(w => w.length > 2);
        const matchesQuery = queryTerms.some(term => titleLower.includes(term));
        if (!matchesQuery && queryTerms.length > 0) {
          return {
            isComplete: false,
            reason: `Current video '${currentState.title}' does not match requested title '${targetQuery}'.`,
            retryAction: `Search YouTube directly for '${targetQuery}' and click the matching video.`,
          };
        }
      }
    }
  }

  // 3. LinkedIn Easy Apply Guardrail:
  // If the user asked to apply to a job on LinkedIn, ensure it actually ran through ApplicationEngine
  const isLinkedInApplyTask =
    (taskLower.includes('linkedin') && (taskLower.includes('apply') || taskLower.includes('job'))) ||
    taskLower.includes('easy apply');

  if (isLinkedInApplyTask) {
    const validEngineStatusPhrases = [
      'linkedin easy apply result:',
      'dry_run_success',
      'applied',
      'needs_manual_review',
      'pending_resume_approval',
      'skipped low fit',
      'already processed/applied',
      'daily application quota reached',
      'skipped_external_site',
    ];

    const hasEngineConfirmation = validEngineStatusPhrases.some(phrase => lastMsg.toLowerCase().includes(phrase));

    if (!hasEngineConfirmation) {
      return {
        isComplete: false,
        reason:
          'LinkedIn application was not processed by the ApplicationEngine. A simple click or navigation is not considered application completion.',
        retryAction:
          'Trigger the LinkedIn Easy Apply process using the linkedin_easy_apply action on the job listing page.',
      };
    }
  }

  return {
    isComplete: true,
  };
}
