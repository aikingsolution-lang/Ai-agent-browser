// chrome-extension/src/background/agent/__tests__/linkedinAdapter.test.ts
import { describe, it, expect } from 'vitest';
import { linkedinAdapter } from '../platforms/linkedin/linkedinAdapter';

describe('LinkedInAdapter Search URL Generation', () => {
  it('correctly formats standard city location without f_WT', () => {
    const url = linkedinAdapter.buildSearchUrl('Full Stack Developer', 'Bengaluru, India');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('keywords')).toBe('Full Stack Developer');
    expect(parsed.searchParams.get('location')).toBe('Bengaluru, India');
    expect(parsed.searchParams.get('f_AL')).toBe('true');
    expect(parsed.searchParams.get('sortBy')).toBe('R');
    expect(parsed.searchParams.get('f_WT')).toBeNull();
  });

  it('handles "Remote, India" by setting f_WT=2 and location=India', () => {
    const url = linkedinAdapter.buildSearchUrl('Full Stack Developer', 'Remote, India');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('keywords')).toBe('Full Stack Developer');
    expect(parsed.searchParams.get('f_WT')).toBe('2');
    expect(parsed.searchParams.get('location')).toBe('India');
    expect(parsed.searchParams.get('f_AL')).toBe('true');
  });

  it('handles "Remote" by setting f_WT=2 and omitting location parameter', () => {
    const url = linkedinAdapter.buildSearchUrl('Frontend Engineer', 'Remote');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('keywords')).toBe('Frontend Engineer');
    expect(parsed.searchParams.get('f_WT')).toBe('2');
    expect(parsed.searchParams.get('location')).toBeNull();
  });

  it('handles "India (Remote)" by setting f_WT=2 and location=India', () => {
    const url = linkedinAdapter.buildSearchUrl('React Developer', 'India (Remote)');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('f_WT')).toBe('2');
    expect(parsed.searchParams.get('location')).toBe('India');
  });

  it('handles "Hybrid, Mumbai" by setting f_WT=3 and location=Mumbai', () => {
    const url = linkedinAdapter.buildSearchUrl('Backend Developer', 'Hybrid, Mumbai');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('f_WT')).toBe('3');
    expect(parsed.searchParams.get('location')).toBe('Mumbai');
  });

  it('sanitizes candidate name from role search query', () => {
    const url = linkedinAdapter.buildSearchUrl('MUBASSHIR ALI', 'Bengaluru, India', 'Mubasshir Ali');
    const parsed = new URL(url);

    expect(parsed.searchParams.get('keywords')).not.toContain('Mubasshir');
    expect(parsed.searchParams.get('keywords')).toBe('Software Engineer');
  });
});
