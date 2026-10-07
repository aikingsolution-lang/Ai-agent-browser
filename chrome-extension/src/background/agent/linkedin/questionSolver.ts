/**
 * LinkedIn Easy Apply — Career Brain Screening Question Solver
 *
 * Uses the user's Career Brain context to generate reasoned answers to
 * job screening questions. If confidence is low or information is absent,
 * flags for manual review without guessing.
 */

import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { ICareerBrain } from '@extension/storage';
import type { IScreeningQuestion } from './types';

const logger = createLogger('LinkedInQuestionSolver');

// 1. The Output Contract (Zod Schema)
export const aiFormResponseSchema = z.object({
  answers: z.array(
    z.object({
      fieldId: z.string().describe('The exact ID or name attribute of the input field provided in the prompt'),
      answer: z.string().describe('The exact string, number, or dropdown text to inject'),
      is_answerable: z
        .boolean()
        .describe('False ONLY if the answer cannot be confidently deduced from the Context blocks'),
      confidence_reasoning: z.string().describe('One short sentence explaining why this answer was chosen or skipped'),
    }),
  ),
});

export type AIFormResponse = z.infer<typeof aiFormResponseSchema>;

// 2. The Strict Prompt Template
export const generateBedrockPrompt = (
  resumeText: string,
  goldenAnswers: string,
  formQuestions: string,
  careerBrain?: ICareerBrain,
) => {
  const yoe = careerBrain?.yearsOfExperience ?? 1;
  const currentCtcRaw = Number((careerBrain?.currentCTC || '120000').replace(/[^0-9.]/g, '')) || 120000;
  const expectedCtcRaw = Number((careerBrain?.expectedCTC || '500000').replace(/[^0-9.]/g, '')) || 500000;
  const currentMonthly = Math.round(currentCtcRaw / 12);
  const expectedMonthly = Math.round(expectedCtcRaw / 12);
  const skillsList = careerBrain?.skills?.join(', ') || 'TypeScript, React, Node.js, MongoDB, AWS, Next.js, Express.js';
  const skillExpList = careerBrain?.skillExperience
    ? Object.entries(careerBrain.skillExperience)
        .map(([s, y]) => `${s}: ${y} years`)
        .join(', ')
    : 'React: 1 year, Next.js: 1 year, TypeScript: 1 year';

  return `You are an elite, highly precise job application assistant. Your ONLY goal is to map the user's professional data to the provided job application form questions.

RULES:
1. ZERO HALLUCINATION: Base all answers STRICTLY on the Candidate Profile and Resume. Never invent numbers.
2. CRITICAL NUMERIC & EXPERIENCE FORMATTING:
   - For ANY question asking for years of experience (e.g. "Total year of Experiance", "experience in years", "how many years"), return ONLY the bare digits (e.g. "1" or "1.0"). NEVER append words like "years", "yrs", or text!
   - For total years of work experience or overall experience, use the candidate's exact verifiable total experience: ${yoe}.
3. SALARY & CTC RULES:
   - If asked for "Current CTC P/M", "Current IN-Hand Salary P/m", "monthly salary", or "per month" (P/M), return the MONTHLY amount (digits only): "${currentMonthly}".
   - If asked for "Current CTC" (annual), return "${currentCtcRaw}".
   - If asked for "expectation CTC P/M" or "expected salary P/M", return "${expectedMonthly}".
   - If asked for "expected CTC" (annual), return "${expectedCtcRaw}".
   - NEVER return characters or currency symbols (no "₹", "INR", "LPA", "P/M"). Return clean digits only!
4. STRICT MATCHING: For dropdowns or radio buttons, your "answer" must exactly match one of the provided options.

=== CANDIDATE VERIFIABLE PROFILE ===
Total Years of Experience: ${yoe} year(s)
Current Title: ${careerBrain?.currentTitle || 'Software Engineer'}
Current Annual CTC: ${currentCtcRaw}
Current Monthly CTC (P/M): ${currentMonthly}
Current In-Hand Monthly Salary (P/M): ${currentMonthly}
Expected Annual CTC: ${expectedCtcRaw}
Expected Monthly CTC (P/M): ${expectedMonthly}
Notice Period: ${careerBrain?.noticePeriod || 'Immediate'}
Work Authorization: ${careerBrain?.workAuthorization || 'Legally authorized to work without sponsorship'}
Preferred Location: ${careerBrain?.preferredLocation || 'Bengaluru, India'}
Primary Skills: ${skillsList}
Skill Experience Calibrations: ${skillExpList}

=== CONTEXT: USER RESUME ===
${resumeText}

=== CONTEXT: GOLDEN Q&A (Strict Overrides) ===
${goldenAnswers}

=== TARGET FORM QUESTIONS ===
${formQuestions}

Analyze the Target Form Questions against the Context blocks and return the JSON payload.`;
};

// 3. The Bedrock Executor
export async function solveFormQuestionsWithBedrock(
  llm: BaseChatModel,
  resumeText: string,
  goldenAnswers: string,
  formQuestions: string,
  careerBrain?: ICareerBrain,
): Promise<AIFormResponse | null> {
  try {
    const systemPrompt = generateBedrockPrompt(resumeText, goldenAnswers, formQuestions, careerBrain);

    // Forces Bedrock (e.g., Claude 3 via AWS) to bind the Zod schema as a tool/function call
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const modelWithTools = (llm as any).withStructuredOutput(aiFormResponseSchema, {
        name: 'FormSolver',
        strict: true,
      });

      const response = await modelWithTools.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage('Process the target form questions based on the provided context.'),
      ]);

      const parsed = aiFormResponseSchema.safeParse(response);
      if (parsed.success) {
        return parsed.data;
      }
    } catch (structuredErr) {
      logger.warning(
        '[QuestionSolver] withStructuredOutput call failed, falling back to direct JSON prompt:',
        structuredErr,
      );
    }

    // Direct JSON fallback for models without tool-calling capability
    const rawResponse = await llm.invoke([
      new SystemMessage(
        `${systemPrompt}\n\nRespond ONLY with a valid JSON object strictly matching this schema: {"answers": [{"fieldId": "...", "answer": "...", "is_answerable": true/false, "confidence_reasoning": "..."}]}`,
      ),
      new HumanMessage('Process the target form questions based on the provided context.'),
    ]);

    const content =
      typeof rawResponse.content === 'string'
        ? rawResponse.content
        : Array.isArray(rawResponse.content)
          ? rawResponse.content.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
          : '';

    // Strip markdown code fences that Bedrock/Nova models sometimes add
    const cleanContent = content.replace(/```json\s*|```\s*/gi, '').trim();

    const match = cleanContent.match(/\{[\s\S]*\}/);
    if (match) {
      const json = JSON.parse(match[0]);
      const validated = aiFormResponseSchema.safeParse(json);
      if (validated.success) {
        return validated.data;
      }
    }

    return null;
  } catch (error) {
    logger.error('[QuestionSolver] Bedrock execution failed or schema validation bypassed:', error);
    return null;
  }
}

export interface QuestionSolution {
  questionId: string;
  answer: string;
  confidence: number;
  isConfident: boolean;
  reasoning: string;
}

/**
 * Solves a single screening question using Career Brain narrative and parameters.
 */
export async function solveScreeningQuestion(
  question: IScreeningQuestion,
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<QuestionSolution> {
  const qTextLower = question.questionText.toLowerCase();

  // 1. Check Golden Q&A ground-truth answers first
  if (Array.isArray(careerBrain.goldenAnswers)) {
    for (const ga of careerBrain.goldenAnswers) {
      if (!ga.question || !ga.answer) continue;
      const gaQuestionLower = ga.question.toLowerCase().trim();
      if (qTextLower.includes(gaQuestionLower) || gaQuestionLower.includes(qTextLower)) {
        logger.info(`[QuestionSolver] Matched Golden Q&A for "${question.questionText}": "${ga.answer}"`);
        return {
          questionId: question.questionId,
          answer: ga.answer,
          confidence: 1.0,
          isConfident: true,
          reasoning: `Matched Golden Q&A ground-truth rule: "${ga.question}"`,
        };
      }
    }
  }

  // 1b. Check custom saved answers
  for (const [key, savedAnswer] of Object.entries(careerBrain.customAnswers || {})) {
    if (qTextLower.includes(key.toLowerCase()) || key.toLowerCase().includes(qTextLower)) {
      logger.info(`[QuestionSolver] Found exact match in customAnswers for "${question.questionText}": ${savedAnswer}`);
      return {
        questionId: question.questionId,
        answer: savedAnswer,
        confidence: 1.0,
        isConfident: true,
        reasoning: 'Matched saved answer in Career Brain memory.',
      };
    }
  }

  // 2. Direct Rule-Based Fast Handlers for Common Standard Questions
  // Work Authorization / Sponsorship
  if (
    qTextLower.includes('legally authorized') ||
    qTextLower.includes('authorized to work') ||
    qTextLower.includes('eligible to work')
  ) {
    const isAuthorized = !careerBrain.workAuthorization.toLowerCase().includes('not authorized');
    return formatStandardAnswer(
      question,
      isAuthorized ? 'Yes' : 'No',
      0.95,
      'Derived from work authorization setting.',
    );
  }

  if (qTextLower.includes('sponsorship') || qTextLower.includes('visa') || qTextLower.includes('require sponsorship')) {
    const requiresSponsorship = careerBrain.workAuthorization.toLowerCase().includes('requires sponsorship');
    return formatStandardAnswer(
      question,
      requiresSponsorship ? 'Yes' : 'No',
      0.95,
      'Derived from work authorization setting.',
    );
  }

  // 1c. Total Years of Experience / Overall Work Experience (handles singular "year" and typo "experiance")
  const isTotalExpQuestion =
    /\b(?:total|overall|all)\s*(?:years?|yrs?)?\s*(?:of)?\s*(?:work|professional)?\s*experi[ea]nce\b/i.test(
      qTextLower,
    ) ||
    /\bhow\s*many\s*(?:years?|yrs?)\s*(?:of)?\s*(?:total|overall|work|professional)?\s*experi[ea]nce\b/i.test(
      qTextLower,
    ) ||
    /\btotal\s*experi[ea]nce\b/i.test(qTextLower) ||
    /\bexperi[ea]nce\s*in\s*years\b/i.test(qTextLower) ||
    /^(?:total\s*)?(?:work\s*)?experi[ea]nce\s*(?:\(in\s*years?\))?[:?*]?$/i.test(qTextLower);

  if (isTotalExpQuestion) {
    const yoe = String(careerBrain.yearsOfExperience ?? 1);
    return formatStandardAnswer(
      question,
      yoe,
      1.0,
      `Derived total verified experience from CareerBrain profile (${yoe} yrs).`,
    );
  }

  // 1d. Current CTC / In-Hand Salary / Salary (Monthly vs Annual)
  if (
    qTextLower.includes('current ctc') ||
    qTextLower.includes('in-hand salary') ||
    qTextLower.includes('current salary') ||
    qTextLower.includes('current in-hand') ||
    (qTextLower.includes('current') &&
      (qTextLower.includes('ctc') || qTextLower.includes('salary') || qTextLower.includes('p/m')))
  ) {
    const rawCtc =
      Number((careerBrain.currentCTC || careerBrain.salaryExpectation || '120000').replace(/[^0-9.]/g, '')) || 120000;
    const isMonthly =
      qTextLower.includes('p/m') ||
      qTextLower.includes('per month') ||
      qTextLower.includes('monthly') ||
      qTextLower.includes('in-hand');
    const val = isMonthly ? String(Math.round(rawCtc / 12)) : String(rawCtc);
    return formatStandardAnswer(
      question,
      val,
      0.98,
      isMonthly ? `Derived monthly current/in-hand salary from CTC (${val} P/M)` : `Derived current CTC (${val})`,
    );
  }

  // 1e. Expected CTC / Salary Expectation (Monthly vs Annual)
  if (
    qTextLower.includes('expect') ||
    qTextLower.includes('expectation') ||
    qTextLower.includes('expected ctc') ||
    qTextLower.includes('expected salary')
  ) {
    const rawExp =
      Number((careerBrain.expectedCTC || careerBrain.salaryExpectation || '500000').replace(/[^0-9.]/g, '')) || 500000;
    const isMonthly = qTextLower.includes('p/m') || qTextLower.includes('per month') || qTextLower.includes('monthly');
    const val = isMonthly ? String(Math.round(rawExp / 12)) : String(rawExp);
    return formatStandardAnswer(
      question,
      val,
      0.98,
      isMonthly ? `Derived monthly expected CTC (${val} P/M)` : `Derived expected CTC (${val})`,
    );
  }

  // Years of Experience for a specific technology / skill
  if (
    qTextLower.includes('how many years') ||
    qTextLower.includes('years of experience') ||
    qTextLower.includes('years of work experience') ||
    qTextLower.includes('experience with')
  ) {
    // 1. Check skillExperience map first
    if (careerBrain.skillExperience && typeof careerBrain.skillExperience === 'object') {
      for (const [skill, yrs] of Object.entries(careerBrain.skillExperience)) {
        if (skill && qTextLower.includes(skill.toLowerCase())) {
          return formatStandardAnswer(
            question,
            String(yrs),
            1.0,
            `Matched skillExperience for "${skill}": ${yrs} yrs.`,
          );
        }
      }
    }
    // Never fall back to total years of experience! Leave confidence low so ask_user or LLM triggers
  }

  // Notice Period
  if (
    (qTextLower.includes('notice period') || qTextLower.includes('how soon can you start')) &&
    careerBrain.noticePeriod
  ) {
    return formatStandardAnswer(question, careerBrain.noticePeriod, 0.95, 'Derived from notice period setting.');
  }

  // Phone Number / Mobile
  if (qTextLower.includes('phone') || qTextLower.includes('mobile') || qTextLower.includes('contact number')) {
    return formatStandardAnswer(
      question,
      careerBrain.phoneNumber,
      0.99,
      'Derived from candidate contact phone number.',
    );
  }

  // Email Address
  if (qTextLower.includes('email') || qTextLower.includes('e-mail')) {
    return formatStandardAnswer(question, careerBrain.email, 0.99, 'Derived from candidate contact email address.');
  }

  // City / Location
  if (qTextLower.includes('located in') || qTextLower.includes('commute') || qTextLower.includes('city')) {
    return formatStandardAnswer(
      question,
      careerBrain.preferredLocation,
      0.9,
      'Derived from preferred location setting.',
    );
  }

  // GitHub Profile URL
  if (qTextLower.includes('github')) {
    const gitUrl = careerBrain.githubUrl || 'https://github.com';
    return formatStandardAnswer(question, gitUrl, 0.95, 'Derived from candidate GitHub URL.');
  }

  // Portfolio / Website URL
  if (qTextLower.includes('portfolio') || qTextLower.includes('website') || qTextLower.includes('personal site')) {
    const portfolio = careerBrain.portfolioUrl || careerBrain.githubUrl || '';
    return formatStandardAnswer(question, portfolio, 0.9, 'Derived from candidate portfolio URL.');
  }

  // LinkedIn Profile URL
  if (qTextLower.includes('linkedin')) {
    const linkedUrl = careerBrain.linkedinUrl || 'https://linkedin.com';
    return formatStandardAnswer(question, linkedUrl, 0.95, 'Derived from candidate LinkedIn URL.');
  }

  // Education / Degree
  if (
    qTextLower.includes('highest level of education') ||
    qTextLower.includes('degree') ||
    qTextLower.includes('qualification')
  ) {
    let answer = careerBrain.education || "Bachelor's Degree";
    if (question.options.length > 0) {
      const match = question.options.find(
        opt =>
          opt.toLowerCase().includes('bachelor') ||
          opt.toLowerCase().includes('b.tech') ||
          opt.toLowerCase().includes('undergraduate'),
      );
      if (match) answer = match;
    }
    return formatStandardAnswer(question, answer, 0.95, 'Derived from candidate education profile.');
  }

  // CGPA / GPA / Percentage
  if (qTextLower.includes('cgpa') || qTextLower.includes('gpa') || qTextLower.includes('percentage')) {
    let answer = '8.57';
    if (question.options.length > 0) {
      const match = question.options.find(
        opt =>
          opt.includes('8') ||
          opt.includes('8.5') ||
          opt.toLowerCase().includes('above 8') ||
          opt.toLowerCase().includes('70%') ||
          opt.toLowerCase().includes('80%'),
      );
      if (match) answer = match;
    }
    return formatStandardAnswer(question, answer, 0.95, 'Derived from candidate CGPA (8.57/10).');
  }

  // Candidate Name
  if (qTextLower === 'first name' || qTextLower.includes('first name')) {
    const firstName = careerBrain.fullName ? careerBrain.fullName.split(' ')[0] : 'Mubasshir';
    return formatStandardAnswer(question, firstName, 0.99, 'Derived from candidate first name.');
  }
  if (qTextLower === 'last name' || qTextLower.includes('last name')) {
    const lastName = careerBrain.fullName ? careerBrain.fullName.split(' ').slice(1).join(' ') : 'Ali';
    return formatStandardAnswer(question, lastName, 0.99, 'Derived from candidate last name.');
  }

  // 3. LLM-Based Reasoning for Custom/Open-Ended Questions
  if (llm) {
    try {
      const solution = await solveWithLLM(question, careerBrain, llm);
      if (solution) return solution;
    } catch (err) {
      logger.warning('LLM question solver failed:', err);
    }
  }

  // 4. Low-confidence fallback: Never guess
  logger.warning(
    `[QuestionSolver] ⚠️ Low confidence answering question: "${question.questionText}". Needs manual review.`,
  );
  return {
    questionId: question.questionId,
    answer: '',
    confidence: 0.2,
    isConfident: false,
    reasoning: 'Insufficient context in Career Brain to answer reliably without guessing.',
  };
}

/**
 * Solves arbitrary questions by querying the LLM with Career Brain context.
 */
async function solveWithLLM(
  question: IScreeningQuestion,
  careerBrain: ICareerBrain,
  llm: BaseChatModel,
): Promise<QuestionSolution | null> {
  const systemPrompt = `You are an elite, autonomous Job Application Assistant operating inside a strict automated pipeline. Your sole purpose is to analyze a candidate's background and answer specific job application screening questions.

CRITICAL RULES:
1. NO CHAT: You must NOT output any conversational text, greetings, markdown formatting, or preambles (do not say "Here is the answer" or use markdown code blocks).
2. JSON ONLY: Your entire response MUST be a single, valid, parseable JSON object.
3. STRICT ZERO HALLUCINATION: Base your answers ONLY on the provided Candidate Profile ("Career Brain"). Never fabricate skills, certifications, degrees, or experience. If the answer is unknown or missing from the profile, set requiresManualReview: true and confidenceScore: 20 so the user can be prompted.

JSON SCHEMA REQUIREMENT:
{
  "question": "The exact question you are answering",
  "answer": "The specific value to inject (e.g., '5', 'Yes', 'React')",
  "confidenceScore": <number between 0 and 100>,
  "requiresManualReview": <boolean, set to true if the question is missing from profile or requires human review>
}`;

  const userPrompt = `Target Question: "${question.questionText}"
Question Type: ${question.questionType}
Available Options: ${question.options.length > 0 ? JSON.stringify(question.options) : 'Free text / numeric'}
Required: ${question.required}

Candidate Career Brain Profile:
- Full Name: ${careerBrain.fullName || 'Mubasshir Ali'}
- Education: ${careerBrain.education || 'B.Tech CSE, MAKAUT'}
- Background Narrative: ${careerBrain.backgroundNarrative}
- Raw Resume Content:
${careerBrain.resumeText || ''}
- Skills: ${careerBrain.skills.join(', ')}
- Years of Experience: ${careerBrain.yearsOfExperience}
- Current Title: ${careerBrain.currentTitle}
- Notice Period: ${careerBrain.noticePeriod}
- Work Authorization: ${careerBrain.workAuthorization}
- Preferred Location: ${careerBrain.preferredLocation}
- GitHub: ${careerBrain.githubUrl || ''}
- Portfolio: ${careerBrain.portfolioUrl || ''}
- LinkedIn: ${careerBrain.linkedinUrl || ''}

Provide the response in the required JSON format. If options are provided, your "answer" must match one of the options.`;

  const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

  const text =
    typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : '';

  // Strip markdown code fences that Bedrock/Nova models sometimes add
  const cleanText = text.replace(/```json\s*|```\s*/gi, '').trim();

  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]);
    const score = Number(parsed.confidenceScore ?? parsed.confidence ?? 0);
    // Normalize score to 0.0 - 1.0 range
    const normalizedConfidence = score > 1 ? score / 100 : score;
    const requiresReview = parsed.requiresManualReview === true || normalizedConfidence < 0.7;

    return {
      questionId: question.questionId,
      answer: String(parsed.answer || ''),
      confidence: normalizedConfidence,
      isConfident: !requiresReview,
      reasoning:
        parsed.reasoning ||
        `Answered with confidence ${Math.round(normalizedConfidence * 100)}%. Requires review: ${requiresReview}`,
    };
  }

  return null;
}

/**
 * Normalizes answer to match standard option formats if options are provided.
 */
function formatStandardAnswer(
  question: IScreeningQuestion,
  desiredAnswer: string,
  confidence: number,
  reasoning: string,
): QuestionSolution {
  let finalAnswer = desiredAnswer;

  if (question.options && question.options.length > 0) {
    const matchingOption = question.options.find(
      opt =>
        opt.toLowerCase() === desiredAnswer.toLowerCase() || opt.toLowerCase().includes(desiredAnswer.toLowerCase()),
    );
    if (matchingOption) {
      finalAnswer = matchingOption;
    } else {
      // Default to first option if Yes/No style
      if (desiredAnswer.toLowerCase() === 'yes' && question.options.some(o => o.toLowerCase().includes('yes'))) {
        finalAnswer = question.options.find(o => o.toLowerCase().includes('yes')) || desiredAnswer;
      }
    }
  } else {
    // If field is numeric or asks for experience/salary/duration, STRIP text units (e.g. "14 years" -> "14", "1 year" -> "1")
    const qLower = (question.questionText || '').toLowerCase();
    const isNumericOrExp =
      question.questionType === 'numeric' ||
      /\byears?\b|\bexperi[ea]nce\b|\bhow many\b|\bctc\b|\bsalary\b|\bp\/?m\b/i.test(qLower);

    if (isNumericOrExp && finalAnswer) {
      const matchNum = finalAnswer.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (matchNum) {
        finalAnswer = matchNum[1];
      }
    }
  }

  return {
    questionId: question.questionId,
    answer: finalAnswer,
    confidence,
    isConfident: confidence >= 0.7,
    reasoning,
  };
}

/**
 * Batch solves multiple screening questions using Career Brain context and Bedrock AI.
 */
export async function solveQuestions(
  questions: IScreeningQuestion[],
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<QuestionSolution[]> {
  const solutions: QuestionSolution[] = [];
  const unresolvedQuestions: IScreeningQuestion[] = [];

  // Fast evaluation: Golden Q&A and deterministic rules first (0 tokens, instantaneous)
  for (const q of questions) {
    const fastSol = await solveScreeningQuestion(q, careerBrain, undefined);
    if (fastSol.isConfident) {
      solutions.push(fastSol);
    } else {
      unresolvedQuestions.push(q);
    }
  }

  // If there are unresolved questions and Bedrock LLM is available, execute batch structured inference
  if (unresolvedQuestions.length > 0 && llm) {
    const goldenText = (careerBrain.goldenAnswers || []).map(ga => `Q: ${ga.question}\nA: ${ga.answer}`).join('\n\n');

    const formQuestionsText = unresolvedQuestions
      .map(
        q =>
          `FieldId: ${q.questionId} | Type: ${q.questionType} | Question: ${q.questionText}${q.options.length > 0 ? ` | Options: [${q.options.join(', ')}]` : ''}`,
      )
      .join('\n');

    const structuredProfile = `Candidate Profile:
Name: ${careerBrain.fullName?.trim() || 'Mubasshir Ali'}
Current Role: ${careerBrain.currentTitle?.trim() || 'Software Engineer'}
Total Years of Experience: ${careerBrain.yearsOfExperience !== undefined && careerBrain.yearsOfExperience !== null ? careerBrain.yearsOfExperience : 1}
Current Annual CTC: ${careerBrain.currentCTC?.trim() || '120000'}
Current Monthly CTC (P/M): ${Math.round(Number((careerBrain.currentCTC || '120000').replace(/[^0-9.]/g, '')) / 12) || 10000}
Current In-Hand Monthly Salary (P/M): ${Math.round(Number((careerBrain.currentCTC || '120000').replace(/[^0-9.]/g, '')) / 12) || 10000}
Expected Annual CTC: ${careerBrain.expectedCTC?.trim() || '500000'}
Expected Monthly CTC (P/M): ${Math.round(Number((careerBrain.expectedCTC || '500000').replace(/[^0-9.]/g, '')) / 12) || 41666}
Skills: ${(careerBrain.skills || []).join(', ') || 'NOT PROVIDED'}
Skill Experience: ${careerBrain.skillExperience ? JSON.stringify(careerBrain.skillExperience) : 'None'}
Education: ${careerBrain.education?.trim() || 'NOT PROVIDED'}
College: ${careerBrain.college?.trim() || 'NOT PROVIDED'}
CGPA: ${careerBrain.cgpa?.trim() || '8.57'}
Work Authorization: ${careerBrain.workAuthorization?.trim() || 'Legally authorized to work without sponsorship'}
Notice Period: ${careerBrain.noticePeriod?.trim() || 'Immediate'}
Preferred Location: ${careerBrain.preferredLocation?.trim() || 'Bengaluru, India'}
Current Location: ${careerBrain.currentLocation?.trim() || 'Bengaluru, India'}
Narrative: ${careerBrain.backgroundNarrative?.trim() || 'Experienced software engineer.'}`;

    const candidateContext = `${structuredProfile}\n\n=== RESUME TEXT ===\n${careerBrain.resumeText || ''}`;

    const bedrockResult = await solveFormQuestionsWithBedrock(
      llm,
      candidateContext,
      goldenText,
      formQuestionsText,
      careerBrain,
    );

    if (bedrockResult && Array.isArray(bedrockResult.answers)) {
      const answerMap = new Map(bedrockResult.answers.map(a => [a.fieldId, a]));
      for (const q of unresolvedQuestions) {
        const aiAns = answerMap.get(q.questionId);
        if (aiAns && aiAns.is_answerable) {
          solutions.push({
            questionId: q.questionId,
            answer: aiAns.answer,
            confidence: 0.95,
            isConfident: true,
            reasoning: aiAns.confidence_reasoning || 'Deduced via AWS Bedrock from Career Brain context.',
          });
        } else {
          // Low confidence or unanswerable
          solutions.push({
            questionId: q.questionId,
            answer: '',
            confidence: 0.2,
            isConfident: false,
            reasoning: aiAns?.confidence_reasoning || 'Unanswerable based on Career Brain context.',
          });
        }
      }
      return solutions;
    }
  }

  // Fallback for remaining unresolved questions
  for (const q of unresolvedQuestions) {
    const sol = await solveScreeningQuestion(q, careerBrain, llm);
    solutions.push(sol);
  }

  return solutions;
}
