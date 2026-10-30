/**
 * gemini_models.ts — queries the Google Gemini models list endpoint
 * and prints only the model IDs (without the "models/" prefix) that support `generateContent`.
 *
 * Usage:
 *   npx tsx src/scripts/gemini_models.ts
 */

import dotenv from 'dotenv';
dotenv.config();

async function main(): Promise<void> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY is not set.');
    process.exit(1);
  }

  // Google Gemini models list API
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      let errBody = '';
      try {
        errBody = JSON.stringify(await res.json());
      } catch {
        errBody = await res.text();
      }
      console.error(`HTTP ${res.status} error fetching models: ${errBody}`);
      process.exit(1);
    }

    const data: any = await res.json();
    const models: any[] = data.models || [];

    const supportedModels: string[] = [];

    for (const m of models) {
      const methods: string[] = m.supportedGenerationMethods || [];
      if (methods.includes('generateContent')) {
        const id = m.name.replace(/^models\//, '');
        supportedModels.push(id);
      }
    }

    console.log(`Found ${supportedModels.length} models supporting generateContent:`);
    console.log(JSON.stringify(supportedModels, null, 2));
  } catch (err: any) {
    console.error('Failed to list Gemini models:', err?.message || String(err));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
