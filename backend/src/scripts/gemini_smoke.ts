/**
 * gemini_smoke.ts — minimal health / smoke check for Google Gemini provider.
 *
 * Usage:
 *   npx tsx src/scripts/gemini_smoke.ts
 *
 * Prints only status code, model, and the first 50 characters of the response.
 * Never logs API keys, secret credentials, or personal candidate data.
 */

import dotenv from 'dotenv';
dotenv.config();

import { GeminiLlmProvider } from '../services/llm/geminiLlmProvider.js';

async function main(): Promise<void> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || 'gemini-3.5-flash').trim();
  if (!apiKey) {
    console.error('Status: 400 Missing Configuration');
    console.error('Error: GEMINI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  // Strict smoke test: test ONLY the configured primary model (no fallback)
  const provider = new GeminiLlmProvider(apiKey, model);

  try {
    const startTime = Date.now();
    const result = await provider.generateCompletion({
      model,
      messages: [{ role: 'user', content: 'Respond with "PONG" and nothing else.' }],
      temperature: 0.1,
      maxTokens: 100,
    });
    const latencyMs = Date.now() - startTime;

    const preview = (result.content || '').trim().substring(0, 50);

    console.log('Status: 200 OK');
    console.log(`Model: ${model}`);
    console.log(`Latency: ${latencyMs}ms`);
    console.log(
      `Tokens: prompt=${result.promptTokens}, completion=${result.completionTokens}, total=${result.totalTokens}`,
    );
    console.log(`Reply: "${preview}"`);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    const code = err?.code || 'ERROR';
    console.error(`Status: ${status} ${code}`);
    console.error(`Message: ${err?.message || 'Smoke test call failed'}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected smoke test failure:', err?.message || String(err));
  process.exit(1);
});
