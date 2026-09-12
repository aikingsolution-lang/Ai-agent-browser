import { describe, it, expect } from 'vitest';
import { verifyTaskResult, matchAdSkipPattern } from '../evaluation';
import { inputTextActionSchema } from '../actions/schemas';

describe('Task Result & Intent Verification (Prevent False Success)', () => {
  describe('Case 1: Unsubmitted Search Query Verification (e.g. Wikipedia)', () => {
    const task = 'search for Albert Einstein on Wikipedia';

    it('rejects completion when search query is typed but URL has not navigated away from Main Page', () => {
      const state = {
        url: 'https://en.wikipedia.org/wiki/Main_Page',
        title: 'Wikipedia, the free encyclopedia',
        lastActionExtractedContent:
          'Typed "Albert Einstein" into input. [Verification Note: Page did not navigate to a new URL (https://en.wikipedia.org/wiki/Main_Page). If search results have not loaded, the search must be submitted by pressing Enter or clicking the Search button before claiming completion!]',
      };

      const verification = verifyTaskResult(task, state);
      expect(verification.isComplete).toBe(false);
      expect(verification.reason).toContain('never submitted');
      expect(verification.retryAction).toMatch(/press enter|search button/i);
    });

    it('rejects completion if still on Wikipedia Main Page without target term even without explicit note', () => {
      const state = {
        url: 'https://en.wikipedia.org/wiki/Main_Page',
        title: 'Wikipedia, the free encyclopedia',
      };

      const verification = verifyTaskResult(task, state);
      expect(verification.isComplete).toBe(false);
      expect(verification.reason).toContain('Main Page');
    });

    it('accepts completion when navigated to the actual article page', () => {
      const state = {
        url: 'https://en.wikipedia.org/wiki/Albert_Einstein',
        title: 'Albert Einstein - Wikipedia',
        lastActionExtractedContent: 'Clicked link to Albert Einstein',
      };

      const verification = verifyTaskResult(task, state);
      expect(verification.isComplete).toBe(true);
    });
  });

  describe('Case 2: Intent & Content Relevance Verification (e.g. YouTube lofi vs Bollywood)', () => {
    const task = 'play any lofi music video';

    it('rejects completion when playing video is an unrelated Bollywood song (Arijit Singh)', () => {
      const state = {
        url: 'https://www.youtube.com/watch?v=saanson-ko-123',
        title: 'Arijit Singh - Saanson Ko | Official Video Song | Bollywood Hits',
        pageTextSnippet: 'Zee Music Company · 150M views',
      };

      const verification = verifyTaskResult(task, state);
      expect(verification.isComplete).toBe(false);
      expect(verification.reason).toContain("does not match requested genre 'lofi'");
      expect(verification.retryAction).toContain('lofi music');
    });

    it('accepts completion when playing video actually matches requested lofi genre', () => {
      const state = {
        url: 'https://www.youtube.com/watch?v=lofi-chill-456',
        title: 'Lofi Hip Hop Radio - Beats to Relax/Study to [24/7 Live Stream]',
        pageTextSnippet: 'Lofi Girl · 55K watching now · Chill beats',
      };

      const verification = verifyTaskResult(task, state);
      expect(verification.isComplete).toBe(true);
    });

    it('rejects completion when specific artist requested does not match playing video', () => {
      const specificTask = 'play Taylor Swift songs on YouTube';
      const state = {
        url: 'https://www.youtube.com/watch?v=sql-tutorial-789',
        title: 'Complete SQL Interview Questions and Answers - Masterclass',
      };

      const verification = verifyTaskResult(specificTask, state);
      expect(verification.isComplete).toBe(false);
      expect(verification.reason?.toLowerCase()).toContain("does not match requested title 'taylor swift songs'");
    });
  });

  describe('Case 3: Generic Ad-Skip Pattern Matcher', () => {
    it('identifies standard YouTube ad skip classes', () => {
      expect(matchAdSkipPattern({ className: 'ytp-ad-skip-button-modern' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ className: 'ytp-skip-ad-button' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ className: 'videoAdUiSkipButton' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ className: 'ytp-ad-overlay-close-button' }).isSkipButton).toBe(true);
    });

    it('identifies buttons with text "Skip", "Skip Ad", "Skip ads", or countdowns', () => {
      expect(matchAdSkipPattern({ text: 'Skip Ad' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ text: 'Skip' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ text: 'Skip ads' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ text: 'Skip Ad in 5s' }).isSkipButton).toBe(true);
    });

    it('identifies elements with aria-label matching skip ad', () => {
      expect(matchAdSkipPattern({ ariaLabel: 'Skip Advertisement' }).isSkipButton).toBe(true);
      expect(matchAdSkipPattern({ ariaLabel: 'Skip ad in 3 seconds' }).isSkipButton).toBe(true);
    });

    it('rejects regular non-ad buttons', () => {
      expect(matchAdSkipPattern({ text: 'Play (k)' }).isSkipButton).toBe(false);
      expect(matchAdSkipPattern({ text: 'Subscribe' }).isSkipButton).toBe(false);
      expect(matchAdSkipPattern({ text: 'Next' }).isSkipButton).toBe(false);
      expect(matchAdSkipPattern({ text: 'Search' }).isSkipButton).toBe(false);
    });
  });

  describe('Case 4: InputText Schema Search Support', () => {
    it('supports optional press_enter flag in input_text schema', () => {
      const parsed = inputTextActionSchema.schema.parse({
        index: 2,
        text: 'Albert Einstein',
        press_enter: true,
      });

      expect(parsed.press_enter).toBe(true);
      expect(parsed.text).toBe('Albert Einstein');
    });

    it('defaults press_enter to false when not provided', () => {
      const parsed = inputTextActionSchema.schema.parse({
        index: 5,
        text: 'test query',
      });

      expect(parsed.press_enter).toBe(false);
    });
  });
});
