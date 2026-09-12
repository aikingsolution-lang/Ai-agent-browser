/**
 * LinkedIn Easy Apply — RAG-Based Job Fit Scorer
 *
 * Sanitizes and summarizes job descriptions (token/cost control),
 * and evaluates candidate match against Career Brain context.
 * Jobs with fitScore < 75 are flagged to be skipped.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createLogger } from '@src/background/log';
import type { ICareerBrain } from '@extension/storage';
import type { IJobData, IFitScoreResult, FitRecommendation } from './types';

const logger = createLogger('LinkedInFitScorer');

export const MIN_FIT_SCORE_THRESHOLD = 75;

/**
 * Strips HTML tags, removes excess whitespace, and extracts the most relevant
 * requirements/qualifications/responsibilities sections from a raw job description.
 * Truncates to roughly maxTokens (~4 chars per token).
 */
export function sanitizeJobDescription(rawDescription: string, maxTokens = 1000): string {
  if (!rawDescription) return '';

  // 1. Strip HTML tags
  let text = rawDescription.replace(/<[^>]*>/g, ' ');

  // 2. Normalize whitespace
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 3. Look for sections related to Requirements, Qualifications, Responsibilities
  const sectionKeywords = [
    'requirements',
    'qualifications',
    'what you need',
    'what we are looking for',
    'responsibilities',
    'what you will do',
    'skills',
    'must have',
    'nice to have',
    'minimum qualifications',
    'preferred qualifications',
  ];

  const lowerText = text.toLowerCase();
  let bestStartIndex = -1;

  for (const keyword of sectionKeywords) {
    const idx = lowerText.indexOf(keyword);
    if (idx !== -1 && (bestStartIndex === -1 || idx < bestStartIndex)) {
      bestStartIndex = idx;
    }
  }

  // If a requirement section was found, prioritize from that point
  const relevantText = bestStartIndex > 0 ? text.substring(bestStartIndex) : text;

  // 4. Token limit truncation (roughly 4 chars per token)
  const maxCharLimit = maxTokens * 4;
  if (relevantText.length > maxCharLimit) {
    return relevantText.substring(0, maxCharLimit) + '... [truncated]';
  }

  return relevantText;
}

/**
 * Evaluates how well a user's Career Brain matches a job description.
 * Returns a score from 0-100 and skill alignment details.
 */
export async function evaluateJobFit(
  jobData: IJobData,
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<IFitScoreResult> {
  const sanitizedJD = sanitizeJobDescription(jobData.description, 1000);

  logger.info(`Evaluating job fit for "${jobData.title}" at "${jobData.company}"...`);

  // If LLM is available, use LLM for semantic evaluation
  if (llm) {
    try {
      const systemPrompt = `You are an expert AI Career Matchmaker and Technical Recruiter.
Your task is to evaluate the match between a candidate's background and a job opening.
Analyze strictly based on skills, experience requirements, and core tech stack.

Respond ONLY with a valid JSON object formatted as follows:
{
  "score": <number between 0 and 100>,
  "reasoning": "<concise 2-sentence explanation of fit>",
  "matchedSkills": ["skill1", "skill2"],
  "missingSkills": ["missingSkill1"],
  "recommendation": "STRONG_MATCH" | "GOOD_MATCH" | "WEAK_MATCH" | "NO_MATCH"
}`;

      const userPrompt = `Job Title: ${jobData.title}
Company: ${jobData.company}
Location: ${jobData.location}

Job Description:
${sanitizedJD}

Candidate Profile (Career Brain):
- Current Title: ${careerBrain.currentTitle}
- Years of Experience: ${careerBrain.yearsOfExperience}
- Primary Skills: ${careerBrain.skills.join(', ')}
- Background Narrative: ${careerBrain.backgroundNarrative}
- Work Authorization: ${careerBrain.workAuthorization}

Evaluate the fit accurately. If candidate meets core requirements, score >= 75. If core skills are missing, score < 75.`;

      const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

      const responseText =
        typeof response.content === 'string'
          ? response.content
          : Array.isArray(response.content)
            ? response.content.map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : '')).join('')
            : '';

      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));

        let recommendation: FitRecommendation = 'NO_MATCH';
        if (score >= 85) recommendation = 'STRONG_MATCH';
        else if (score >= 75) recommendation = 'GOOD_MATCH';
        else if (score >= 50) recommendation = 'WEAK_MATCH';

        logger.info(`[FitScorer] LLM Fit Score: ${score}/100 (${recommendation}) for ${jobData.title}`);

        return {
          score,
          reasoning: parsed.reasoning || `Match score ${score}/100 based on profile review.`,
          matchedSkills: Array.isArray(parsed.matchedSkills) ? parsed.matchedSkills : [],
          missingSkills: Array.isArray(parsed.missingSkills) ? parsed.missingSkills : [],
          recommendation,
        };
      }
    } catch (err) {
      logger.warning('LLM fit scoring encountered an error. Falling back to heuristic scorer:', err);
    }
  }

  // Fallback Heuristic Matcher when LLM is unavailable
  return calculateHeuristicFit(jobData.title, sanitizedJD, careerBrain);
}

/**
 * Fast keyword and skill-intersection heuristic scorer.
 */
function calculateHeuristicFit(jobTitle: string, sanitizedJD: string, careerBrain: ICareerBrain): IFitScoreResult {
  const jdLower = `${jobTitle} ${sanitizedJD}`.toLowerCase();
  const matchedSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const skill of careerBrain.skills) {
    if (jdLower.includes(skill.toLowerCase())) {
      matchedSkills.push(skill);
    }
  }

  // Calculate score based on skill match ratio and experience
  let score = 50; // base score
  if (careerBrain.skills.length > 0) {
    const matchRatio = matchedSkills.length / Math.min(careerBrain.skills.length, 5);
    score = Math.round(matchRatio * 50 + 35);
  }

  // Title similarity boost
  if (careerBrain.currentTitle && jdLower.includes(careerBrain.currentTitle.toLowerCase())) {
    score = Math.min(100, score + 15);
  }

  score = Math.max(0, Math.min(100, score));

  let recommendation: FitRecommendation = 'NO_MATCH';
  if (score >= 85) recommendation = 'STRONG_MATCH';
  else if (score >= 75) recommendation = 'GOOD_MATCH';
  else if (score >= 50) recommendation = 'WEAK_MATCH';

  return {
    score,
    reasoning: `Heuristic match found ${matchedSkills.length} matching skills (${matchedSkills.join(', ')}).`,
    matchedSkills,
    missingSkills,
    recommendation,
  };
}
