// chrome-extension/src/background/agent/linkedin/taskBuilder.ts
import type { ICareerBrain } from '@extension/storage';

/**
 * Identifies candidate profile fields that are missing or empty.
 */
export function getNotProvidedFields(careerBrain: ICareerBrain): string[] {
  const notProvided: string[] = [];

  if (!careerBrain.fullName || !careerBrain.fullName.trim()) notProvided.push('fullName');
  if (!careerBrain.email || !careerBrain.email.trim()) notProvided.push('email');
  if (!careerBrain.phoneNumber || !careerBrain.phoneNumber.trim()) notProvided.push('phoneNumber');
  if (!careerBrain.currentTitle || !careerBrain.currentTitle.trim()) notProvided.push('currentTitle');
  if (careerBrain.yearsOfExperience === undefined || careerBrain.yearsOfExperience === null) {
    notProvided.push('yearsOfExperience');
  }
  if (!careerBrain.skills || careerBrain.skills.length === 0) notProvided.push('skills');
  if (!careerBrain.education || !careerBrain.education.trim()) notProvided.push('education');
  if (!careerBrain.college || !careerBrain.college.trim()) notProvided.push('college');
  if (!careerBrain.cgpa || !careerBrain.cgpa.trim()) notProvided.push('cgpa');
  if (!careerBrain.currentCTC || !careerBrain.currentCTC.trim()) notProvided.push('currentCTC');
  if (!careerBrain.expectedCTC || !careerBrain.expectedCTC.trim()) notProvided.push('expectedCTC');
  if (!careerBrain.currentLocation || !careerBrain.currentLocation.trim()) notProvided.push('currentLocation');
  if (!careerBrain.preferredLocation || !careerBrain.preferredLocation.trim()) notProvided.push('preferredLocation');
  if (!careerBrain.noticePeriod || !careerBrain.noticePeriod.trim()) notProvided.push('noticePeriod');
  if (!careerBrain.workAuthorization || !careerBrain.workAuthorization.trim()) notProvided.push('workAuthorization');

  const hasResume = Boolean(
    (careerBrain.resumeFileName && careerBrain.resumeFileName.trim()) ||
      (careerBrain.resumeText && careerBrain.resumeText.trim().length >= 20),
  );
  if (!hasResume) notProvided.push('resume');

  return notProvided;
}

/**
 * Detailed prompt builder response including the prompt text and list of not-provided fields.
 */
export interface LinkedInApplyTaskResult {
  taskPrompt: string;
  notProvidedFields: string[];
}

/**
 * Builds the LinkedIn Easy Apply task prompt with full honesty rules and zero silent fallbacks.
 */
export function buildLinkedInApplyTaskDetails(
  careerBrain: ICareerBrain,
  jobTitle?: string,
  companyName?: string,
  location?: string,
): LinkedInApplyTaskResult {
  const notProvidedFields = getNotProvidedFields(careerBrain);

  const formatField = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null) return 'NOT PROVIDED';
    const str = String(val).trim();
    return str.length > 0 ? str : 'NOT PROVIDED';
  };

  const skillsList =
    careerBrain.skills && careerBrain.skills.length > 0 ? careerBrain.skills.join(', ') : 'NOT PROVIDED';

  const skillExpList =
    careerBrain.skillExperience && Object.keys(careerBrain.skillExperience).length > 0
      ? Object.entries(careerBrain.skillExperience)
          .map(([k, v]) => `${k}: ${v} years`)
          .join(', ')
      : 'None recorded';

  const goldenList = (careerBrain.goldenAnswers || []).map(g => `- Q: "${g.question}" -> A: "${g.answer}"`).join('\n');

  const targetJobDisplay = jobTitle?.trim() || 'Active Job';
  const companyDisplay = companyName?.trim() || 'Company';
  const locationDisplay = location?.trim() ? ` (${location.trim()})` : '';

  const taskPrompt = `You are an expert autonomous browser agent applying for a job on LinkedIn via Easy Apply on behalf of the candidate.
Target Job: "${targetJobDisplay}" at "${companyDisplay}"${locationDisplay}.

=== CANDIDATE MASTER PROFILE ===
- Full Name: ${formatField(careerBrain.fullName)}
- Email: ${formatField(careerBrain.email)}
- Phone: ${formatField(careerBrain.phoneNumber)}
- Current Title: ${formatField(careerBrain.currentTitle)}
- Total Years of Experience: ${careerBrain.yearsOfExperience !== undefined && careerBrain.yearsOfExperience !== null ? careerBrain.yearsOfExperience : 'NOT PROVIDED'}
- Primary Skills: ${skillsList}
- Specific Skill Experience: ${skillExpList}
- Education: ${formatField(careerBrain.education)}
- College / University: ${formatField(careerBrain.college)}
- CGPA / Percentage: ${formatField(careerBrain.cgpa)}
- Current CTC: ${formatField(careerBrain.currentCTC)}
- Expected CTC: ${formatField(careerBrain.expectedCTC)}
- Current Location: ${formatField(careerBrain.currentLocation)}
- Preferred Location: ${formatField(careerBrain.preferredLocation)}
- Work Authorization: ${formatField(careerBrain.workAuthorization)}
- Notice Period / Availability: ${formatField(careerBrain.noticePeriod)}
${goldenList ? `\nGOLDEN SCREENING ANSWERS:\n${goldenList}` : ''}
${careerBrain.resumeText && careerBrain.resumeText.trim().length >= 20 ? `\nRESUME SUMMARY:\n${careerBrain.resumeText.slice(0, 700)}...` : ''}

=== STRICT HONESTY & ANTI-HALLUCINATION RULES ===
1. NEVER GUESS OR INVENT ANSWERS:
   - If any required form question asks for factual information marked "NOT PROVIDED" above, or information not present in the Candidate Master Profile or Golden Screening Answers, DO NOT guess, fabricate, or enter placeholder text.
   - Do NOT invent fake college names, false CGPA, fictitious previous salaries, or unverified notice periods.
   - For factual/verifiable fields with no basis in profile (e.g. CTC, skill years, notice period, compliance yes/no), trigger \`ask_user\` so the candidate is prompted once in the side panel and the answer is saved for all future runs.
   - For open-ended, non-factual narrative questions (e.g. "Why do you want this role?"), concise, professional answers derived authentically from the resume are appropriate. Never invent specific dates, numbers, or company names.

2. RESUME UPLOAD VERIFICATION:
   - On the Resume step, verify that a resume file is selected or uploaded.
   - You MUST confirm that the resume file name is visibly selected or displayed on screen before clicking "Next".
   - If no resume is available or selectable, STOP and call \`done\` with an error stating no resume is available.

3. SUCCESS VERIFICATION (NEVER ASSUME SUBMISSION SUCCEEDED):
   - Clicking "Submit application" is NOT proof of success.
   - Only declare success if you see an explicit confirmation message on screen (e.g. "Your application was sent", "Application submitted", "Thank you for applying", or equivalent confirmation dialog).
   - If there is a validation error, an unanswered required field, or an error banner, DO NOT declare success.
   - Once explicit confirmation is visible, close/dismiss the confirmation dialog and call \`done\` with: "Successfully submitted application for ${targetJobDisplay}!".

=== STEP-BY-STEP WORKFLOW & FORM RULES ===

1. STEP 1 - LOCATE & VERIFY THE "EASY APPLY" BUTTON:
   - Look at the Job Details pane for "${targetJobDisplay}".
   - If the solid blue "Easy Apply" or "in Easy Apply" button is not immediately visible, scroll slightly on the page or Job Details container to reveal the action bar.
   - Click the solid blue "Easy Apply" button (usually situated right next to the "Save" button).
   - CRITICAL: DO NOT click the green "Easy Apply" filter pill at the top of the search bar.
   - CRITICAL: DO NOT click job cards in the left-hand search results list.

2. STEP 2 - INSPECT AND FILL THE MODAL FORM:
   - When the Easy Apply modal dialog opens:
   - CRITICAL FORM ACTION: ALWAYS prefer using the \`fill_visible_form_fields\` action to efficiently batch-fill all visible inputs in the modal rather than individual single-character clicks.
   - \`fill_visible_form_fields\` automatically executes the 4 standard form-filling rules:
     * [MATCHED] Semantic Matching: Matches ambiguous question wording (e.g. "server-side JavaScript" -> Node.js) to stored skillExperience, golden answers, and profile facts without invention.
     * [GENERATED] Free-Text Answers: Generates concise, professional narrative responses (1-3 sentences) from the resume for subjective questions ("Why do you want this role?"). Never fabricates unverified factual claims.
     * [ASKED] Factual Zero-Invention: For factual fields with no profile basis (CTC, unlisted skill years, notice period, compliance yes/no), it prompts the user once in the side panel and auto-saves the answer to memory so future applications reuse it automatically.
     * Auditable Logging: Categorizes and reports each filled field in Live Activity.
   - Contact Info (Phone, Email, Name):
     * Check if already pre-filled. If Phone and Email are already populated with valid text, DO NOT overwrite or re-type them. Simply proceed.
     * If empty, fill with candidate's phone or email from Candidate Master Profile.
   - Resume Step:
     * Check that a resume is selected (radio button selected or default resume attached).
     * Verify that the resume file name is visible.
   - Screening Questions:
     * Specific Skill Experience ("How many years of experience in [Skill X]?"): Use ONLY the exact value for [Skill X] from Specific Skill Experience. DO NOT use total years of experience. If [Skill X] is not recorded in Specific Skill Experience, trigger \`ask_user\` to request the answer from the candidate; NEVER guess or enter random numbers.
     * Numeric CTC / Salary: Enter a single whole number only (e.g. 1500000), NEVER a range, text, or symbols (never enter "12-15 LPA" or "$100k-$120k").
     * Work authorization: Use candidate's work authorization status ("${formatField(careerBrain.workAuthorization)}").
     * Golden screening questions: Use the exact answer from the Golden Screening Answers list if matched.
     * Radio groups & dropdowns: Select the option that matches the candidate profile. If unknown and required, trigger \`ask_user\`.
   - Scroll if necessary to inspect footer buttons and click "Next", "Continue to next step", or "Review your application".

3. STEP 3 - FINAL REVIEW, SUBMIT & CONFIRM:
   - On the final Review step:
     * Scroll to the bottom of the review dialog.
     * Verify all required sections are complete.
     * Click the primary "Submit application" button.
   - After clicking Submit, inspect the page for the confirmation dialog ("Your application was sent" or "Application submitted").
   - If confirmed, click the "Dismiss" or "X" button to close the confirmation popup.
   - Call \`done\` with the verified success message: "Successfully submitted application for ${targetJobDisplay}!".`;

  return { taskPrompt, notProvidedFields };
}

/**
 * Builds a highly detailed, human-like instruction prompt for the LLM Planner & Navigator
 * to perform a manual-style LinkedIn Easy Apply on the currently open job.
 */
export function buildLinkedInApplyTask(
  careerBrain: ICareerBrain,
  jobTitle?: string,
  companyName?: string,
  location?: string,
): string {
  return buildLinkedInApplyTaskDetails(careerBrain, jobTitle, companyName, location).taskPrompt;
}
