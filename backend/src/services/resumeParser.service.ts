import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { LlmProviderFactory } from './llm/llmProviderFactory.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { parsedResumeSchema, type ParsedResumeData } from '../schemas/resume.schema.js';
import {
  isValidSkillName,
  cleanSkillName,
  validateAndSanitizeSkillExperience,
  cleanLocationForCityField,
} from '../utils/skillValidator.js';

export interface ParseResumeResult {
  rawText: string;
  parsedData: ParsedResumeData;
  fileName: string;
  fileSize: number;
}

export class ResumeParserService {
  /**
   * Extracts raw text from in-memory file buffer (PDF, DOCX, DOC).
   */
  public static async extractRawText(buffer: Buffer, originalName: string, mimeType: string): Promise<string> {
    const ext = (originalName.split('.').pop() || '').toLowerCase();

    try {
      if (ext === 'pdf' || mimeType.includes('pdf')) {
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        const textResult = await parser.getText();
        const text = textResult.text || '';
        await parser.destroy();
        return this.cleanExtractedText(text);
      }

      if (ext === 'docx' || ext === 'doc' || mimeType.includes('word')) {
        try {
          const mammothResult = await mammoth.extractRawText({ buffer });
          if (mammothResult.value && mammothResult.value.trim()) {
            return this.cleanExtractedText(mammothResult.value);
          }
        } catch (docxErr) {
          logger.warn('[ResumeParserService] Mammoth extraction failed, falling back to raw buffer text:', docxErr);
        }
        // Fallback: UTF-8 conversion
        const raw = buffer.toString('utf-8');
        return this.cleanExtractedText(raw);
      }

      // Fallback: UTF-8 conversion
      const raw = buffer.toString('utf-8');
      return this.cleanExtractedText(raw);
    } catch (err) {
      logger.error(`[ResumeParserService] Failed to extract raw text from ${originalName}:`, err);
      throw new AppError(
        `Unable to extract text from ${originalName}. Please ensure the file is not password protected.`,
        422,
        'TEXT_EXTRACTION_FAILED',
      );
    }
  }

  /**
   * Cleans extracted raw text (strips null characters, control characters, excess whitespace).
   */
  private static cleanExtractedText(text: string): string {
    return text
      .replace(/\u0000/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }

  /**
   * Invokes AWS Bedrock (or configured LLM provider) with a strict zero-hallucination prompt
   * and parses structured candidate attributes matching ParsedResumeData.
   */
  public static async extractStructuredData(rawText: string): Promise<ParsedResumeData> {
    if (!rawText || rawText.length < 30) {
      logger.warn('[ResumeParserService] Raw resume text is too short for AI extraction.');
      return this.fallbackHeuristicExtract(rawText);
    }

    // Limit text length to prevent context explosion (~4000 tokens / 16000 chars)
    const truncatedText = rawText.length > 16000 ? rawText.substring(0, 16000) + '...[truncated]' : rawText;

    const systemPrompt = `You are an elite, zero-hallucination AI resume intelligence engine.
Your mission is to accurately parse the provided raw resume text into structured JSON format.

RULES:
1. ZERO HALLUCINATION & ZERO FABRICATION: Extract only factual information present in the resume. If a field is not found, leave it as an empty string, empty array, or 0. NEVER invent or default to arbitrary numbers.
2. EXPERIENCE CALCULATION:
   - Calculate total integer years of professional software/work experience (e.g. 0, 1, 3, 5) strictly based on verifiable employment history dates.
   - DO NOT count college or university degree duration (e.g. a 2020–2024 B.Tech is education, NOT 4 years of work experience).
   - If the candidate is a fresher or intern with under 1 year of work history, yearsOfExperience MUST be 0 (or 1 if at least 1 full year).
3. SKILLS & SKILL EXPERIENCE (skillExperience):
   - For every primary skill identified in "skills", include it in "skillExperience" with its estimated or verified years of experience.
   - If the resume explicitly states a duration for that skill (e.g. "React (3 years)", "4+ yrs Python experience"), use that duration.
   - If the skill was used in a dated work experience role, compute the years from that role's date range.
   - For other skills listed on the resume without explicit duration, set years to candidate's verifiable yearsOfExperience (minimum 1 year, e.g. fresher/intern = 1 year of project/academic experience).
   - NEVER assign random inflated numbers (e.g. NEVER assign 5+ years for a 1-year junior). Cap all skills at verifiable yearsOfExperience (minimum 1).
   - CONCRETE TECHNICAL TOOLS ONLY: Extract specific technologies, frameworks, libraries, databases, and languages (e.g. TypeScript, React, Python, PostgreSQL, Docker, AWS).
   - REJECT GENERIC TERMS & STOPWORDS: Never extract generic buzzwords or grammatical words (e.g. "ai", "ml", "ui", "ux", "and", "the", "developer", "engineering", "programming", "software", "tech", "skills").
   - LENGTH RULE: Reject any skill name under 3 characters unless it is a standard short programming language ("Go", "R", "C#", "C").
4. SCREENING FIELDS:
   - workAuthorization: If mentioned (e.g. US Citizen, Green Card, Authorized to work, H1B, Indian Citizen), extract it. Otherwise empty string.
   - noticePeriod: If mentioned in summary, header, or availability (e.g. "Immediate", "30 days", "2 weeks"), extract it. Otherwise empty string.
   - college: Extract university or college name if mentioned.
   - education: Degree name and details (e.g. "B.Tech in Computer Science").
5. WORK EXPERIENCE (STRUCTURED):
   - Extract factual work history positions present in the resume.
   - For each role:
     {
       "company": "Company Name",
       "title": "Job Title",
       "startMonth": "Month or empty string",
       "startYear": "Year (e.g. 2023) or empty string",
       "endMonth": "Month or null if current",
       "endYear": "Year or null if current",
       "isCurrent": true/false (true if currently working here / present),
       "description": "Brief summary of responsibilities & accomplishments"
     }
    - hasWorkExperience: true if one or more legitimate work/internship positions are found, false if candidate is a fresher with no work experience.
6. WORK HISTORY: Extract all distinct past/present roles with company, title, duration, and key highlights.
7. CANDIDATE BACKGROUND NARRATIVE:
   - Synthesize a comprehensive, high-impact 2-3 paragraph professional narrative grounded strictly in the resume.
   - Paragraph 1: Professional identity, core specialization (e.g. Full Stack, Python, Frontend, MERN), total verifiable experience, and primary tech stack.
   - Paragraph 2: Key real-world projects or systems engineered, architectural decisions, databases, APIs, performance optimizations, and business impact.
   - Paragraph 3: Problem solving philosophy, engineering best practices (testing, CI/CD, clean code), and collaboration strengths.
8. GOLDEN SCREENING ANSWERS (goldenAnswers):
   - Generate calibrated baseline gatekeeper screening answers based on the candidate's factual location, legal eligibility, work authorization, visa sponsorship, and age from the resume:
     [
       {
         "id": "work_auth",
         "question": "Are you legally authorized to work in India / your resident country?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "visa_sponsorship",
         "question": "Will you now or in the future require visa sponsorship?",
         "answer": "No",
         "category": "Eligibility / Legal",
         "isDefault": true
       },
       {
         "id": "age_requirement",
         "question": "Are you at least 18 years of age or older?",
         "answer": "Yes",
         "category": "Eligibility / Legal",
         "isDefault": true
       }
     ]
9. CLEAN OUTPUT: Output ONLY a valid JSON object matching the requested schema. Do NOT include markdown code blocks, backticks, XML tags, or conversational preamble.`;

    const userPrompt = `Parse the following raw resume into a valid JSON object matching this schema:
{
  "fullName": "Candidate Name",
  "email": "candidate@example.com",
  "phoneNumber": "+1234567890",
  "currentTitle": "Software Engineer",
  "skills": ["TypeScript", "React", "Node.js", "MongoDB", "AWS"],
  "yearsOfExperience": 3,
  "hasWorkExperience": true,
  "workExperience": [
    {
      "company": "ABC Corp",
      "title": "Frontend Developer",
      "startMonth": "Jan",
      "startYear": "2023",
      "endMonth": null,
      "endYear": null,
      "isCurrent": true,
      "description": "Built responsive dashboards with React and Redux."
    }
  ],
  "education": "B.Tech in Computer Science, XYZ University, 2023",
  "college": "XYZ University",
  "noticePeriod": "Immediate",
  "workAuthorization": "Authorized to work without sponsorship",
  "skillExperience": {
    "React": 3,
    "Node.js": 2
  },
  "workHistory": [
    {
      "role": "Frontend Developer",
      "company": "ABC Corp",
      "duration": "2023 - Present",
      "highlights": ["Built dashboard", "Improved performance"]
    }
  ],
  "backgroundNarrative": "A rich, comprehensive 2-3 paragraph professional narrative describing technical background, key projects built, technologies mastered, architecture & problem solving approach, and work style, grounded strictly in the resume.",
  "goldenAnswers": [
    {
      "id": "work_auth",
      "question": "Are you legally authorized to work in India / your resident country?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "visa_sponsorship",
      "question": "Will you now or in the future require visa sponsorship?",
      "answer": "No",
      "category": "Eligibility / Legal",
      "isDefault": true
    },
    {
      "id": "age_requirement",
      "question": "Are you at least 18 years of age or older?",
      "answer": "Yes",
      "category": "Eligibility / Legal",
      "isDefault": true
    }
  ],
  "currentLocation": "City, State, Country (e.g. Bengaluru, Karnataka, India or San Francisco, California, United States. Standard LinkedIn/Indeed/Naukri format)",
  "preferredLocation": "City, State, Country (e.g. Bengaluru, Karnataka, India. Do NOT append 'or Remote')",
  "salaryExpectation": "",
  "portfolioUrl": "",
  "githubUrl": "",
  "linkedinUrl": ""
}

=== RAW RESUME TEXT ===
${truncatedText}`;

    try {
      const llm = LlmProviderFactory.getProvider();
      const model = env.LLM_DEFAULT_MODEL || 'anthropic.claude-3-5-sonnet-20240620-v1:0';

      const response = await llm.generateCompletion({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        maxTokens: 3000,
      });

      // Strict Regex Cleaning: Handle Bedrock Claude/Nova ```json or XML tags
      let cleaned = (response.content || '').trim();
      cleaned = cleaned.replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, '').trim();
      cleaned = cleaned
        .replace(/```(?:json)?/gi, '')
        .replace(/```/g, '')
        .trim();

      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }

      const parsed = JSON.parse(cleaned);

      // 1. Sanitize extracted workExperience first
      if (Array.isArray(parsed.workExperience)) {
        parsed.workExperience = parsed.workExperience
          .filter((item: any) => item && (item.company || item.title))
          .map((item: any) => ({
            id: item.id || `we_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            company: String(item.company || '').trim(),
            title: String(item.title || '').trim(),
            startMonth: String(item.startMonth || '').trim(),
            startYear: String(item.startYear || '').trim(),
            endMonth: item.isCurrent ? null : item.endMonth ? String(item.endMonth).trim() : null,
            endYear: item.isCurrent ? null : item.endYear ? String(item.endYear).trim() : null,
            isCurrent: Boolean(item.isCurrent),
            description: String(item.description || '').trim(),
            source: 'resume',
          }));
        if (parsed.workExperience.length > 0) {
          parsed.hasWorkExperience = true;
        }
      }

      // 2. Sanitize extracted skills
      if (Array.isArray(parsed.skills)) {
        parsed.skills = parsed.skills.map(cleanSkillName).filter(isValidSkillName);
      }

      // 3. Sanitize extracted skillExperience against verifiable work dates & resume text
      if (parsed.skillExperience && typeof parsed.skillExperience === 'object') {
        parsed.skillExperience = validateAndSanitizeSkillExperience(
          parsed.skillExperience,
          parsed.workExperience,
          rawText,
          parsed.yearsOfExperience,
        );
      } else {
        parsed.skillExperience = {};
      }

      // 3b. Auto-seed ALL extracted Primary Skills into skillExperience
      const candidateTenure = Math.max(1, Math.min(parsed.yearsOfExperience || 1, 99));
      if (Array.isArray(parsed.skills)) {
        for (const skill of parsed.skills) {
          const clean = cleanSkillName(skill);
          if (isValidSkillName(clean) && (!parsed.skillExperience[clean] || parsed.skillExperience[clean] <= 0)) {
            parsed.skillExperience[clean] = candidateTenure;
          }
        }
      }

      // 4. Sanitize currentLocation and preferredLocation (strip any 'or Remote' / 'Remote /' suffixes)
      if (parsed.currentLocation) {
        parsed.currentLocation = cleanLocationForCityField(parsed.currentLocation) || parsed.currentLocation;
      }
      if (parsed.preferredLocation) {
        parsed.preferredLocation = cleanLocationForCityField(parsed.preferredLocation) || parsed.preferredLocation;
      }

      // 5. Sanitize goldenAnswers
      if (Array.isArray(parsed.goldenAnswers)) {
        parsed.goldenAnswers = parsed.goldenAnswers
          .filter((item: any) => item && item.question && item.answer)
          .map((item: any) => ({
            id: String(item.id || `ga_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`),
            question: String(item.question).trim(),
            answer: String(item.answer).trim(),
            category: item.category || 'Eligibility / Legal',
            isDefault: Boolean(item.isDefault ?? true),
          }));
      }

      // 6. Sanitize currentTitle: Ensure candidate personal name or placeholder is never used as target role
      if (parsed.currentTitle) {
        const cleanTitle = String(parsed.currentTitle).trim();
        const cleanFull = String(parsed.fullName || '')
          .trim()
          .toLowerCase();
        const titleLo = cleanTitle.toLowerCase();
        const isName =
          cleanFull && (titleLo === cleanFull || titleLo.includes(cleanFull) || cleanFull.includes(titleLo));
        const isGeneric =
          /^(candidate|user|applicant|n\/a|developer|engineer|title|job title|software professional)$/i.test(titleLo);
        if (isName || isGeneric) {
          logger.warn(
            `[ResumeParserService] currentTitle "${cleanTitle}" matched candidate name or generic placeholder. Sanitized to "Full Stack Developer".`,
          );
          parsed.currentTitle = 'Full Stack Developer';
        }
      }

      const validated = parsedResumeSchema.safeParse(parsed);

      if (validated.success) {
        logger.info(
          `[ResumeParserService] Successfully parsed resume for "${validated.data.fullName}" with ${validated.data.skills.length} skills.`,
        );
        return validated.data;
      }

      logger.warn(
        '[ResumeParserService] Schema validation warning, returning safe defaults with raw object:',
        validated.error.format(),
      );
      return parsedResumeSchema.parse(parsed);
    } catch (error) {
      logger.warn(
        '[ResumeParserService] LLM JSON parsing failed or Bedrock unavailable, falling back to heuristic parsing:',
        error,
      );
      return this.fallbackHeuristicExtract(rawText);
    }
  }

  /**
   * Fast regex and heuristic extraction fallback if LLM inference is unreachable or returns malformed text.
   */
  public static fallbackHeuristicExtract(rawText: string): ParsedResumeData {
    const lines = rawText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    // Heuristic Name: usually first non-empty line with 2-4 words
    let fullName = 'Candidate';
    for (const line of lines.slice(0, 5)) {
      if (line.length > 2 && line.length < 50 && !line.includes('@') && !line.includes('http')) {
        fullName = line;
        break;
      }
    }

    // Email regex
    const emailMatch = rawText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0] : '';

    // Phone regex
    const phoneMatch = rawText.match(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/);
    const phoneNumber = phoneMatch ? phoneMatch[0] : '';

    // Links regex
    const linkedinMatch = rawText.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+/i);
    const githubMatch = rawText.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
    const portfolioMatch = rawText.match(
      /https?:\/\/(?!www\.linkedin|www\.github)[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}[^\s]*/i,
    );

    // Core skills heuristic extraction
    const commonSkills = [
      'JavaScript',
      'TypeScript',
      'React',
      'Node.js',
      'Python',
      'Java',
      'C++',
      'Go',
      'HTML',
      'CSS',
      'SQL',
      'MongoDB',
      'PostgreSQL',
      'AWS',
      'Docker',
      'Kubernetes',
      'Git',
      'REST API',
      'GraphQL',
      'Express',
      'Next.js',
      'Redux',
      'Tailwind CSS',
    ];

    const detectedSkills: string[] = [];
    const lowerText = rawText.toLowerCase();
    for (const skill of commonSkills) {
      if (lowerText.includes(skill.toLowerCase())) {
        detectedSkills.push(skill);
      }
    }

    // College heuristic
    const collegeMatch = rawText.match(
      /(?:(?:bachelor|master|b\.?tech|m\.?tech|bca|mca|b\.?s|m\.?s|degree)\s+(?:in|of)\s+[^\n,]+,\s*|at\s+|from\s+)?([A-Za-z\s]+(?:University|College|Institute|Academy|Polytechnic)[A-Za-z\s,]*)/i,
    );
    const college = collegeMatch ? collegeMatch[1].trim().slice(0, 80) : '';

    // Notice period heuristic
    let noticePeriod = '';
    const noticeMatch = rawText.match(
      /(?:notice\s*period|immediate\s*joiner|serving\s*notice|availability)\s*[:\-]?\s*([a-zA-Z0-9\s]+?)(?:\.|\n|$)/i,
    );
    if (noticeMatch) {
      noticePeriod = noticeMatch[1].trim();
    } else if (/\bimmediate\s*(?:joiner|availability)\b/i.test(rawText)) {
      noticePeriod = 'Immediate';
    }

    // Work authorization heuristic
    let workAuth = 'Authorized to work without sponsorship';
    if (/us\s*citizen|green\s*card/i.test(rawText)) {
      workAuth = 'US Citizen / Green Card (No sponsorship required)';
    } else if (/citizen\s*of\s*india|indian\s*citizen/i.test(rawText)) {
      workAuth = 'Citizen of India / Authorized to work without sponsorship';
    }

    // Heuristic skillExperience
    const skillExperience: Record<string, number> = {};
    for (const skill of detectedSkills) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const yrsMatch =
        rawText.match(
          new RegExp(`\\b${escaped}\\b[^\\n\\r,]{0,25}?\\(?(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)\\)?`, 'i'),
        ) ||
        rawText.match(
          new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:\\+)?\\s*(?:years?|yrs?)[^\\n\\r,]{0,25}?\\b${escaped}\\b`, 'i'),
        );
      if (yrsMatch && yrsMatch[1]) {
        skillExperience[skill] = Math.round(parseFloat(yrsMatch[1]));
      } else {
        skillExperience[skill] = 2;
      }
    }

    return {
      fullName,
      email,
      phoneNumber,
      currentTitle: 'Software Developer',
      skills: detectedSkills,
      yearsOfExperience: 2,
      hasWorkExperience: false,
      workExperience: [],
      education: '',
      college,
      cgpa: '',
      noticePeriod,
      workHistory: [],
      backgroundNarrative: lines.slice(0, 10).join(' '),
      currentLocation: '',
      preferredLocation: '',
      preferredLocations: [],
      workAuthorization: workAuth,
      skillExperience,
      goldenAnswers: [
        {
          id: 'work_auth',
          question: 'Are you legally authorized to work in India / your resident country?',
          answer: 'Yes',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
        {
          id: 'visa_sponsorship',
          question: 'Will you now or in the future require visa sponsorship?',
          answer: 'No',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
        {
          id: 'age_requirement',
          question: 'Are you at least 18 years of age or older?',
          answer: 'Yes',
          category: 'Eligibility / Legal',
          isDefault: true,
        },
      ],
      salaryExpectation: '',
      portfolioUrl: portfolioMatch ? portfolioMatch[0] : '',
      githubUrl: githubMatch ? githubMatch[0] : '',
      linkedinUrl: linkedinMatch ? linkedinMatch[0] : '',
    };
  }

  /**
   * End-to-end handler: Extracts text, runs AI parsing, and returns complete structured payload.
   */
  public static async parseResume(buffer: Buffer, originalName: string, mimeType: string): Promise<ParseResumeResult> {
    const rawText = await this.extractRawText(buffer, originalName, mimeType);
    const parsedData = await this.extractStructuredData(rawText);

    return {
      rawText,
      parsedData,
      fileName: originalName,
      fileSize: buffer.length,
    };
  }
}
