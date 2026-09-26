// chrome-extension/src/background/agent/taskBuilderExternal.ts
import type { ICareerBrain } from '@extension/storage';
import { getNotProvidedFields } from './linkedin/taskBuilder';

/**
 * Detailed prompt builder response for external job sites.
 */
export interface ExternalApplyTaskResult {
  taskPrompt: string;
  notProvidedFields: string[];
}

/**
 * Builds an instruction prompt for external job application sites (Greenhouse, Lever,
 * Workday, Indeed, company career portals, etc.) without LinkedIn-specific selectors.
 */
export function buildExternalApplyTaskDetails(
  careerBrain: ICareerBrain,
  jobTitle?: string,
  companyName?: string,
): ExternalApplyTaskResult {
  const notProvidedFields = getNotProvidedFields(careerBrain);

  const formatField = (val: string | number | undefined | null): string => {
    if (val === undefined || val === null) return 'NOT PROVIDED';
    const str = String(val).trim();
    return str.length > 0 ? str : 'NOT PROVIDED';
  };

  const skillsList =
    careerBrain.skills && careerBrain.skills.length > 0 ? careerBrain.skills.join(', ') : 'NOT PROVIDED';

  const goldenList = (careerBrain.goldenAnswers || []).map(g => `- Q: "${g.question}" -> A: "${g.answer}"`).join('\n');

  const targetJobDisplay = jobTitle?.trim() || 'Active Job';
  const companyDisplay = companyName?.trim() || 'Company';

  const taskPrompt = `You are an expert autonomous browser agent applying for a job on an external career portal on behalf of the candidate.
Target Job: "${targetJobDisplay}" at "${companyDisplay}".

=== CANDIDATE MASTER PROFILE ===
- Full Name: ${formatField(careerBrain.fullName)}
- Email: ${formatField(careerBrain.email)}
- Phone: ${formatField(careerBrain.phoneNumber)}
- Current Title: ${formatField(careerBrain.currentTitle)}
- Total Years of Experience: ${careerBrain.yearsOfExperience !== undefined && careerBrain.yearsOfExperience !== null ? careerBrain.yearsOfExperience : 'NOT PROVIDED'}
- Primary Skills: ${skillsList}
- Education: ${formatField(careerBrain.education)}
- College / University: ${formatField(careerBrain.college)}
- CGPA / Percentage: ${formatField(careerBrain.cgpa)}
- Current CTC: ${formatField(careerBrain.currentCTC)}
- Expected CTC: ${formatField(careerBrain.expectedCTC)}
- Current Location: ${formatField(careerBrain.currentLocation)}
- Preferred Location: ${formatField(careerBrain.preferredLocation)}
- Work Authorization: ${formatField(careerBrain.workAuthorization)}
- Notice Period / Availability: ${formatField(careerBrain.noticePeriod)}
- LinkedIn Profile: ${formatField(careerBrain.linkedinUrl)}
- GitHub Profile: ${formatField(careerBrain.githubUrl)}
- Portfolio URL: ${formatField(careerBrain.portfolioUrl)}
${goldenList ? `\nGOLDEN SCREENING ANSWERS:\n${goldenList}` : ''}
${careerBrain.resumeText && careerBrain.resumeText.trim().length >= 20 ? `\nRESUME SUMMARY:\n${careerBrain.resumeText.slice(0, 700)}...` : ''}

=== STRICT HONESTY & ANTI-HALLUCINATION RULES ===
1. NEVER GUESS OR INVENT ANSWERS:
   - If any required form question asks for information marked "NOT PROVIDED" above, or information not present in the Candidate Master Profile or Golden Screening Answers, DO NOT guess, fabricate, or enter placeholder text.
   - Do NOT invent fake college names, false CGPA, fictitious previous salaries, or unverified notice periods.
   - If a required form question cannot be answered truthfully with available candidate data, STOP immediately and call \`done\` with an explanation stating exactly what information is missing (e.g. "Application stopped: Missing required information for '[question name]'. Please update your profile in the Resume & Profile tab.").

2. RESUME UPLOAD VERIFICATION:
   - When encountering a resume upload input, ensure a resume file is selected/attached.
   - You MUST confirm that the uploaded resume file name or attachment badge is visibly displayed on screen before advancing or submitting.
   - If no resume is available, STOP and call \`done\` with an error stating no resume is available.

3. SUCCESS VERIFICATION (NEVER ASSUME SUBMISSION SUCCEEDED):
   - Clicking "Submit", "Submit Application", or "Apply" is NOT proof of success.
   - Only declare success if you see an explicit confirmation message on screen (e.g. "Thank you for applying", "Application received", "Your application has been submitted", or a confirmed completion page).
   - If there is a validation error, an unanswered required field, or an error alert, DO NOT declare success.
   - Once explicit confirmation is visible, call \`done\` with: "Successfully submitted application for ${targetJobDisplay} at ${companyDisplay}!".

=== STEP-BY-STEP EXTERNAL APPLICATION WORKFLOW ===

1. STEP 1 - LOCATE APPLICATION FORM OR APPLY BUTTON:
   - Inspect the open page for an application form or an "Apply", "Apply Now", or "I'm interested" button.
   - If an "Apply Now" button is present and the form is not yet visible, click the button to reveal the application form.
   - Scroll down smoothly to inspect the entire application form structure.

2. STEP 2 - FILL PERSONAL & CONTACT INFORMATION:
   - Candidate Name: Enter First Name and Last Name from Full Name ("${formatField(careerBrain.fullName)}").
   - Email: Enter "${formatField(careerBrain.email)}". Do not overwrite if already pre-filled accurately.
   - Phone: Enter "${formatField(careerBrain.phoneNumber)}". Do not overwrite if already pre-filled accurately.
   - Location / Address: Use Current Location ("${formatField(careerBrain.currentLocation)}") or Preferred Location ("${formatField(careerBrain.preferredLocation)}").
   - URLs: Provide LinkedIn, GitHub, or Portfolio URLs from the profile if asked.

3. STEP 3 - FILL PROFESSIONAL & SCREENING DETAILS:
   - Job Title / Current Company: Use "${formatField(careerBrain.currentTitle)}".
   - Experience: Use "${careerBrain.yearsOfExperience !== undefined && careerBrain.yearsOfExperience !== null ? careerBrain.yearsOfExperience : 'NOT PROVIDED'}".
   - Education / College / Degree / GPA: Use verified college ("${formatField(careerBrain.college)}") and CGPA ("${formatField(careerBrain.cgpa)}"). If missing, do not invent.
   - Compensation / CTC: Use Current CTC ("${formatField(careerBrain.currentCTC)}") and Expected CTC ("${formatField(careerBrain.expectedCTC)}").
   - Notice Period / Availability: Use "${formatField(careerBrain.noticePeriod)}".
   - Work Authorization: Use "${formatField(careerBrain.workAuthorization)}".
   - Screening questions: Check against the Golden Screening Answers list.

4. STEP 4 - RESUME ATTACHMENT:
   - If a file upload for Resume / CV is present, attach the candidate resume file.
   - Verify that the attached file name is visible in the form before proceeding.

5. STEP 5 - REVIEW & SUBMIT WITH VERIFICATION:
   - Scroll through all sections to ensure no required field was missed or left blank.
   - Click the "Submit", "Submit Application", or "Send Application" button.
   - Inspect the page for explicit post-submission confirmation text.
   - Only after seeing confirmation, call \`done\` with: "Successfully submitted application for ${targetJobDisplay} at ${companyDisplay}!".`;

  return { taskPrompt, notProvidedFields };
}

/**
 * Builds an instruction prompt for external job application sites.
 */
export function buildExternalApplyTask(careerBrain: ICareerBrain, jobTitle?: string, companyName?: string): string {
  return buildExternalApplyTaskDetails(careerBrain, jobTitle, companyName).taskPrompt;
}
