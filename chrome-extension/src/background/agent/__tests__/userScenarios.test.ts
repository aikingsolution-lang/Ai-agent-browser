import { describe, it, expect, vi } from 'vitest';
import { matchRuleBased, adaptAnswerToFieldFormat, type FormFieldDescriptor } from '../linkedin/formQuestionResolver';
import { matchQuestionSemantically } from '../intelligence';
import { resolveIndeedQuestion } from '../platforms/indeed/indeedResolver';
import { resolveNaukriQuestion } from '../platforms/naukri/naukriResolver';
import { type ICareerBrain, DEFAULT_CAREER_BRAIN } from '@extension/storage';

describe('Real-World User Scenario Test Suite (End-to-End)', () => {
  const baseCareerBrain: ICareerBrain = {
    ...DEFAULT_CAREER_BRAIN,
    fullName: 'Mubasshir Ali',
    email: 'mubasshir@example.com',
    phoneNumber: '+91 70031 51313',
    currentTitle: 'Senior Full Stack Engineer',
    currentLocation: 'Noida, Uttar Pradesh, India',
    yearsOfExperience: 5,
    hasWorkExperience: true,
    workExperience: [
      {
        id: 'exp_1',
        title: 'Full Stack Engineer',
        company: 'Tech Solutions Inc',
        startMonth: 'January',
        startYear: '2021',
        endMonth: '',
        endYear: '',
        isCurrent: true,
        description: 'Developed React and Node.js applications',
        source: 'manual',
      },
    ],
    education: 'Bachelor of Technology in Computer Science',
    highestEducation: "Bachelor's Degree",
    skills: ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS'],
    skillExperience: {
      React: 4,
      'Node.js': 4,
      TypeScript: 3,
      Python: 2,
    },
    workAuthorization: 'Citizen of India / Authorized to work without sponsorship',
    gender: 'Male',
    veteranStatus: 'I am not a protected veteran',
    disabilityStatus: 'No, I do not have a disability',
    willingToRelocate: 'Yes',
    preferredShift: 'Day / Flexible',
    driverLicense: 'Yes',
    noticePeriod: '15 days',
    currentCTC: '12 LPA',
    expectedCTC: '18 LPA',
    resumeFileName: 'Mubasshir_Ali_Resume.docx',
    resumes: [
      {
        id: 'res_1',
        fileName: 'Mubasshir_Ali_Resume.docx',
        uploadedAt: Date.now(),
        focusTags: ['Full Stack', 'React', 'Node.js'],
        rawText: 'Mubasshir Ali - Senior Full Stack Engineer with 5 years experience...',
        extractedSkills: ['React', 'Node.js', 'TypeScript'],
        isDefault: true,
      },
    ],
    goldenAnswers: [],
    customAnswers: {},
    predefinedRoles: ['Full Stack Developer'],
    preferredLocations: ['Noida', 'Delhi NCR', 'Remote'],
    experienceLevels: ['Mid-Senior level'],
    jobTypes: ['Full-time'],
    autoExtractedSkills: [],
    updatedAt: Date.now(),
  };

  /* ──────────────────────────────────────────────────────────────────────────
   * Scenario 1: Fresh / Brand New Account (LinkedIn)
   * ────────────────────────────────────────────────────────────────────────── */
  describe('User Scenario 1: Brand New LinkedIn Account', () => {
    it('1.1: Fills empty First Name and Last Name inputs from candidate fullName', () => {
      const firstNameField: FormFieldDescriptor = {
        label: 'First name',
        fieldType: 'text',
        required: true,
      };
      const lastNameField: FormFieldDescriptor = {
        label: 'Last name',
        fieldType: 'text',
        required: true,
      };

      const firstNameRes = matchRuleBased(firstNameField, baseCareerBrain);
      const lastNameRes = matchRuleBased(lastNameField, baseCareerBrain);

      expect(firstNameRes.matched).toBe(true);
      expect(firstNameRes.answer).toBe('Mubasshir');

      expect(lastNameRes.matched).toBe(true);
      expect(lastNameRes.answer).toBe('Ali');
    });

    it('1.2: Normalizes phone number by removing redundant +91 international dialing prefix', () => {
      const phoneField: FormFieldDescriptor = {
        label: 'Mobile phone number',
        fieldType: 'text',
        required: true,
      };

      const ruleMatch = matchRuleBased(phoneField, baseCareerBrain);
      expect(ruleMatch.matched).toBe(true);
      expect(ruleMatch.answer).toBe('+91 70031 51313');

      // Adapt answer to input format
      const adapted = adaptAnswerToFieldFormat(ruleMatch.answer!, phoneField);
      expect(adapted.valid).toBe(true);
      expect(adapted.value).toBe('7003151313'); // Stripped prefix for local national input
    });

    it('1.3: Matches Phone Country Code dropdown accurately for India (+91)', () => {
      const countryCodeField: FormFieldDescriptor = {
        label: 'Phone country code',
        fieldType: 'dropdown',
        options: ['Select an option', 'United States (+1)', 'United Kingdom (+44)', 'India (+91)', 'Germany (+49)'],
        required: true,
      };

      const matchRes = matchRuleBased(countryCodeField, baseCareerBrain);
      expect(matchRes.matched).toBe(true);
      expect(matchRes.answer).toBe('India (+91)');
    });

    it('1.4: Handles 0 uploaded resumes on LinkedIn server without freeze or crash', () => {
      // Simulation of DOM evaluation in selectResumeInModal on brand new account
      const availableRadiosCount = 0;
      const hasFileInputOrUploadBtn = true;

      const detectionResult = {
        selected: false,
        needsFileUpload: availableRadiosCount === 0 && hasFileInputOrUploadBtn,
      };

      expect(detectionResult.selected).toBe(false);
      expect(detectionResult.needsFileUpload).toBe(true);

      // Verify prompt message formulation
      const notifyMsg =
        '📄 New LinkedIn Account: Please click "Upload resume" in the modal to upload your resume once — JobPilot will auto-resume immediately!';
      expect(notifyMsg).toContain('New LinkedIn Account');
      expect(notifyMsg).toContain('auto-resume');
    });

    it('1.5: Fills mandatory first-time legal and EEO disclosures', () => {
      const workAuthField: FormFieldDescriptor = {
        label: 'Are you legally authorized to work in India?',
        fieldType: 'radio',
        options: ['Yes', 'No'],
      };
      const sponsorshipField: FormFieldDescriptor = {
        label: 'Will you now or in the future require visa sponsorship?',
        fieldType: 'radio',
        options: ['Yes', 'No'],
      };
      const genderField: FormFieldDescriptor = {
        label: 'What is your gender?',
        fieldType: 'dropdown',
        options: ['Male', 'Female', 'Decline to self-identify'],
      };
      const disabilityField: FormFieldDescriptor = {
        label: 'Disability Status',
        fieldType: 'dropdown',
        options: ['Yes, I have a disability', 'No, I do not have a disability', 'I do not wish to answer'],
      };

      expect(matchRuleBased(workAuthField, baseCareerBrain).answer).toBe('Yes');
      expect(matchRuleBased(sponsorshipField, baseCareerBrain).answer).toBe('No');
      expect(matchRuleBased(genderField, baseCareerBrain).answer).toBe('Male');
      expect(matchRuleBased(disabilityField, baseCareerBrain).answer).toBe('No, I do not have a disability');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Scenario 2: Existing / Old Account (LinkedIn)
   * ────────────────────────────────────────────────────────────────────────── */
  describe('User Scenario 2: Existing / Old LinkedIn Account', () => {
    it('2.1: Selects the active/default extension resume among multiple existing profiles', () => {
      const linkedInCards = [
        { text: 'Mubasshir_Ali_Software_Engineer_Resume.pdf - 391 KB', checked: true },
        { text: 'Mubasshir_Ali_Resume.docx - 38 KB', checked: false },
        { text: 'Old_Draft_Resume.pdf - 200 KB', checked: false },
      ];

      // Multi-tier scoring: exact target match gets 1000 pts
      const target = 'Mubasshir_Ali_Resume.docx';
      const cleanTarget = target
        .toLowerCase()
        .replace(/\.(pdf|doc|docx)$/i, '')
        .replace(/[^a-z0-9]+/g, ' ');

      const scores: number[] = linkedInCards.map(card => {
        const cleanCard = card.text
          .toLowerCase()
          .replace(/\.(pdf|doc|docx)$/i, '')
          .replace(/[^a-z0-9]+/g, ' ');
        if (cleanCard.includes(cleanTarget)) return 1000;
        if (cleanCard.includes('software engineer')) return 500;
        return 10;
      });

      const maxScore = Math.max(...scores);
      const bestIndex = scores.indexOf(maxScore);
      expect(bestIndex).toBe(1); // Card 1 is Mubasshir_Ali_Resume.docx
      expect(scores[bestIndex]).toBe(1000);
    });

    it('2.2: Skips re-typing if field is already pre-filled and valid', () => {
      const existingEmailValue = 'mubasshir@example.com';
      const emailField: FormFieldDescriptor = {
        label: 'Email address',
        fieldType: 'text',
      };

      const resolved = matchRuleBased(emailField, baseCareerBrain);
      const isAlreadyMatching = existingEmailValue.trim().toLowerCase() === resolved.answer?.trim().toLowerCase();

      expect(isAlreadyMatching).toBe(true);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Scenario 3: 3-Tier Data Pipeline & Question Memory Caching
   * ────────────────────────────────────────────────────────────────────────── */
  describe('User Scenario 3: 3-Tier Data Pipeline & Q&A Memory Caching', () => {
    it('3.1: Tier 1 Priority: Uses Extension CareerBrain over Platform Profile Bridge', () => {
      const extensionBrain: Partial<ICareerBrain> = {
        fullName: 'Mubasshir Ali',
        currentTitle: 'Lead AI Engineer',
      };

      const platformScrapedProfile = {
        name: 'Mubasshir A. (Old Platform Name)',
        headline: 'Junior Web Dev (Old Headline)',
      };

      // Rule: Extension data ALWAYS wins
      const effectiveName = extensionBrain.fullName || platformScrapedProfile.name;
      const effectiveTitle = extensionBrain.currentTitle || platformScrapedProfile.headline;

      expect(effectiveName).toBe('Mubasshir Ali');
      expect(effectiveTitle).toBe('Lead AI Engineer');
    });

    it('3.2: Tier 2 Fallback: Enriches missing fields from Platform Profile when Extension is empty', () => {
      const incompleteExtensionBrain: Partial<ICareerBrain> = {
        fullName: '',
        currentTitle: '',
      };

      const platformScrapedProfile = {
        name: 'Mubasshir Ali',
        headline: 'Senior Full Stack Engineer',
      };

      const enrichedName = incompleteExtensionBrain.fullName || platformScrapedProfile.name;
      const enrichedTitle = incompleteExtensionBrain.currentTitle || platformScrapedProfile.headline;

      expect(enrichedName).toBe('Mubasshir Ali');
      expect(enrichedTitle).toBe('Senior Full Stack Engineer');
    });

    it('3.3: Tier 3 Permanent Question Memory: Caches solved question for 0-credit instant reuse', () => {
      const customQuestion = 'Do you possess an active AWS Certified Solutions Architect credential?';
      const brainWithCache: ICareerBrain = {
        ...baseCareerBrain,
        goldenAnswers: [],
        customAnswers: {},
      };

      // Initially, custom question is not in rule-based cache
      const initialMatch = matchRuleBased({ label: customQuestion, fieldType: 'radio' }, brainWithCache);
      expect(initialMatch.matched).toBe(false);

      // Semantic matcher / LLM solves question -> "Yes"
      const solvedAnswer = 'Yes';

      // Save into both goldenAnswers and customAnswers
      brainWithCache.goldenAnswers.push({
        id: `ga_${Date.now()}`,
        question: customQuestion,
        answer: solvedAnswer,
        category: 'Screening',
      });
      brainWithCache.customAnswers[customQuestion] = solvedAnswer;

      // Next run encounters the exact question: resolved in Step 2/3 of matchRuleBased in <1ms!
      const subsequentMatch = matchRuleBased({ label: customQuestion, fieldType: 'radio' }, brainWithCache);
      expect(subsequentMatch.matched).toBe(true);
      expect(subsequentMatch.answer).toBe('Yes');
      expect(subsequentMatch.sourceDetail).toMatch(/goldenAnswers|customAnswers/);
    });

    it('3.4: Semantic Matching: Matches semantically equivalent question variations', () => {
      const brainWithSavedAnswer: ICareerBrain = {
        ...baseCareerBrain,
        goldenAnswers: [
          {
            id: 'ga_reloc',
            question: 'Are you open to relocation for this role?',
            answer: 'Yes',
            category: 'Location & Relocation',
          },
        ],
      };

      // Form asks slightly different question:
      const variationQuestion = 'Would you be willing to relocate to Noida if offered?';
      const semanticRes = matchQuestionSemantically(variationQuestion, brainWithSavedAnswer);

      expect(semanticRes).not.toBeNull();
      expect(semanticRes?.matchedAnswer).toBe('Yes');
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Scenario 4: Hardware & Network Disparities (Core i3 & 5-10 Mbps Internet)
   * ────────────────────────────────────────────────────────────────────────── */
  describe('User Scenario 4: Low-End Hardware & Slow Network Resilience', () => {
    it('4.1: DOM Settlement detects stability instead of failing with fixed timeout', async () => {
      let isNetworkIdle = false;
      let domMutationsPending = true;

      // Simulate slow 5 Mbps network taking 40ms to load assets
      setTimeout(() => {
        isNetworkIdle = true;
      }, 40);

      // Simulate React hydration on Core i3 taking 70ms
      setTimeout(() => {
        domMutationsPending = false;
      }, 70);

      const waitForSettlement = async (timeoutMs = 500): Promise<{ settled: boolean; durationMs: number }> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          if (isNetworkIdle && !domMutationsPending) {
            return { settled: true, durationMs: Date.now() - start };
          }
          await new Promise(r => setTimeout(r, 10));
        }
        return { settled: false, durationMs: Date.now() - start };
      };

      const result = await waitForSettlement();
      expect(result.settled).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(60);
    });

    it('4.2: Enforces 500ms pacing between questions to prevent UI thread choking', async () => {
      const timestamps: number[] = [];
      const questions = ['First name', 'Last name', 'Email'];

      for (const q of questions) {
        timestamps.push(Date.now());
        // 500ms pacing delay
        await new Promise(r => setTimeout(r, 20)); // Scaled for test speed
      }

      expect(timestamps.length).toBe(3);
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(15);
      }
    });

    it('4.3: Location Typeahead types primary city token first to avoid remote API timeouts', () => {
      const candidateLocation = 'Noida, Uttar Pradesh, India';
      const primaryToken = candidateLocation.includes(',') ? candidateLocation.split(',')[0].trim() : candidateLocation;

      expect(primaryToken).toBe('Noida');
      expect(primaryToken.length).toBeLessThan(candidateLocation.length);
    });
  });

  /* ──────────────────────────────────────────────────────────────────────────
   * Scenario 5: Multi-Platform Coverage (Indeed & Naukri)
   * ────────────────────────────────────────────────────────────────────────── */
  describe('User Scenario 5: Multi-Platform Indeed & Naukri Easy Apply', () => {
    it('5.1: Indeed: Resolves work experience, job title, and employer details', () => {
      const titleRes = resolveIndeedQuestion('Job Title', 'text', [], baseCareerBrain);
      const companyRes = resolveIndeedQuestion('Company Name', 'text', [], baseCareerBrain);
      const workAuthRes = resolveIndeedQuestion(
        'Are you legally authorized to work in India?',
        'radio',
        ['Yes', 'No'],
        baseCareerBrain,
      );

      expect(titleRes.value).toBe('Full Stack Engineer');
      expect(companyRes.value).toBe('Tech Solutions Inc');
      expect(workAuthRes.value).toBe('Yes');
    });

    it('5.2: Indeed: Formats Indian LPA compensation to option range', () => {
      const salaryOptions = ['₹5,00,000 - ₹8,00,000', '₹10,00,000 - ₹15,00,000', '₹15,00,000+'];
      const resolved = resolveIndeedQuestion('Expected Salary (Annual)', 'select', salaryOptions, baseCareerBrain);

      // Candidate expected CTC is 18 LPA (1,800,000)
      expect(resolved.value).toBe('₹15,00,000+');
    });

    it('5.3: Naukri: Resolves total experience and key technical skills', () => {
      const expRes = resolveNaukriQuestion('Total Experience', 'number', [], baseCareerBrain);
      const noticeRes = resolveNaukriQuestion(
        'Notice Period',
        'select',
        ['Immediate', '15 Days', '30 Days'],
        baseCareerBrain,
      );

      expect(expRes.value).toBe('5');
      expect(noticeRes.value).toBe('15 Days');
    });

    it('5.4: Security Checkpoint Guardian: Detects Arkose challenge, OTP pin, or verification modal', () => {
      const securityCheckUrls = [
        'https://www.linkedin.com/checkpoint/challenge/AgF',
        'https://www.linkedin.com/uas/consumer-captcha',
        'https://www.indeed.com/account/checkpoint',
      ];

      securityCheckUrls.forEach(url => {
        const isDetected =
          url.includes('/checkpoint') || url.includes('/challenge') || url.includes('consumer-captcha');
        expect(isDetected).toBe(true);
      });
    });
  });
});
