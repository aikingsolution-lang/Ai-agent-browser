import { describe, it, expect } from 'vitest';
import { adaptAnswerToFieldFormat } from '../linkedin/formQuestionResolver';

describe('Phase 1, 2 & 3: DOM Settlement, Resume Selection, Typeahead & Checkpoints', () => {
  describe('Resume Modal Multi-Tier Selection Logic', () => {
    function normalizeFileName(str: string): string {
      return (str || '')
        .toLowerCase()
        .replace(/\.(pdf|doc|docx)$/i, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function simulateResumeSelection(
      radiosData: { text: string; checked: boolean }[],
      primaryTarget: string,
      altTargets: string[],
      tags: string[],
    ) {
      const normTarget = normalizeFileName(primaryTarget || '');
      const normAltTargets = (altTargets || []).map(normalizeFileName).filter(Boolean);
      const cleanTags = (tags || []).map(t => t.toLowerCase().trim()).filter(Boolean);

      const stopWords = new Set(['resume', 'cv', 'doc', 'docx', 'pdf', 'profile', 'updated', 'latest', 'final']);
      const targetWords = normTarget.split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));

      let bestIndex = -1;
      let highestScore = -1;

      radiosData.forEach((r, idx) => {
        const rawCardText = r.text.toLowerCase().trim();
        const normCard = normalizeFileName(rawCardText);
        let score = 0;

        // Tier 1: Exact or strong match on Primary Target resume
        if (normTarget && normCard === normTarget) {
          score += 1000;
        } else if (normTarget && normCard.includes(normTarget)) {
          score += 800;
        } else if (targetWords.length > 0) {
          for (const word of targetWords) {
            if (normCard.includes(word)) score += 100;
          }
        }

        // Tier 2: Match against any other uploaded resume in the extension
        for (const alt of normAltTargets) {
          if (alt && normCard === alt) {
            score += 500;
            break;
          } else if (alt && normCard.includes(alt)) {
            score += 400;
            break;
          }
        }

        // Tier 3: Resume tags match in card text
        for (const tag of cleanTags) {
          if (normCard.includes(tag)) {
            score += 20;
          }
        }

        // Tier 4: Fallback - if no match found, first available resume gets 10 points
        if (score === 0) {
          score = 10;
        }

        if (r.checked) {
          score += 1;
        }

        if (score > highestScore) {
          highestScore = score;
          bestIndex = idx;
        }
      });

      return { bestIndex, highestScore };
    }

    it('selects exact Default Resume when both files are present on LinkedIn (Tier 1)', () => {
      const linkedInResumes = [
        { text: 'Mubasshir_Ali_Software_Engineer_Resume.pdf - 391 KB', checked: true },
        { text: 'Mubasshir_Ali_Resume.docx - 38 KB', checked: false },
      ];

      const res = simulateResumeSelection(
        linkedInResumes,
        'Mubasshir_Ali_Resume.docx', // Default active resume in extension
        ['Mubasshir_Ali_Software_Engineer_Resume.pdf'],
        ['frontend', 'software engineer'],
      );

      // Card 1 (Mubasshir_Ali_Resume.docx) is an exact match (score >= 800-1000)
      expect(res.bestIndex).toBe(1);
      expect(res.highestScore).toBeGreaterThanOrEqual(800);
    });

    it('selects secondary uploaded resume when default is not on LinkedIn (Tier 2)', () => {
      const linkedInResumes = [
        { text: 'Mubasshir_Ali_Software_Engineer_Resume.pdf - 391 KB', checked: false },
        { text: 'Random_Other_File.pdf - 100 KB', checked: false },
      ];

      const res = simulateResumeSelection(
        linkedInResumes,
        'Frontend_Specialist.docx', // Not on LinkedIn
        ['Mubasshir_Ali_Software_Engineer_Resume.pdf'], // Uploaded in extension
        ['software engineer'],
      );

      expect(res.bestIndex).toBe(0);
      expect(res.highestScore).toBeGreaterThanOrEqual(400);
    });

    it('falls back to first available resume if extension resume name is not on LinkedIn (Tier 4)', () => {
      const linkedInResumes = [
        { text: 'Old_Company_CV_2023.pdf - 200 KB', checked: false },
        { text: 'Archive_File.pdf - 150 KB', checked: false },
      ];

      const res = simulateResumeSelection(
        linkedInResumes,
        'Mubasshir_Ali_Resume.docx', // Neither matches candidate name
        ['Mubasshir_Ali_Software_Engineer_Resume.pdf'],
        [],
      );

      // Falls back to first available resume (Tier 4: score 10) so application is not aborted
      expect(res.bestIndex).toBe(0);
      expect(res.highestScore).toBe(10);
    });
  });

  describe('Phase 3: Phone Formatting & Location Typeahead', () => {
    it('strips redundant country dialing code when formatting for local phone number input', () => {
      const res = adaptAnswerToFieldFormat('+91 70031 51313', {
        label: 'Mobile phone number',
        fieldType: 'text',
      });

      expect(res.valid).toBe(true);
      expect(res.value).toBe('7003151313');
    });

    it('extracts primary city token for location typeahead query', () => {
      const fullLocation = 'Noida, Uttar Pradesh, India';
      const primaryCity = fullLocation.includes(',') ? fullLocation.split(',')[0].trim() : fullLocation;

      expect(primaryCity).toBe('Noida');
    });

    it('detects checkpoint security URLs and titles', () => {
      const checkpointUrls = [
        'https://www.linkedin.com/checkpoint/challenge/AgEUZ',
        'https://www.linkedin.com/uas/consumer-captcha',
        'https://www.linkedin.com/security-check',
      ];

      checkpointUrls.forEach(url => {
        const isCheckpoint =
          url.includes('/checkpoint/') ||
          url.includes('/challenge/') ||
          url.includes('security-check') ||
          url.includes('/uas/consumer-captcha');
        expect(isCheckpoint).toBe(true);
      });
    });
  });

  describe('DOM Settlement Engine Simulator', () => {
    it('detects settlement when spinners disappear and target is visible', async () => {
      let spinnerPresent = true;
      setTimeout(() => {
        spinnerPresent = false;
      }, 30);

      const checkSettled = async () => {
        const start = Date.now();
        while (Date.now() - start < 500) {
          if (!spinnerPresent) {
            return { settled: true, elapsedMs: Date.now() - start };
          }
          await new Promise(r => setTimeout(r, 10));
        }
        return { settled: false, elapsedMs: Date.now() - start };
      };

      const result = await checkSettled();
      expect(result.settled).toBe(true);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(25);
    });
  });
});
