# AI / LLM System Architecture & Intelligence Pipeline

## 1. Hybrid Dual AI Architecture
NanoBrowser implements a dual-layer AI architecture:
1. **Client-Side LangChain Agent**: Runs in the Chrome extension for open-ended navigation tasks when user configures personal API keys (OpenAI / Anthropic / Ollama).
2. **Backend Managed LLM Gateway**: Provides cloud intelligence via AWS Bedrock (Claude 3.5 Sonnet) or OpenAI (GPT-4o), metered directly against user credit balances.

---

## 2. Intelligence Subsystems (`chrome-extension/src/background/agent/intelligence/`)

### A. Deep Relevance & Fit Scoring (`deepRelevanceMatcher.ts` & `fitScorer.ts`)
- Compares job description against candidate resume skills, seniority, and domain keywords.
- Calculates a weighted **Fit Score (0-100)**:
  - Technical Skills Match (40%)
  - Experience Years Alignment (25%)
  - Domain / Title Match (20%)
  - Negative Keyword / Blacklist Check (15%)
- If the score falls below the user-configured threshold (default: 60%), the job is skipped with a friendly log entry.

### B. Form Error Inspector & Self-Healing (`formErrorInspector.ts`)
- Inspects form validation states after filling modal inputs.
- Detects unresolved red warning messages, invalid numbers, or unselected dropdowns.
- Automatically repairs the invalid field or halts before clicking submit to avoid false application records.

### C. Batch Question Solver (`batchQuestionSolver.ts` & `formQuestionResolver.ts`)
- Analyzes all screening questions in an application modal in a single structured prompt.
- Resolves:
  - Salary expectations (calibrated from CareerBrain profile).
  - Years of experience with specific tools (exact years computed from resume work history).
  - Visa sponsorship and legal work authorization (extracted from golden screening answers).
  - Notice period and immediate availability.

---

## 3. Resume Parsing Pipeline (`backend/src/services/resumeParser.service.ts`)
- **Text Extraction**: Uses `pdf-parse` for PDF documents and `mammoth` for DOCX files.
- **LLM Prompt Engineering**:
  - Strict extraction rules: Never hallucinate skills or guess years of experience based on college graduation.
  - Generates baseline **Golden Screening Answers** for gatekeeper questions (work authorization, notice period, location).
- **Output Contract**: `ParsedResumeData` (saved into MongoDB `CareerBrain` collection and synchronized to Chrome storage).

---

## 4. LLM Metering & Credit Billing (`backend/src/services/llm.service.ts`)
- **Formula**:
  - Standard models: `1 credit per 1,000 tokens`.
  - Premium models (Claude 3.5 Sonnet): `2 credits per 1,000 tokens` (Minimum 2 credits).
- **Execution Flow**:
  1. Check `remainingCredits >= minRequiredCredits`.
  2. Call LLM provider.
  3. Compute actual tokens from provider response.
  4. Atomically deduct credits via `CreditService.deductCredits`.
  5. Save detailed usage record in `LlmUsageLog`.
