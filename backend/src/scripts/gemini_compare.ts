/**
 * gemini_compare.ts — Benchmark comparison of candidate Gemini models on 6 realistic job-application tasks.
 *
 * Usage:
 *   npx tsx src/scripts/gemini_compare.ts
 *   pnpm --filter @nanobrowser/backend compare:gemini
 *
 * Evaluates candidate models (default: gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.8-flash)
 * across 6 realistic, synthetic job-application prompts:
 *   1. Numeric salary field
 *   2. Yes/no with options
 *   3. Short single-line answer
 *   4. "Why do you want to join" 2-sentence answer
 *   5. Experience-years question
 *   6. Tool-calling request (structured function calling)
 *
 * Prints per model: status, latency (ms), token usage, and reply preview.
 * Strictly uses synthetic test data (no real candidate profile or resume information).
 * Never prints or leaks API keys.
 */

import dotenv from 'dotenv';
dotenv.config();

import { GeminiLlmProvider } from '../services/llm/geminiLlmProvider.js';

interface BenchmarkPrompt {
  id: string;
  name: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  temperature: number;
  tools?: any[];
  tool_choice?: any;
}

const TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'set_form_answer',
      description: 'Records an answer to a specific job application form field',
      parameters: {
        type: 'object',
        properties: {
          field_id: { type: 'string', description: 'The unique DOM identifier of the form field' },
          value: { type: 'string', description: 'The exact answer value to populate' },
        },
        required: ['field_id', 'value'],
      },
    },
  },
];

const BENCHMARK_PROMPTS: BenchmarkPrompt[] = [
  {
    id: 'salary',
    name: '1. Numeric Salary Field',
    prompt:
      "The job application asks: 'What is your expected annual compensation in USD?'. The candidate profile states target base salary is 115000 USD. Output only the plain integer number with no currency signs or commas.",
    maxTokens: 50,
    temperature: 0.1,
  },
  {
    id: 'yes_no',
    name: '2. Yes/No with Options',
    prompt:
      "The job application asks: 'Are you legally authorized to work in the country of this posting? Options: [Yes, No]'. The candidate is a confirmed citizen. Answer with exactly one of the provided options.",
    maxTokens: 20,
    temperature: 0.1,
  },
  {
    id: 'notice_period',
    name: '3. Short Single-Line Answer',
    prompt:
      "The job application asks: 'What is your current notice period?'. Candidate is available immediately with zero notice period. Answer in three words or fewer.",
    maxTokens: 30,
    temperature: 0.1,
  },
  {
    id: 'why_join',
    name: '4. Why Join (2-Sentence Answer)',
    prompt:
      "The job application asks: 'Why are you interested in joining Acme Software as a Senior Backend Engineer?'. Write a professional response of exactly two concise sentences highlighting experience in high-concurrency systems and clean distributed architecture. Do not use buzzwords or conversational filler.",
    maxTokens: 120,
    temperature: 0.3,
  },
  {
    id: 'experience_years',
    name: '5. Experience-Years Question',
    prompt:
      "The job application asks: 'How many total years of professional experience do you have with TypeScript and Node.js?'. Candidate began working professionally in 2020 (6 years total). Return only the single integer digit.",
    maxTokens: 20,
    temperature: 0.1,
  },
  {
    id: 'tool_call',
    name: '6. Tool-Calling Request',
    prompt:
      "Fill the application form: set the field 'preferred_work_location' to 'Remote'. Use the provided set_form_answer tool.",
    maxTokens: 150,
    temperature: 0.1,
    tools: TOOL_SCHEMA,
    tool_choice: { type: 'function', function: { name: 'set_form_answer' } },
  },
];

interface PromptResult {
  promptId: string;
  promptName: string;
  status: string;
  statusCode: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reply: string;
}

interface ModelSummary {
  model: string;
  totalLatencyMs: number;
  totalTokens: number;
  successCount: number;
  results: PromptResult[];
}

async function runBenchmark(): Promise<void> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY is not set. Please set GEMINI_API_KEY in backend/.env before running.');
    process.exit(1);
  }

  const rawCandidateModels = process.env.COMPARE_MODELS
    ? process.env.COMPARE_MODELS.split(',')
        .map(m => m.trim())
        .filter(Boolean)
    : ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];

  // Cap at 3 candidate models as specified
  const candidateModels = rawCandidateModels.slice(0, 3);

  console.log('================================================================================');
  console.log('🤖 NanoBrowser — Google Gemini Candidate Models Benchmark');
  console.log(`Candidate models: ${candidateModels.join(', ')}`);
  console.log(`Benchmark prompts: 6 synthetic job-application test cases`);
  console.log('================================================================================\n');

  const summaries: ModelSummary[] = [];

  for (const model of candidateModels) {
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`Testing Model: ${model}`);
    console.log(`--------------------------------------------------------------------------------`);

    const provider = new GeminiLlmProvider(apiKey, model);
    const modelSummary: ModelSummary = {
      model,
      totalLatencyMs: 0,
      totalTokens: 0,
      successCount: 0,
      results: [],
    };

    for (const testCase of BENCHMARK_PROMPTS) {
      process.stdout.write(`  [${testCase.name}] ... `);
      const t0 = Date.now();
      try {
        const response = await provider.generateCompletion({
          model,
          messages: [{ role: 'user', content: testCase.prompt }],
          temperature: testCase.temperature,
          maxTokens: testCase.maxTokens,
          tools: testCase.tools,
          tool_choice: testCase.tool_choice,
          timeoutMs: 25000,
        });

        const latency = Date.now() - t0;
        let replyDisplay = '';

        if (response.toolCalls && response.toolCalls.length > 0) {
          const fn = response.toolCalls[0].function;
          replyDisplay = `tool_call: ${fn.name}(${fn.arguments})`;
        } else {
          replyDisplay = (response.content || '').replace(/\s+/g, ' ').trim();
        }

        modelSummary.totalLatencyMs += latency;
        modelSummary.totalTokens += response.totalTokens;
        modelSummary.successCount++;

        modelSummary.results.push({
          promptId: testCase.id,
          promptName: testCase.name,
          status: 'OK',
          statusCode: 200,
          latencyMs: latency,
          promptTokens: response.promptTokens,
          completionTokens: response.completionTokens,
          totalTokens: response.totalTokens,
          reply: replyDisplay,
        });

        console.log(`200 OK (${latency}ms, ${response.totalTokens} tokens)`);
        console.log(`    ↳ Output: "${replyDisplay.slice(0, 100)}"`);
      } catch (err: any) {
        const latency = Date.now() - t0;
        const statusCode = err?.statusCode || 500;
        const errorMsg = err?.message || 'Call failed';

        modelSummary.totalLatencyMs += latency;
        modelSummary.results.push({
          promptId: testCase.id,
          promptName: testCase.name,
          status: `ERR_${statusCode}`,
          statusCode,
          latencyMs: latency,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          reply: errorMsg,
        });

        console.log(`FAILED ${statusCode} (${latency}ms)`);
        console.log(`    ↳ Error: ${errorMsg}`);
      }
    }

    summaries.push(modelSummary);
    console.log();
  }

  // Print comparison table
  console.log('================================================================================');
  console.log('📊 BENCHMARK COMPARISON SUMMARY');
  console.log('================================================================================');
  console.log(
    'Model'.padEnd(25) + 'Success'.padEnd(12) + 'Avg Latency'.padEnd(16) + 'Total Tokens'.padEnd(16) + 'Status',
  );
  console.log(''.padEnd(78, '-'));

  for (const s of summaries) {
    const avgLatency = s.successCount > 0 ? `${Math.round(s.totalLatencyMs / s.successCount)}ms` : 'N/A';
    const statusNote = s.successCount === BENCHMARK_PROMPTS.length ? '✅ ALL PASSED' : `⚠️ ${s.successCount}/6 PASSED`;
    console.log(
      s.model.padEnd(25) +
        `${s.successCount}/${BENCHMARK_PROMPTS.length}`.padEnd(12) +
        avgLatency.padEnd(16) +
        `${s.totalTokens}`.padEnd(16) +
        statusNote,
    );
  }

  console.log('================================================================================\n');
}

runBenchmark().catch(err => {
  console.error('Benchmark execution error:', err?.message || err);
  process.exit(1);
});
