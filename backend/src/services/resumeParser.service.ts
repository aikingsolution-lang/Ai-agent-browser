import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { LlmProviderFactory } from './llm/llmProviderFactory.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import { parsedResumeSchema, type ParsedResumeData } from '../schemas/resume.schema.js';
import { isValidSkillName, cleanSkillName } from '../utils/skillValidator.js';

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
1. ZERO HALLUCINATION: Extract only factual information present in the resume. If a field is not found, leave it as an empty string, empty array, or 0.
2. EXPERIENCE CALCULATION: Calculate total integer years of professional software/work experience (e.g. 3, 5, 0) strictly based on employment history dates.
3. SKILLS WITH YEARS: Extract technical skills mentioned in the resume along with their stated or inferred years of experience based strictly on dates/tenure in the work experience section (e.g. {"React": 3, "Node.js": 2}).
   - CONCRETE TECHNICAL TOOLS ONLY: Extract specific technologies, frameworks, libraries, databases, and languages (e.g. TypeScript, React, Python, PostgreSQL, Docker, AWS).
   - REJECT GENERIC TERMS & STOPWORDS: Never extract generic buzzwords or grammatical words (e.g. "ai", "ml", "ui", "ux", "and", "the", "developer", "engineering", "programming", "software", "tech", "skills").
   - LENGTH RULE: Reject any skill name under 3 characters unless it is a standard short programming language ("Go", "R", "C#", "C").
   - NO ZERO-YEAR ARTIFACTS: Do not guess years or output 0 years for skills where duration cannot be inferred; only include skills where tenure/years can be factually determined from employment dates.
4. SCREENING FIELDS:
   - workAuthorization: If mentioned (e.g. US Citizen, Green Card, Authorized to work, H1B, Indian Citizen), extract it. Otherwise empty string.
   - noticePeriod: If mentioned in summary, header, or availability (e.g. "Immediate", "30 days", "2 weeks"), extract it. Otherwise empty string.
   - college: Extract university or college name if mentioned.
   - education: Degree name and details (e.g. "B.Tech in Computer Science").
5. WORK HISTORY: Extract all distinct past/present roles with company, title, duration, and key highlights.
6. CLEAN OUTPUT: Output ONLY a valid JSON object matching the requested schema. Do NOT include markdown code blocks, backticks, XML tags, or conversational preamble.`;

    const userPrompt = `Parse the following raw resume into a valid JSON object matching this schema:
{
  "fullName": "Candidate Name",
  "email": "candidate@example.com",
  "phoneNumber": "+1234567890",
  "currentTitle": "Software Engineer",
  "skills": ["TypeScript", "React", "Node.js", "MongoDB", "AWS"],
  "yearsOfExperience": 3,
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
  "backgroundNarrative": "A concise 2-3 sentence executive summary of the candidate's career and strengths.",
  "preferredLocation": "City, Country or Remote",
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

      // Sanitize extracted skills and skillExperience
      if (parsed.skillExperience && typeof parsed.skillExperience === 'object') {
        const validExp: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed.skillExperience)) {
          const clean = cleanSkillName(k);
          if (isValidSkillName(clean) && typeof v === 'number' && !isNaN(v) && v > 0) {
            validExp[clean] = v;
          }
        }
        parsed.skillExperience = validExp;
      }
      if (Array.isArray(parsed.skills)) {
        parsed.skills = parsed.skills.map(cleanSkillName).filter(isValidSkillName);
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
      }
    }

    return {
      fullName,
      email,
      phoneNumber,
      currentTitle: 'Software Developer',
      skills: detectedSkills,
      yearsOfExperience: 2,
      education: '',
      college,
      cgpa: '',
      noticePeriod,
      workHistory: [],
      backgroundNarrative: lines.slice(0, 10).join(' '),
      preferredLocation: '',
      workAuthorization: workAuth,
      skillExperience,
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
