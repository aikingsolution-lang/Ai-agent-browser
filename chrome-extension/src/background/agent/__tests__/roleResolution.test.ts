import { describe, it, expect } from 'vitest';
import { isCandidateNameOrInvalidTitle, sanitizeRoleSearchQuery, type ICareerBrain } from '@extension/storage';
import { linkedinAdapter } from '../platforms/linkedin/linkedinAdapter';
import { naukriAdapter } from '../platforms/naukri/naukriAdapter';
import { indeedAdapter } from '../platforms/indeed/indeedAdapter';

describe('Candidate Name Safeguard & Role Resolution', () => {
  const candidateName = 'Mubasshir Ali';

  describe('isCandidateNameOrInvalidTitle', () => {
    it('detects candidate name in various casing and permutations', () => {
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('mubasshir ali', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('ALI', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Mubasshir Ali', undefined)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI', '')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI', 'Candidate')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Candidate', 'Candidate')).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Software Professional', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Full Stack Developer', candidateName)).toBe(false);
    });

    it('detects compound titles containing candidate name tokens', () => {
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI - Full Stack Developer', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Full Stack Developer (Mubasshir Ali)', candidateName)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Mubasshir Ali Software Engineer', candidateName)).toBe(true);
    });

    it('handles candidate names passed as an array of sources', () => {
      const nameSources = ['Mubasshir Ali', 'Mubasshir', 'mubasshir.ali@example.com'];
      expect(isCandidateNameOrInvalidTitle('MUBASSHIR ALI', nameSources)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Mubasshir', nameSources)).toBe(true);
      expect(isCandidateNameOrInvalidTitle('Full Stack Developer', nameSources)).toBe(false);
    });
  });

  describe('sanitizeRoleSearchQuery', () => {
    it('rejects candidate full name and safely falls back to configured/default role', () => {
      const result = sanitizeRoleSearchQuery('MUBASSHIR ALI', candidateName, 'Full Stack Developer');
      expect(result).toBe('Full Stack Developer');
      expect(result.toLowerCase()).not.toContain('mubasshir');
      expect(result.toLowerCase()).not.toContain('ali');
    });

    it('rejects candidate single name token and falls back', () => {
      const result = sanitizeRoleSearchQuery('MUBASSHIR', candidateName, 'Software Engineer');
      expect(result).toBe('Software Engineer');
    });

    it('strips candidate name from compound role strings and keeps legitimate role', () => {
      const result = sanitizeRoleSearchQuery(
        'MUBASSHIR ALI - Full Stack Developer',
        candidateName,
        'Frontend Developer',
      );
      expect(result).toBe('Full Stack Developer');
      expect(result.toLowerCase()).not.toContain('mubasshir');
      expect(result.toLowerCase()).not.toContain('ali');
    });

    it('handles pure candidate name when candidateName is omitted via heuristic', () => {
      const result = sanitizeRoleSearchQuery('MUBASSHIR ALI', undefined, 'Full Stack Developer');
      expect(result).toBe('Full Stack Developer');
    });

    it('preserves clean, legitimate job titles', () => {
      expect(sanitizeRoleSearchQuery('Frontend Developer', candidateName)).toBe('Frontend Developer');
      expect(sanitizeRoleSearchQuery('Backend Engineer', candidateName)).toBe('Backend Engineer');
      expect(sanitizeRoleSearchQuery('React Native Developer', candidateName)).toBe('React Native Developer');
    });

    it('falls back on placeholders like "Software Professional" or "Candidate"', () => {
      expect(sanitizeRoleSearchQuery('Software Professional', candidateName, 'Full Stack Developer')).toBe(
        'Full Stack Developer',
      );
      expect(sanitizeRoleSearchQuery('Candidate', candidateName, 'Software Engineer')).toBe('Software Engineer');
    });
  });

  describe('Search URL Generation Safeguards (LinkedIn, Naukri, Indeed)', () => {
    it('LinkedInAdapter: NEVER includes candidate name in search URL keywords', () => {
      const url1 = linkedinAdapter.buildSearchUrl('MUBASSHIR ALI', 'Bengaluru, India', candidateName);
      expect(url1.toLowerCase()).not.toContain('mubasshir');
      expect(url1.toLowerCase()).not.toContain('ali');
      expect(url1).toContain('keywords=Software+Engineer');

      const url2 = linkedinAdapter.buildSearchUrl(
        'MUBASSHIR ALI - Full Stack Developer',
        'Bengaluru, India',
        candidateName,
      );
      expect(url2.toLowerCase()).not.toContain('mubasshir');
      expect(url2.toLowerCase()).not.toContain('ali');
      expect(url2).toContain('keywords=Full+Stack+Developer');
    });

    it('NaukriAdapter: NEVER includes candidate name in search URL keywords or slug', () => {
      const url1 = naukriAdapter.buildSearchUrl('MUBASSHIR ALI', 'Bengaluru, India', candidateName);
      expect(url1.toLowerCase()).not.toContain('mubasshir');
      expect(url1.toLowerCase()).not.toContain('ali');
      expect(url1).toContain('software-engineer-jobs');
      expect(url1).toContain('k=Software+Engineer');

      const url2 = naukriAdapter.buildSearchUrl(
        'MUBASSHIR ALI - Full Stack Developer',
        'Bengaluru, India',
        candidateName,
      );
      expect(url2.toLowerCase()).not.toContain('mubasshir');
      expect(url2.toLowerCase()).not.toContain('ali');
      expect(url2).toContain('full-stack-developer-jobs');
      expect(url2).toContain('k=Full+Stack+Developer');
    });

    it('IndeedAdapter: NEVER includes candidate name in search URL "q" parameter', () => {
      const url1 = indeedAdapter.buildSearchUrl('MUBASSHIR ALI', 'Bengaluru, India', 0, candidateName);
      expect(url1.toLowerCase()).not.toContain('mubasshir');
      expect(url1.toLowerCase()).not.toContain('ali');
      expect(url1).toContain('q=Software+Engineer');

      const url2 = indeedAdapter.buildSearchUrl(
        'MUBASSHIR ALI - Full Stack Developer',
        'Bengaluru, India',
        0,
        candidateName,
      );
      expect(url2.toLowerCase()).not.toContain('mubasshir');
      expect(url2.toLowerCase()).not.toContain('ali');
      expect(url2).toContain('q=Full+Stack+Developer');
    });
  });
});
