/**
 * LinkedIn Easy Apply — Career Brain Screening Question Solver
 *
 * Uses the user's Career Brain context to generate reasoned answers to
 * job screening questions. If confidence is low or information is absent,
 * flags for manual review without guessing.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { ICareerBrain } from '@extension/storage';
import type { IScreeningQuestion } from './types';

const logger = createLogger('LinkedInQuestionSolver');

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

  // 1. Check custom saved answers first
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

  // Years of Experience for a specific technology
  if (
    qTextLower.includes('how many years of') ||
    qTextLower.includes('years of experience') ||
    qTextLower.includes('years of work experience')
  ) {
    // Check if technology is in candidate skills
    const matchedSkill = careerBrain.skills.find(s => qTextLower.includes(s.toLowerCase()));
    if (matchedSkill) {
      const years = String(Math.max(1, careerBrain.yearsOfExperience));
      return formatStandardAnswer(
        question,
        years,
        0.9,
        `Matched skill "${matchedSkill}". Using career experience (${years} yrs).`,
      );
    } else {
      // Check if skill is mentioned in narrative
      const mentionedInNarrative = careerBrain.backgroundNarrative
        .toLowerCase()
        .includes(qTextLower.split(' ')[0] || '');
      const years = mentionedInNarrative ? '1' : '0';
      return formatStandardAnswer(question, years, 0.7, 'Estimated from background narrative.');
    }
  }

  // Notice Period
  if (qTextLower.includes('notice period') || qTextLower.includes('how soon can you start')) {
    return formatStandardAnswer(question, careerBrain.noticePeriod, 0.95, 'Derived from notice period setting.');
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
3. STRICT TRUTH: Base your answers ONLY on the provided Candidate Profile ("Career Brain"). Do not hallucinate skills or experience. If the answer is unknown, make a logical safe guess or indicate low confidence.

JSON SCHEMA REQUIREMENT:
{
  "question": "The exact question you are answering",
  "answer": "The specific value to inject (e.g., '5', 'Yes', 'React')",
  "confidenceScore": <number between 0 and 100>,
  "requiresManualReview": <boolean, set to true if the question is highly subjective or missing from profile>
}`;

  const userPrompt = `Target Question: "${question.questionText}"
Question Type: ${question.questionType}
Available Options: ${question.options.length > 0 ? JSON.stringify(question.options) : 'Free text / numeric'}
Required: ${question.required}

Candidate Career Brain Profile:
- Background Narrative: ${careerBrain.backgroundNarrative}
- Skills: ${careerBrain.skills.join(', ')}
- Years of Experience: ${careerBrain.yearsOfExperience}
- Current Title: ${careerBrain.currentTitle}
- Notice Period: ${careerBrain.noticePeriod}
- Work Authorization: ${careerBrain.workAuthorization}
- Preferred Location: ${careerBrain.preferredLocation}

Provide the response in the required JSON format. If options are provided, your "answer" must match one of the options.`;

  const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

  const text =
    typeof response.content === 'string'
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
        : '';

  const jsonMatch = text.match(/\{[\s\S]*\}/);
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
  }

  return {
    questionId: question.questionId,
    answer: finalAnswer,
    confidence,
    isConfident: confidence >= 0.7,
    reasoning,
  };
}
