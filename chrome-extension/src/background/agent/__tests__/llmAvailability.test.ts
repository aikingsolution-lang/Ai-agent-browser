import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ICareerBrain } from '@extension/storage';
import {
  isLlmAvailable,
  tripLlmCircuitBreaker,
  resetLlmCircuitBreaker,
  isCircuitBreakerError,
  LLM_UNAVAILABLE_LIVE_MESSAGE,
  wrapChatModelWithCircuitBreaker,
} from '../llmCircuitBreaker';
import {
  derivePhoneCountryCode,
  matchRuleBased,
  solveQuestionAutonomousWithLLM,
  resolveModalFieldWithAudit,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';
import { getActiveChatModel } from '../activeModelHelper';

describe('LLM Availability & Circuit Breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLlmCircuitBreaker();
  });

  describe('Requirement 1 & 2: Circuit Breaker & Single Live Activity Alert', () => {
    it('detects PROVIDER_BAD_REQUEST, 401, 403, 429 and network errors as circuit breaker errors', () => {
      expect(isCircuitBreakerError(new Error('PROVIDER_BAD_REQUEST: model quota exceeded'))).toBe(true);
      expect(isCircuitBreakerError({ status: 401, message: 'Unauthorized' })).toBe(true);
      expect(isCircuitBreakerError({ status: 403, message: 'Forbidden' })).toBe(true);
      expect(isCircuitBreakerError({ status: 429, message: 'Too Many Requests' })).toBe(true);
      expect(isCircuitBreakerError(new Error('Failed to fetch'))).toBe(true);
      expect(isCircuitBreakerError(new Error('fetch failed'))).toBe(true);
      expect(isCircuitBreakerError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
      expect(isCircuitBreakerError(new Error('network timeout'))).toBe(true);

      // Normal benign errors do not trip
      expect(isCircuitBreakerError(new Error('Validation error: text must not be empty'))).toBe(false);
    });

    it('one failure disables further LLM calls in that run, emits message once, and next run re-enables LLM', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      expect(isLlmAvailable()).toBe(true);

      // Mock an LLM that throws PROVIDER_BAD_REQUEST
      const invokeMock = vi.fn().mockRejectedValue(new Error('PROVIDER_BAD_REQUEST: token quota exhausted'));
      const mockChatModel = {
        invoke: invokeMock,
      } as unknown as BaseChatModel;

      const wrappedModel = wrapChatModelWithCircuitBreaker(mockChatModel, liveActivitySpy);

      // 1. First invocation fails with PROVIDER_BAD_REQUEST
      await expect(wrappedModel.invoke('test prompt')).rejects.toThrow();

      // Circuit breaker is now tripped for the current run
      expect(isLlmAvailable()).toBe(false);

      // Alert emitted exactly once
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);
      expect(liveActivitySpy).toHaveBeenCalledWith(LLM_UNAVAILABLE_LIVE_MESSAGE, 'warn');

      // 2. Second invocation in the SAME run is blocked immediately without calling model.invoke
      await expect(wrappedModel.invoke('another prompt')).rejects.toThrow('LLM_UNAVAILABLE');
      expect(invokeMock).toHaveBeenCalledTimes(1); // Not called a second time!

      // Live Activity message must NOT be repeated
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);

      // 3. Next run starts: circuit breaker is reset
      const nextRunActivitySpy = vi.fn();
      resetLlmCircuitBreaker(nextRunActivitySpy);

      expect(isLlmAvailable()).toBe(true);

      // Mock now succeeds on next run
      invokeMock.mockResolvedValueOnce({ content: '{"answer":"Success"}' });
      const nextWrappedModel = wrapChatModelWithCircuitBreaker(mockChatModel, nextRunActivitySpy);
      const res = await nextWrappedModel.invoke('fresh run prompt');
      expect((res as any).content).toBe('{"answer":"Success"}');
      expect(nextRunActivitySpy).not.toHaveBeenCalled();
    });

    it('skips solveQuestionAutonomousWithLLM immediately while circuit breaker is active', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      // Trip the breaker with a 429 error
      tripLlmCircuitBreaker(new Error('429 Too Many Requests: Rate limit exceeded'), liveActivitySpy);
      expect(isLlmAvailable()).toBe(false);
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);

      const mockLlm = {
        invoke: vi.fn(),
      } as unknown as BaseChatModel;

      const field: FormFieldDescriptor = {
        label: 'Describe your experience with microservices architecture',
        fieldType: 'text',
      };
      const careerBrain = {
        currentTitle: 'Backend Engineer',
        skills: ['Node.js', 'Go'],
      } as unknown as ICareerBrain;

      // Call solveQuestionAutonomousWithLLM while circuit breaker is active
      const sol = await solveQuestionAutonomousWithLLM(field, careerBrain, mockLlm);

      // Must fail immediately without invoking LLM
      expect(sol.success).toBe(false);
      expect(mockLlm.invoke).not.toHaveBeenCalled();
      // Must not repeat the Live Activity message
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);
    });

    it('treats custom field needing AI as UNRESOLVED while rule-based answers still work', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      // Trip breaker
      tripLlmCircuitBreaker(new Error('401 Unauthorized'), liveActivitySpy);
      expect(isLlmAvailable()).toBe(false);

      const mockPage = {
        fillModalFieldDirect: vi.fn().mockResolvedValue(true),
      };

      const careerBrain = {
        firstName: 'Alex',
        lastName: 'Taylor',
        email: 'alex@example.com',
        phoneNumber: '+1 555-0199',
        currentLocation: 'San Francisco, CA, United States',
        currentTitle: 'Senior Full Stack Developer',
      } as unknown as ICareerBrain;

      // Rule-based field (Email) -> STILL WORKS!
      const emailField: FormFieldDescriptor = {
        label: 'Email address',
        fieldType: 'text',
      };
      const emailRes = await resolveModalFieldWithAudit(mockPage, emailField, careerBrain);
      expect(emailRes.success).toBe(true);
      expect(emailRes.category).toBe('MATCHED');
      expect(emailRes.answer).toBe('alex@example.com');

      // AI-needing field (unlisted custom narrative) -> SKIPPED & UNRESOLVED
      const aiField: FormFieldDescriptor = {
        label: 'Describe a significant engineering accomplishment and its measurable impact',
        fieldType: 'text',
        required: true,
      };
      const aiRes = await resolveModalFieldWithAudit(mockPage, aiField, careerBrain);
      expect(aiRes.success).toBe(false);
      expect(aiRes.needsUserAnswer).toBe(true);
    });

    it('getActiveChatModel returns undefined immediately when circuit breaker is active', async () => {
      resetLlmCircuitBreaker();
      tripLlmCircuitBreaker(new Error('Network error: connect ECONNREFUSED'));
      expect(isLlmAvailable()).toBe(false);

      const model = await getActiveChatModel('test-job-run');
      expect(model).toBeUndefined();
    });
  });

  describe('Requirement 3: Phone Country Code Derivation', () => {
    it('1. Derives country code from candidate phone number prefix (+1, +44, +49, +61, +91, +33)', () => {
      expect(derivePhoneCountryCode({ phoneNumber: '+1 415-555-2671' })).toEqual({
        dialingCode: '+1',
        countryName: 'United States',
        isoCode: 'US',
      });

      expect(derivePhoneCountryCode({ phoneNumber: '+44 7911 123456' })).toEqual({
        dialingCode: '+44',
        countryName: 'United Kingdom',
        isoCode: 'GB',
      });

      expect(derivePhoneCountryCode({ phoneNumber: '+49 151 12345678' })).toEqual({
        dialingCode: '+49',
        countryName: 'Germany',
        isoCode: 'DE',
      });

      expect(derivePhoneCountryCode({ phoneNumber: '+61 412 345 678' })).toEqual({
        dialingCode: '+61',
        countryName: 'Australia',
        isoCode: 'AU',
      });

      expect(derivePhoneCountryCode({ phoneNumber: '+33 6 12 34 56 78' })).toEqual({
        dialingCode: '+33',
        countryName: 'France',
        isoCode: 'FR',
      });

      expect(derivePhoneCountryCode({ phoneNumber: '+91 9876543210' })).toEqual({
        dialingCode: '+91',
        countryName: 'India',
        isoCode: 'IN',
      });
    });

    it('2. When phone has no prefix, derives from candidate country if provided', () => {
      const brain: any = {
        phoneNumber: '9876543210',
        country: 'Germany',
      };
      expect(derivePhoneCountryCode(brain)).toEqual({
        dialingCode: '+49',
        countryName: 'Germany',
        isoCode: 'DE',
      });
    });

    it('3. When phone has no prefix and no country, defaults to profile current location country', () => {
      expect(
        derivePhoneCountryCode({
          phoneNumber: '5550199',
          currentLocation: 'San Francisco, CA, United States',
        }),
      ).toEqual({
        dialingCode: '+1',
        countryName: 'United States',
        isoCode: 'US',
      });

      expect(
        derivePhoneCountryCode({
          phoneNumber: '7911123456',
          currentLocation: 'London, UK',
        }),
      ).toEqual({
        dialingCode: '+44',
        countryName: 'United Kingdom',
        isoCode: 'GB',
      });

      expect(
        derivePhoneCountryCode({
          phoneNumber: '1511234567',
          currentLocation: 'Berlin, Germany',
        }),
      ).toEqual({
        dialingCode: '+49',
        countryName: 'Germany',
        isoCode: 'DE',
      });

      expect(
        derivePhoneCountryCode({
          phoneNumber: '9876543210',
          currentLocation: 'Bengaluru, India',
        }),
      ).toEqual({
        dialingCode: '+91',
        countryName: 'India',
        isoCode: 'IN',
      });
    });

    it('4. If phone prefix and location are undetermined, falls back to India (+91)', () => {
      expect(
        derivePhoneCountryCode({
          phoneNumber: '9876543210',
          currentLocation: '',
        }),
      ).toEqual({
        dialingCode: '+91',
        countryName: 'India',
        isoCode: 'IN',
      });

      expect(derivePhoneCountryCode(undefined)).toEqual({
        dialingCode: '+91',
        countryName: 'India',
        isoCode: 'IN',
      });
    });

    it('matches Phone Country Code dropdown accurately according to candidate country', () => {
      const field: FormFieldDescriptor = {
        label: 'Phone country code',
        fieldType: 'dropdown',
        options: [
          'Select an option',
          'United States (+1)',
          'United Kingdom (+44)',
          'Germany (+49)',
          'India (+91)',
          'Australia (+61)',
        ],
      };

      // Candidate in US
      const usBrain = {
        phoneNumber: '+1 415-555-0100',
      } as unknown as ICareerBrain;
      const usMatch = matchRuleBased(field, usBrain);
      expect(usMatch.matched).toBe(true);
      expect(usMatch.answer).toBe('United States (+1)');

      // Candidate in UK
      const ukBrain = {
        phoneNumber: '+44 7911 123456',
      } as unknown as ICareerBrain;
      const ukMatch = matchRuleBased(field, ukBrain);
      expect(ukMatch.matched).toBe(true);
      expect(ukMatch.answer).toBe('United Kingdom (+44)');

      // Candidate in Germany (derived from location)
      const deBrain = {
        phoneNumber: '030 123456',
        currentLocation: 'Munich, Germany',
      } as unknown as ICareerBrain;
      const deMatch = matchRuleBased(field, deBrain);
      expect(deMatch.matched).toBe(true);
      expect(deMatch.answer).toBe('Germany (+49)');
    });

    it('single 429 rate limit honors Retry-After, retries once, and stays available if retry succeeds', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      let attempts = 0;
      const invokeMock = vi.fn().mockImplementation(() => {
        attempts++;
        if (attempts === 1) {
          const err: any = new Error('429 Too Many Requests: Rate limit exceeded');
          err.status = 429;
          err.retryAfter = 0.005;
          return Promise.reject(err);
        }
        return Promise.resolve({ content: '{"answer":"Success on retry"}' });
      });

      const mockModel = { invoke: invokeMock } as unknown as BaseChatModel;
      const wrapped = wrapChatModelWithCircuitBreaker(mockModel, liveActivitySpy);

      const res = await wrapped.invoke('test prompt');
      expect((res as any).content).toBe('{"answer":"Success on retry"}');
      expect(attempts).toBe(2);
      expect(isLlmAvailable()).toBe(true);
      expect(liveActivitySpy).not.toHaveBeenCalled();
    });

    it('single 429 failure after retry does NOT disable AI for the whole run (requires 3 consecutive failures)', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      const err429: any = new Error('429 Rate limit');
      err429.status = 429;
      err429.retryAfter = 0.005;

      const invokeMock = vi.fn().mockRejectedValue(err429);
      const mockModel = { invoke: invokeMock } as unknown as BaseChatModel;
      const wrapped = wrapChatModelWithCircuitBreaker(mockModel, liveActivitySpy);

      // Call 1 fails (initial + 1 retry)
      await expect(wrapped.invoke('call 1')).rejects.toThrow();
      expect(isLlmAvailable()).toBe(true); // NOT tripped yet!
      expect(liveActivitySpy).not.toHaveBeenCalled();

      // Call 2 fails
      await expect(wrapped.invoke('call 2')).rejects.toThrow();
      expect(isLlmAvailable()).toBe(true); // Still NOT tripped!
      expect(liveActivitySpy).not.toHaveBeenCalled();

      // Call 3 fails -> Now 3 consecutive failures -> TRIPS!
      await expect(wrapped.invoke('call 3')).rejects.toThrow();
      expect(isLlmAvailable()).toBe(false);
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);
    });

    it('configuration error (400, 401, 403, PROVIDER_BAD_REQUEST) trips immediately on first failure', async () => {
      const liveActivitySpy = vi.fn();
      resetLlmCircuitBreaker(liveActivitySpy);

      const authErr: any = new Error('403 Forbidden: Invalid API Key');
      authErr.status = 403;

      const invokeMock = vi.fn().mockRejectedValue(authErr);
      const mockModel = { invoke: invokeMock } as unknown as BaseChatModel;
      const wrapped = wrapChatModelWithCircuitBreaker(mockModel, liveActivitySpy);

      await expect(wrapped.invoke('call')).rejects.toThrow();
      // Must trip immediately
      expect(isLlmAvailable()).toBe(false);
      expect(liveActivitySpy).toHaveBeenCalledTimes(1);
    });
  });
});
