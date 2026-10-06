// chrome-extension/src/background/agent/intelligence/batchQuestionSolver.ts
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { ICareerBrain } from '@extension/storage';
import { matchQuestionSemantically } from './semanticQuestionMatcher';
import { alignValueToOptions } from './smartOptionAligner';

export interface IBatchFieldInput {
  id: string;
  label: string;
  fieldType: 'text' | 'number' | 'radio' | 'dropdown' | 'checkbox';
  options?: string[];
  min?: number;
  max?: number;
  required?: boolean;
}

export interface IBatchFieldResolved {
  id: string;
  label: string;
  value: string;
  confidence: number;
  source: 'semantic_cache' | 'batch_llm' | 'default';
  reason: string;
}

/**
 * Solves all fields on an active form step in a single intelligent pass.
 * Drastically reduces latency by batching unknown fields into one LLM call.
 */
export async function solveBatchFormFields(
  fields: IBatchFieldInput[],
  careerBrain: ICareerBrain,
  llm?: BaseChatModel,
): Promise<Map<string, IBatchFieldResolved>> {
  const results = new Map<string, IBatchFieldResolved>();
  const unresolvedFields: IBatchFieldInput[] = [];

  // Pass 1: Semantic Local Matcher (0ms, 0 Credits)
  for (const field of fields) {
    const semantic = matchQuestionSemantically(field.label, careerBrain);
    if (semantic && semantic.confidence >= 0.85) {
      let finalValue = semantic.matchedAnswer || '';

      // If dropdown or radio, align to DOM options
      if (
        (field.fieldType === 'dropdown' || field.fieldType === 'radio') &&
        field.options &&
        field.options.length > 0
      ) {
        const aligned = alignValueToOptions(finalValue, field.options, field.label);
        if (aligned) {
          finalValue = aligned.matchedOption;
        }
      }

      results.set(field.id, {
        id: field.id,
        label: field.label,
        value: finalValue,
        confidence: semantic.confidence,
        source: 'semantic_cache',
        reason: semantic.reason,
      });
      continue;
    }

    unresolvedFields.push(field);
  }

  // If all fields resolved with local semantic cache, return immediately!
  if (unresolvedFields.length === 0 || !llm) {
    return results;
  }

  // Pass 2: Single-Pass Multi-Question LLM Resolution
  try {
    const candidateSummary = `
CANDIDATE PROFILE:
- Title: ${careerBrain.currentTitle || 'Software Engineer'}
- Years of Experience: ${careerBrain.yearsOfExperience ?? 3}
- Primary Skills: ${(careerBrain.skills || []).slice(0, 15).join(', ')}
- Skill Experience Breakdown: ${JSON.stringify(careerBrain.skillExperience || {})}
- Notice Period: ${careerBrain.noticePeriod || 'Immediate'}
- Current CTC: ${careerBrain.currentCTC || 'Competitive'}
- Expected CTC: ${careerBrain.expectedCTC || 'Competitive'}
- Education: ${careerBrain.highestEducation || careerBrain.education || "Bachelor's Degree"}
- Work Authorization: Legally authorized to work in candidate country without visa sponsorship.
- Relocation: Open to relocation / hybrid / remote.
`.trim();

    const fieldsPrompt = unresolvedFields
      .map((f, idx) => {
        let desc = `${idx + 1}. [ID: "${f.id}"] Label: "${f.label}" | Type: ${f.fieldType}`;
        if (f.options && f.options.length > 0) {
          desc += ` | Options: ${JSON.stringify(f.options)}`;
        }
        return desc;
      })
      .join('\n');

    const systemPrompt = `You are an expert AI Job Application Assistant.
Analyze the candidate profile and resolve all the form questions in a single JSON output.
RULES:
1. For dropdowns/radios with Options, you MUST select the EXACT option string from the given options list that best qualifies the candidate.
2. For numeric fields (e.g. years of experience), provide only a valid integer/decimal number.
3. For text/cover questions, provide a concise, professional 1-2 sentence response.
4. Output STRICT JSON format only:
{
  "answers": {
    "<ID>": {
      "value": "<exact answer or exact option string>",
      "reason": "<brief reasoning>"
    }
  }
}`;

    const userPrompt = `${candidateSummary}\n\nFORM QUESTIONS TO SOLVE:\n${fieldsPrompt}\n\nReturn strict JSON.`;

    const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);

    const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    const jsonMatch = content.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.answers) {
        for (const f of unresolvedFields) {
          const item = parsed.answers[f.id];
          if (item && item.value !== undefined) {
            let finalVal = String(item.value).trim();

            if ((f.fieldType === 'dropdown' || f.fieldType === 'radio') && f.options && f.options.length > 0) {
              const aligned = alignValueToOptions(finalVal, f.options, f.label);
              if (aligned) {
                finalVal = aligned.matchedOption;
              }
            }

            results.set(f.id, {
              id: f.id,
              label: f.label,
              value: finalVal,
              confidence: 0.95,
              source: 'batch_llm',
              reason: item.reason || 'Single-pass LLM batch answer',
            });
          }
        }
      }
    }
  } catch (err) {
    // If LLM fails, fallback with safe defaults
    for (const f of unresolvedFields) {
      if (!results.has(f.id)) {
        const safeVal = f.fieldType === 'checkbox' ? 'No' : f.options?.[0] || 'Yes';
        results.set(f.id, {
          id: f.id,
          label: f.label,
          value: safeVal,
          confidence: 0.5,
          source: 'default',
          reason: 'Fallback safe default on batch error',
        });
      }
    }
  }

  return results;
}
