import {
  careerBrainStore,
  type ICareerBrain,
  standardizeLocationString,
  cleanLocationForCityField,
} from '@extension/storage';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getActiveChatModel } from '../activeModelHelper';
import { createLogger } from '../../log';

const logger = createLogger('CareerCopilotEngine');

export interface MissingFieldItem {
  field: keyof ICareerBrain | string;
  label: string;
  promptQuestion: string;
  quickOptions?: string[];
  priority: 'high' | 'medium' | 'low';
}

export interface ProfileAuditResult {
  score: number;
  missingFields: MissingFieldItem[];
  completedCount: number;
  totalCheckCount: number;
}

export interface CopilotFitReport {
  matchScore: number;
  verdict: 'STRONG_MATCH' | 'MODERATE_MATCH' | 'LOW_FIT';
  matchingSkills: string[];
  missingSkills: string[];
  summary: string;
  actionableTip: string;
}

export interface CopilotChatResponse {
  reply: string;
  actionType: 'audit' | 'update' | 'job_fit' | 'pitch' | 'cover_letter' | 'profile_summary' | 'interview' | 'general';
  profileCompleteness?: number;
  updatedFields?: Array<{
    field: string;
    label: string;
    value: any;
  }>;
  quickOptions?: string[];
  fitReport?: CopilotFitReport;
  coverLetter?: string;
}

/**
 * Audits Career Brain profile completeness out of 100%.
 * Identifies high-value missing fields in order of priority.
 */
export function auditCareerBrain(brain: ICareerBrain): ProfileAuditResult {
  const missing: MissingFieldItem[] = [];
  let score = 0;

  // 1. Full Name (10 pts)
  if (brain.fullName && brain.fullName.trim() && brain.fullName !== 'Candidate') {
    score += 10;
  } else {
    missing.push({
      field: 'fullName',
      label: 'Full Name',
      promptQuestion: 'What is your full legal name as shown on your resume?',
      priority: 'high',
    });
  }

  // 2. Current Title (10 pts)
  if (brain.currentTitle && brain.currentTitle.trim()) {
    score += 10;
  } else {
    missing.push({
      field: 'currentTitle',
      label: 'Current Job Title',
      promptQuestion: 'What is your current or target job title (e.g. Full Stack Developer, React Engineer)?',
      quickOptions: ['Full Stack Developer', 'Frontend Developer', 'Backend Developer', 'Software Engineer'],
      priority: 'high',
    });
  }

  // 3. Technical Skills (15 pts)
  if (brain.skills && brain.skills.length >= 3) {
    score += 15;
  } else {
    missing.push({
      field: 'skills',
      label: 'Technical Skills',
      promptQuestion: 'What are your core technical skills and primary tech stack?',
      quickOptions: ['React, Node.js, TypeScript', 'Python, Django, AWS', 'Java, Spring Boot, MySQL'],
      priority: 'high',
    });
  }

  // 4. Current Location (10 pts)
  if (brain.currentLocation && brain.currentLocation.trim()) {
    score += 10;
  } else {
    missing.push({
      field: 'currentLocation',
      label: 'Current Location',
      promptQuestion: 'What is your current location (City, State, Country)?',
      quickOptions: [
        'Bengaluru, Karnataka, India',
        'Hyderabad, Telangana, India',
        'Pune, Maharashtra, India',
        'Delhi / NCR, India',
        'Mumbai, Maharashtra, India',
      ],
      priority: 'high',
    });
  }

  // 5. Preferred Locations (Top 3 Priority) (15 pts)
  const prefCount = (brain.preferredLocations || []).filter(Boolean).length;
  if (prefCount >= 2) {
    score += 15;
  } else if (prefCount === 1) {
    score += 10;
    missing.push({
      field: 'preferredLocations',
      label: 'Secondary Preferred Location (#2 Priority)',
      promptQuestion: `Your Priority #1 location is "${brain.preferredLocations?.[0] || brain.preferredLocation}". What is your secondary preferred city (Priority #2)?`,
      quickOptions: [
        'Pune, Maharashtra, India',
        'Hyderabad, Telangana, India',
        'Noida, Uttar Pradesh, India',
        'Remote',
      ],
      priority: 'medium',
    });
  } else {
    missing.push({
      field: 'preferredLocations',
      label: 'Target Preferred Locations',
      promptQuestion: 'What are your preferred job locations in order of priority?',
      quickOptions: [
        'Bengaluru, Karnataka, India',
        'Remote',
        'Hyderabad, Telangana, India',
        'Pune, Maharashtra, India',
      ],
      priority: 'high',
    });
  }

  // 6. Notice Period / Availability (10 pts)
  if (brain.noticePeriod && brain.noticePeriod.trim()) {
    score += 10;
  } else {
    missing.push({
      field: 'noticePeriod',
      label: 'Notice Period',
      promptQuestion: 'What is your notice period or availability to start a new role?',
      quickOptions: ['Immediate', '15 Days', '30 Days', '60 Days', 'Serving Notice Period'],
      priority: 'high',
    });
  }

  // 7. Compensation (Expected CTC) (10 pts)
  if (brain.expectedCTC && brain.expectedCTC.trim()) {
    score += 10;
  } else {
    missing.push({
      field: 'expectedCTC',
      label: 'Expected CTC',
      promptQuestion: 'What is your expected annual compensation (CTC) bracket?',
      quickOptions: ['₹6,00,000 - ₹10,00,000', '₹10,00,000 - ₹15,00,000', '₹15,00,000 - ₹25,00,000', 'Negotiable'],
      priority: 'medium',
    });
  }

  // 8. Background Narrative (10 pts)
  if (brain.backgroundNarrative && brain.backgroundNarrative.trim().length > 60) {
    score += 10;
  } else {
    missing.push({
      field: 'backgroundNarrative',
      label: 'Professional Narrative',
      promptQuestion:
        'Your professional background narrative is empty. Would you like to share a 2-3 sentence summary of your experience?',
      priority: 'medium',
    });
  }

  // 9. Links & Socials (GitHub / Portfolio) (10 pts)
  if (brain.githubUrl && brain.githubUrl.trim() && brain.githubUrl !== 'https://github.com') {
    score += 10;
  } else {
    missing.push({
      field: 'githubUrl',
      label: 'GitHub URL',
      promptQuestion: 'What is your GitHub profile or personal portfolio URL?',
      quickOptions: ['Skip for now'],
      priority: 'low',
    });
  }

  return {
    score: Math.min(100, score),
    missingFields: missing,
    completedCount: 10 - missing.length,
    totalCheckCount: 10,
  };
}

/**
 * Detects whether the user is speaking in Hinglish or English.
 * Defaults strictly to 'english' unless Hindi/Hinglish vocabulary tokens are present.
 */
export function detectUserLanguage(text: string): 'hinglish' | 'english' {
  const lower = text.toLowerCase();
  const hinglishTokens = [
    'kya',
    'hai',
    'hain',
    'mera',
    'meri',
    'mere',
    'batao',
    'karo',
    'kar do',
    'krdo',
    'nhi',
    'nahi',
    'kaise',
    'hoga',
    'bacha',
    'bana',
    'bataiye',
    'karenge',
    'karu',
    'shuru',
    'mujhe',
    'aapse',
    'hum',
    'tum',
    'kuch',
    'accha',
    'kijiye',
    'dijiye',
    'bolo',
    'chahiye',
    'dekho',
    'sunte',
    'bataye',
    'din',
    'bhai',
    'yaar',
    'paas',
    'dikhao',
  ];
  const words = lower.split(/[^a-zA-Z]+/);
  const matchCount = words.filter(w => hinglishTokens.includes(w)).length;
  return matchCount >= 1 ? 'hinglish' : 'english';
}

/**
 * Main Career Copilot Conversational Engine
 */
export class CareerCopilotEngine {
  /**
   * Processes a conversational message from the user in Career Copilot Mode.
   */
  async processMessage(params: {
    userMessage: string;
    chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    activeTab?: { url?: string; title?: string; pageText?: string };
  }): Promise<CopilotChatResponse> {
    const { userMessage, chatHistory = [], activeTab } = params;
    const brain = await careerBrainStore.getCareerBrain();
    const audit = auditCareerBrain(brain);
    const qLower = userMessage.toLowerCase().trim();
    const userLang = detectUserLanguage(userMessage);

    logger.info('Processing Copilot message:', { userMessage, userLang, auditScore: audit.score });

    // ─── 1. Check for Direct "Audit / What is missing" Intent ───
    if (
      qLower.includes('audit') ||
      qLower.includes('missing') ||
      qLower.includes('profile check') ||
      qLower.includes('kya bacha hai') ||
      qLower.includes('complete profile') ||
      qLower.includes('profile status') ||
      qLower.includes('profile score') ||
      qLower === 'audit my profile' ||
      qLower === 'fill missing details'
    ) {
      return this.handleProfileAuditResponse(audit, userLang);
    }

    // ─── 2. Check for "Profile Summary / Show my details" Intent ───
    if (
      qLower.includes('show profile') ||
      qLower.includes('view profile') ||
      qLower.includes('my profile') ||
      qLower.includes('mera profile') ||
      qLower.includes('profile dikhao') ||
      qLower.includes('profile details') ||
      qLower.includes('what is my profile')
    ) {
      return this.generateProfileSummaryResponse(brain, audit, userLang);
    }

    // ─── 3. Check for "Skills / Tech Stack" Intent ───
    if (
      (qLower.includes('skill') || qLower.includes('tech stack') || qLower.includes('technologies')) &&
      !qLower.includes('add') &&
      !qLower.includes('update')
    ) {
      return this.generateSkillsResponse(brain, userLang);
    }

    // ─── 4. Check for "Cover Letter / Pitch" Intent ───
    if (
      qLower.includes('cover letter') ||
      qLower.includes('cover note') ||
      qLower.includes('why hire me') ||
      qLower.includes('application letter') ||
      qLower === 'generate cover letter'
    ) {
      return this.generateDynamicCoverLetter(brain, activeTab, userLang);
    }

    // ─── 5. Check for "Short Recruiter Pitch" Intent ───
    if (
      qLower.includes('pitch') ||
      qLower.includes('message for hr') ||
      qLower.includes('inmail') ||
      qLower === 'draft tailored recruiter pitch'
    ) {
      return this.generateTailoredPitch(brain, activeTab, userLang);
    }

    // ─── 6. Check for "Job Fit / Am I fit" Intent ───
    if (
      qLower.includes('fit') ||
      qLower.includes('job fit') ||
      qLower.includes('match') ||
      qLower.includes('eligible') ||
      qLower.includes('kya mai apply karu') ||
      qLower === 'check fit for open job page' ||
      qLower.includes('check fit for current tab')
    ) {
      return this.analyzeJobFit(brain, activeTab, userLang);
    }

    // ─── 7. Check for "Mock Interview" Intent ───
    if (
      qLower.includes('mock interview') ||
      qLower.includes('screening interview') ||
      qLower.includes('interview practice') ||
      qLower === 'start mock screening interview'
    ) {
      return this.conductMockInterview(brain, userMessage, chatHistory, userLang);
    }

    // ─── 8. Conversational Profile Auto-Fill & General Intelligence ───
    return this.handleConversationalFillOrQA(brain, audit, userMessage, chatHistory, userLang, activeTab);
  }

  /**
   * Generates a clear profile audit response with missing fields and next priority question.
   */
  private handleProfileAuditResponse(audit: ProfileAuditResult, userLang: 'hinglish' | 'english'): CopilotChatResponse {
    if (audit.missingFields.length === 0) {
      return {
        reply:
          userLang === 'hinglish'
            ? `🎉 **Shabash! Aapka Career Profile 100% Complete Hai!**\n\nSabhi core fields, prioritized locations, notice period, aur background narrative properly configured hain. Aap kisi bhi job par 1-click se apply kar sakte hain!`
            : `🎉 **Outstanding! Your Career Profile is 100% Complete!**\n\nAll core fields, top-3 prioritized locations, notice period, and background narrative are properly configured. You are fully ready for 1-click autonomous applications!`,
        actionType: 'audit',
        profileCompleteness: 100,
        quickOptions: ['Check Fit for Open Job Page', 'Generate Cover Letter', 'Draft Tailored Recruiter Pitch'],
      };
    }

    const next = audit.missingFields[0];
    const missingLabels = audit.missingFields.map(m => `**${m.label}**`).join(', ');

    return {
      reply:
        userLang === 'hinglish'
          ? `📊 **Aapka Profile Strength: ${audit.score}% Ready**\n\nAbhi ye details missing hain: ${missingLabels}.\n\nAaiye isko 100% complete karte hain taaki jobs apply karte time bot kabhi ruke na:\n\n👉 **${next.promptQuestion}**`
          : `📊 **Profile Readiness: ${audit.score}% Complete**\n\nMissing items to complete: ${missingLabels}.\n\nLet's complete your profile so automated applications glide through without stopping:\n\n👉 **${next.promptQuestion}**`,
      actionType: 'audit',
      profileCompleteness: audit.score,
      quickOptions: next.quickOptions || ['Show My Profile', 'Generate Cover Letter'],
    };
  }

  /**
   * Generates a comprehensive summary of the candidate's Career Brain.
   */
  private generateProfileSummaryResponse(
    brain: ICareerBrain,
    audit: ProfileAuditResult,
    userLang: 'hinglish' | 'english',
  ): CopilotChatResponse {
    const locations = (brain.preferredLocations || []).filter(Boolean);
    const locString =
      locations.length > 0
        ? locations.map((loc, idx) => `#${idx + 1} ${loc}`).join(' | ')
        : brain.preferredLocation || 'Not set';

    const reply =
      userLang === 'hinglish'
        ? `### 📋 **Aapka Career Brain Profile Overview (${audit.score}% Ready)**

- **Full Name:** ${brain.fullName || 'Candidate'}
- **Target Job Title:** ${brain.currentTitle || 'Software Engineer'}
- **Total Experience:** ${brain.yearsOfExperience ?? 1} years
- **Current Location:** ${brain.currentLocation || 'Not set'}
- **Preferred Locations (Priority):** ${locString}
- **Notice Period:** ${brain.noticePeriod || 'Not set'}
- **Expected CTC:** ${brain.expectedCTC || brain.salaryExpectation || 'Not set'}
- **GitHub / Portfolio:** ${brain.githubUrl || 'Not set'}

🛠️ **Technical Skills (${brain.skills?.length || 0}):**
${(brain.skills || []).map(s => `\`${s}\``).join('  ') || 'No skills added yet'}

${audit.missingFields.length > 0 ? `\n👉 **Missing Fields:** ${audit.missingFields.map(m => m.label).join(', ')}` : '\n✅ **All required profile fields are filled!**'}`
        : `### 📋 **Career Brain Profile Overview (${audit.score}% Complete)**

- **Full Name:** ${brain.fullName || 'Candidate'}
- **Target Role / Title:** ${brain.currentTitle || 'Software Engineer'}
- **Total Experience:** ${brain.yearsOfExperience ?? 1} years
- **Current Location:** ${brain.currentLocation || 'Not specified'}
- **Preferred Locations (Priority):** ${locString}
- **Notice Period:** ${brain.noticePeriod || 'Not specified'}
- **Expected Compensation:** ${brain.expectedCTC || brain.salaryExpectation || 'Not specified'}
- **GitHub / Portfolio:** ${brain.githubUrl || 'Not specified'}

🛠️ **Technical Skills (${brain.skills?.length || 0}):**
${(brain.skills || []).map(s => `\`${s}\``).join('  ') || 'None listed'}

${audit.missingFields.length > 0 ? `\n👉 **Missing Items:** ${audit.missingFields.map(m => m.label).join(', ')}` : '\n✅ **Profile is 100% complete and ready for applications!**'}`;

    return {
      reply,
      actionType: 'profile_summary',
      profileCompleteness: audit.score,
      quickOptions:
        audit.missingFields.length > 0
          ? [audit.missingFields[0].promptQuestion, 'Audit My Profile', 'Generate Cover Letter']
          : ['Generate Cover Letter', 'Check Fit for Open Job Page', 'Draft Tailored Recruiter Pitch'],
    };
  }

  /**
   * Generates a skills breakdown and intelligent tech stack recommendations.
   */
  private generateSkillsResponse(brain: ICareerBrain, userLang: 'hinglish' | 'english'): CopilotChatResponse {
    const skills = brain.skills || [];
    const title = brain.currentTitle || 'Software Engineer';

    let recommendations: string[] = [];
    const lowerTitle = title.toLowerCase();
    if (lowerTitle.includes('front') || lowerTitle.includes('react')) {
      recommendations = ['TypeScript', 'Next.js', 'Redux Toolkit', 'TailwindCSS', 'Jest / React Testing Library'];
    } else if (lowerTitle.includes('back') || lowerTitle.includes('node') || lowerTitle.includes('python')) {
      recommendations = ['Docker', 'Kubernetes', 'PostgreSQL', 'Redis', 'Microservices Architecture', 'AWS'];
    } else {
      recommendations = ['Docker', 'System Design', 'CI/CD Pipelines', 'TypeScript', 'Cloud (AWS/GCP)'];
    }

    const missingRecommended = recommendations.filter(r => !skills.some(s => s.toLowerCase() === r.toLowerCase()));

    const reply =
      userLang === 'hinglish'
        ? `### 🛠️ **Aapke Saved Skills (${skills.length})**
${skills.map(s => `\`${s}\``).join('  ') || 'Koi skills nahi mili.'}

💡 **Aapke Role ("${title}") ke liye In-Demand Keywords:**
${missingRecommended
  .slice(0, 4)
  .map(m => `+ \`${m}\``)
  .join('  ')}

> Agar aap inme se koi skill add karna chahte hain, bas likhiye: *"Add ${missingRecommended.slice(0, 2).join(', ')}"* aur mai profile me add kar dunga!`
        : `### 🛠️ **Your Saved Technical Skills (${skills.length})**
${skills.map(s => `\`${s}\``).join('  ') || 'No skills recorded.'}

💡 **High-Demand Skill Keywords for "${title}":**
${missingRecommended
  .slice(0, 4)
  .map(m => `+ \`${m}\``)
  .join('  ')}

> To add any of these to your profile, simply reply: *"Add ${missingRecommended.slice(0, 2).join(', ')}"* and I will instantly save them to your Career Brain!`;

    return {
      reply,
      actionType: 'general',
      quickOptions:
        missingRecommended.length > 0
          ? [`Add ${missingRecommended.slice(0, 2).join(', ')}`, 'Audit My Profile', 'Generate Cover Letter']
          : ['Generate Cover Letter', 'Check Fit for Open Job Page'],
    };
  }

  /**
   * Generates a tailored 3-paragraph Cover Letter using active tab context or candidate profile.
   */
  public async generateDynamicCoverLetter(
    brain: ICareerBrain,
    activeTab?: { url?: string; title?: string; pageText?: string },
    userLang: 'hinglish' | 'english' = 'english',
  ): Promise<CopilotChatResponse> {
    const jobTitle = activeTab?.title?.split(/[-–|]/)[0]?.trim() || brain.currentTitle || 'Software Engineer';
    const company = activeTab?.title?.split(/[-–|]/)[1]?.trim() || 'Hiring Team';
    const pageSnippet = (activeTab?.pageText || '').slice(0, 2500);

    const llm = await getActiveChatModel();

    if (llm && pageSnippet.length > 100) {
      const prompt = `You are a world-class executive resume writer and career coach.
Write a compelling, tailored 3-paragraph cover letter for a candidate applying to this job.

CANDIDATE:
- Name: ${brain.fullName || 'Candidate'}
- Current Title: ${brain.currentTitle || 'Software Engineer'}
- Years of Experience: ${brain.yearsOfExperience ?? 1}
- Top Skills: ${(brain.skills || []).slice(0, 6).join(', ')}
- Narrative / Highlights: ${brain.backgroundNarrative || ''}

TARGET JOB CONTEXT:
- Role: ${jobTitle}
- Company: ${company}
- Job Description Excerpt:
${pageSnippet}

REQUIREMENTS:
1. Paragraph 1: Enthusiastic hook referencing the specific role and company, highlighting candidate's core expertise.
2. Paragraph 2: High-impact technical evidence matching specific requirements from the job description with candidate skills.
3. Paragraph 3: Cultural alignment, immediate availability/notice period (${brain.noticePeriod || 'immediate'}), and a polite call to action for an interview.
4. Tone: Confident, articulate, professional, zero generic fluff.
Output ONLY the clean text of the cover letter.`;

      try {
        const response = await llm.invoke([
          new SystemMessage('You write high-converting, tailored cover letters. Output only the letter.'),
          new HumanMessage(prompt),
        ]);
        const letter = typeof response.content === 'string' ? response.content.trim() : String(response.content);

        return {
          reply:
            userLang === 'hinglish'
              ? `### ✍️ **Tailored Cover Letter for "${jobTitle}" at ${company}**\n\n${letter}\n\n> *Aap is cover letter ko copy karke application form ya message me directly paste kar sakte hain!*`
              : `### ✍️ **Tailored Cover Letter for "${jobTitle}" at ${company}**\n\n${letter}\n\n> *You can copy and use this cover letter directly for your job application submission!*`,
          actionType: 'cover_letter',
          coverLetter: letter,
          quickOptions: ['Check Fit for Open Job Page', 'Draft Tailored Recruiter Pitch', 'Show My Profile'],
        };
      } catch (err) {
        logger.warning('LLM cover letter generation error, using smart template:', err);
      }
    }

    // Structured Smart Template (Offline / Fallback)
    const name = brain.fullName || 'Candidate';
    const role = brain.currentTitle || jobTitle;
    const exp = brain.yearsOfExperience ? `${brain.yearsOfExperience}+ years` : 'a proven track record';
    const topSkills = (brain.skills || []).slice(0, 5).join(', ') || 'modern software engineering principles';
    const notice = brain.noticePeriod || 'immediate availability';

    const fallbackLetter = `Dear Hiring Team at ${company},

I am writing to express my strong enthusiasm for the ${jobTitle} position. With ${exp} of professional experience specializing in ${topSkills}, I have developed a deep passion for building scalable, high-performance web applications and backend systems that drive tangible business value.

In my recent work as a ${role}, I have engineered robust features, optimized system latency, and collaborated closely with cross-functional teams to deliver reliable software on schedule. My proficiency with ${topSkills} allows me to rapidly adapt to existing codebases and implement clean, testable architectural patterns.

I am particularly excited about the opportunity to contribute to ${company}. With my background, strong ownership mindset, and ${notice}, I am confident in my ability to make an immediate impact. Thank you for your time and consideration, and I look forward to discussing my qualifications in an interview.

Sincerely,
${name}`;

    return {
      reply:
        userLang === 'hinglish'
          ? `### ✍️ **Tailored Cover Letter for "${jobTitle}" at ${company}**\n\n${fallbackLetter}\n\n> *Aap is cover letter ko copy karke directly application form me paste kar sakte hain!*`
          : `### ✍️ **Tailored Cover Letter for "${jobTitle}" at ${company}**\n\n${fallbackLetter}\n\n> *You can copy this tailored cover letter directly into the application form!*`,
      actionType: 'cover_letter',
      coverLetter: fallbackLetter,
      quickOptions: ['Check Fit for Open Job Page', 'Draft Tailored Recruiter Pitch', 'Show My Profile'],
    };
  }

  /**
   * Generates a tailored 3-sentence recruiter pitch message.
   */
  private async generateTailoredPitch(
    brain: ICareerBrain,
    activeTab?: { url?: string; title?: string; pageText?: string },
    userLang: 'hinglish' | 'english' = 'english',
  ): Promise<CopilotChatResponse> {
    const jobSummary = (activeTab?.pageText || activeTab?.title || 'Software Engineering Role').slice(0, 1000);
    const llm = await getActiveChatModel();

    if (llm) {
      const prompt = `Write a high-impact, punchy 3-sentence application note/pitch from candidate to hiring manager.
Candidate: ${brain.fullName}, ${brain.currentTitle}, ${brain.yearsOfExperience} yrs experience.
Tech Stack: ${(brain.skills || []).slice(0, 6).join(', ')}.
Narrative: ${brain.backgroundNarrative}.
Target Job Context: ${jobSummary}.
Tone: Confident, professional, tailored, zero fluff. Output ONLY the pitch note.`;

      try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const pitch = typeof response.content === 'string' ? response.content.trim() : String(response.content);

        return {
          reply:
            userLang === 'hinglish'
              ? `✍️ **Tailored Recruiter Pitch (Ready to Send):**\n\n> "${pitch}"\n\nAap is pitch ko LinkedIn InMail, Easy Apply cover note, ya email me directly use kar sakte hain!`
              : `✍️ **Tailored Recruiter Application Pitch (Ready to Send):**\n\n> "${pitch}"\n\nYou can use this tailored note directly for LinkedIn InMail, Easy Apply application notes, or outreach emails!`,
          actionType: 'pitch',
          quickOptions: ['Generate Cover Letter', 'Check Fit for Open Job Page', 'Audit My Profile'],
        };
      } catch {
        // Fallback
      }
    }

    const fallbackPitch = `Hi! With ${brain.yearsOfExperience ?? 1} years of experience specializing in ${(brain.skills || []).slice(0, 3).join(', ')}, I have built scalable production systems that solve real-world problems. I am very impressed by your team's work and would love to contribute my technical background to this role. Looking forward to connecting!`;

    return {
      reply:
        userLang === 'hinglish'
          ? `✍️ **Tailored Recruiter Pitch:**\n\n> "${fallbackPitch}"`
          : `✍️ **Tailored Recruiter Application Pitch:**\n\n> "${fallbackPitch}"`,
      actionType: 'pitch',
      quickOptions: ['Generate Cover Letter', 'Check Fit for Open Job Page'],
    };
  }

  /**
   * Analyzes job description on active browser tab against candidate Career Brain.
   */
  private async analyzeJobFit(
    brain: ICareerBrain,
    activeTab?: { url?: string; title?: string; pageText?: string },
    userLang: 'hinglish' | 'english' = 'english',
  ): Promise<CopilotChatResponse> {
    const jobText = (activeTab?.pageText || '').trim();
    const jobTitle = activeTab?.title || 'Target Job';

    if (!jobText || jobText.length < 50) {
      return {
        reply:
          userLang === 'hinglish'
            ? `⚠️ **Active Tab Par Job Description Nahi Mila**\n\nKripya kisi job post (LinkedIn, Indeed, ya Naukri job detail page) par tab open karein, ya job description text yahan paste karein. Uske baad mai instant **Job Fit Report** generate kar dunga!`
            : `⚠️ **No Job Description Found on Active Tab**\n\nPlease navigate to an open job listing page (LinkedIn, Indeed, Naukri, or company careers page) or paste the job description text here, and I'll generate an instant **Job Fit Report**!`,
        actionType: 'job_fit',
        quickOptions: ['Audit My Profile', 'Generate Cover Letter', 'Draft Tailored Recruiter Pitch'],
      };
    }

    const llm = await getActiveChatModel();
    if (!llm) {
      // Deterministic keyword matching fit calculation
      const skills = brain.skills || [];
      const lowerJob = jobText.toLowerCase();
      const matched = skills.filter(s => lowerJob.includes(s.toLowerCase()));
      const missing = skills.filter(s => !lowerJob.includes(s.toLowerCase())).slice(0, 3);
      const score = Math.min(95, Math.max(40, Math.round((matched.length / Math.max(skills.length, 1)) * 100)));

      const report: CopilotFitReport = {
        matchScore: score,
        verdict: score >= 75 ? 'STRONG_MATCH' : score >= 55 ? 'MODERATE_MATCH' : 'LOW_FIT',
        matchingSkills: matched,
        missingSkills: missing,
        summary: `Your profile shares strong alignment in ${matched.slice(0, 3).join(', ')}.`,
        actionableTip: `Highlight your practical project experience with ${matched.slice(0, 2).join(' and ')} in your application cover note.`,
      };

      return {
        reply: `### 🎯 Job Fit Analysis: **${score}% Match**\n**Job:** ${jobTitle.slice(0, 60)}\n\n✅ **Matching Strengths:** ${matched.join(', ') || 'General engineering alignment'}\n${missing.length > 0 ? `⚠️ **Keywords to Highlight:** ${missing.join(', ')}\n` : ''}💡 **Recommendation:** ${report.actionableTip}`,
        actionType: 'job_fit',
        fitReport: report,
        quickOptions: ['Generate Cover Letter', 'Draft Tailored Recruiter Pitch', 'Audit My Profile'],
      };
    }

    const systemPrompt = `You are an expert AI Career Copilot and Senior Technical Recruiter.
Analyze how well the candidate fits the job description from the currently active web page.
Language Instruction: ${userLang === 'hinglish' ? 'Respond in friendly, professional Hinglish.' : 'Respond in clean, professional English.'}
Return ONLY a valid JSON object matching this schema:
{
  "matchScore": number (0 to 100),
  "verdict": "STRONG_MATCH" | "MODERATE_MATCH" | "LOW_FIT",
  "matchingSkills": string[],
  "missingSkills": string[],
  "summary": string (2-3 concise sentences explaining strengths and gaps in ${userLang === 'hinglish' ? 'Hinglish' : 'English'}),
  "actionableTip": string (1 punchy suggestion to boost hiring chances in ${userLang === 'hinglish' ? 'Hinglish' : 'English'})
}`;

    const userPrompt = `=== CANDIDATE PROFILE ===
Title: ${brain.currentTitle}
Years of Experience: ${brain.yearsOfExperience}
Skills: ${(brain.skills || []).join(', ')}
Narrative: ${brain.backgroundNarrative}
Location: ${brain.currentLocation}
Preferred Locations: ${(brain.preferredLocations || []).join(', ')}

=== JOB DESCRIPTION (Active Tab) ===
Title: ${jobTitle}
URL: ${activeTab?.url || ''}
Content: ${jobText.slice(0, 3000)}`;

    try {
      const response = await llm.invoke([new SystemMessage(systemPrompt), new HumanMessage(userPrompt)]);
      const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const cleaned = content
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
      const report: CopilotFitReport = JSON.parse(cleaned);

      const verdictEmoji = report.matchScore >= 80 ? '🔥' : report.matchScore >= 60 ? '⚡' : '⚠️';

      const reply = `### ${verdictEmoji} Job Fit Report: **${report.matchScore}% Match**
**Job:** ${jobTitle.slice(0, 60)}

✅ **Strong Matches:** ${report.matchingSkills.join(', ') || 'Core role alignment'}
${report.missingSkills.length > 0 ? `⚠️ **Missing / Gaps:** ${report.missingSkills.join(', ')}\n` : ''}
💡 **Summary:** ${report.summary}

🎯 **Recommendation:** ${report.actionableTip}`;

      return {
        reply,
        actionType: 'job_fit',
        fitReport: report,
        quickOptions: ['Generate Cover Letter', 'Draft Tailored Recruiter Pitch', 'Audit My Profile'],
      };
    } catch (err) {
      logger.error('Job fit analysis error:', err);
      return {
        reply:
          userLang === 'hinglish'
            ? `⚠️ Analysis me thoda error aaya, lekin aapke core skills (${(brain.skills || []).slice(0, 4).join(', ')}) is role ke sath achhe lag rahe hain!`
            : `⚠️ Minor analysis error occurred, but your core skills (${(brain.skills || []).slice(0, 4).join(', ')}) align well with this position!`,
        actionType: 'job_fit',
      };
    }
  }

  /**
   * Conducts mock screening interview.
   */
  private async conductMockInterview(
    brain: ICareerBrain,
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userLang: 'hinglish' | 'english' = 'english',
  ): Promise<CopilotChatResponse> {
    const isFirstQuestion = !history.some(h => h.content.toLowerCase().includes('mock interview'));
    const llm = await getActiveChatModel();

    if (isFirstQuestion || !llm) {
      return {
        reply:
          userLang === 'hinglish'
            ? `🎙️ **Mock Screening Interview Started!**\n\nMain aapka hiring manager ban kar interview le raha hoon. Pehla sawal:\n\n👉 *"Can you walk me through your most challenging recent project, the architecture decisions you took, and what you would do differently today?"*\n\nAapka answer sunne ke baad main feedback aur tips dunga. Go ahead!`
            : `🎙️ **Mock Screening Interview Started!**\n\nI will act as your hiring manager for a ${brain.currentTitle || 'Software Engineer'} role. Here is your first question:\n\n👉 *"Can you walk me through your most challenging recent project, the architecture decisions you took, and what you would do differently today?"*\n\nProvide your response below, and I will give you immediate feedback and suggestions. Good luck!`,
        actionType: 'interview',
        quickOptions: ['Give me a hint', 'Next Question', 'Exit Interview'],
      };
    }

    const prompt = `You are a supportive, sharp Senior Tech Recruiter.
Review the candidate's interview response: "${userMessage}".
Language Instruction: ${userLang === 'hinglish' ? 'Respond in friendly, professional Hinglish.' : 'Respond in clean, professional English.'}
Give:
1. 1-line praise on what was strong.
2. 1-line actionable tip to make the answer more impressive to top tier companies.
3. Ask the next screening question for a ${brain.currentTitle || 'Full Stack'} role.`;

    try {
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const reply = typeof response.content === 'string' ? response.content.trim() : String(response.content);
      return {
        reply,
        actionType: 'interview',
        quickOptions: ['Next Question', 'Audit My Profile', 'Exit Interview'],
      };
    } catch {
      return {
        reply: `Great answer! Good focus on problem-solving. Next question: *"How do you handle production bugs or critical latency spikes in high-traffic APIs?"*`,
        actionType: 'interview',
      };
    }
  }

  /**
   * Handles conversational profile updates, auto-filling missing fields, and answering user queries.
   */
  private async handleConversationalFillOrQA(
    brain: ICareerBrain,
    audit: ProfileAuditResult,
    userMessage: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    userLang: 'hinglish' | 'english' = 'english',
    activeTab?: { url?: string; title?: string; pageText?: string },
  ): Promise<CopilotChatResponse> {
    const qLower = userMessage.toLowerCase().trim();

    // ─── Direct Regex Pattern Extraction (Guaranteed Instant Auto-Fill) ───
    const patternUpdates: Partial<ICareerBrain> = {};
    const updatedCardItems: Array<{ field: string; label: string; value: any }> = [];

    // Notice Period pattern: e.g. "15 days", "30 days", "immediate", "serving notice", "15 din"
    const noticeMatch = userMessage.match(
      /(?:notice(?:\s*period)?(?:\s*is)?\s*[:=]?\s*)?(\b\d+\s*(?:days?|months?|din)\b|immediate|serving\s*notice)/i,
    );
    if (noticeMatch) {
      const val = noticeMatch[1].trim();
      patternUpdates.noticePeriod = val;
      updatedCardItems.push({ field: 'noticePeriod', label: 'Notice Period', value: val });
    }

    // Expected CTC pattern: e.g. "15 LPA", "12 Lakhs", "800000"
    const ctcMatch = userMessage.match(
      /(?:(?:expected\s*)?ctc|salary|package)(?:\s*is)?\s*[:=]?\s*([₹$]?\s*[\d.]+\s*(?:lpa|lakhs?|cr|k)?|\d{5,})/i,
    );
    if (ctcMatch) {
      const val = ctcMatch[1].trim();
      patternUpdates.expectedCTC = val;
      patternUpdates.salaryExpectation = val;
      updatedCardItems.push({ field: 'expectedCTC', label: 'Expected CTC', value: val });
    }

    // Location pattern: e.g. "in Delhi", "location is Pune", "live in Bengaluru"
    const locMatch = userMessage.match(
      /(?:location|city|live\s*in|based\s*in)(?:\s*is)?\s*[:=]?\s*([a-zA-Z\s]+(?:,\s*[a-zA-Z\s]+)*)/i,
    );
    if (locMatch && !locMatch[1].toLowerCase().includes('notice') && !locMatch[1].toLowerCase().includes('skill')) {
      const stdLoc = standardizeLocationString(locMatch[1].trim());
      if (stdLoc) {
        patternUpdates.currentLocation = cleanLocationForCityField(stdLoc) || stdLoc;
        updatedCardItems.push({
          field: 'currentLocation',
          label: 'Current Location',
          value: patternUpdates.currentLocation,
        });
      }
    }

    // Add Skills pattern: e.g. "add React, Node", "skills are Python, AWS"
    const skillsMatch = userMessage.match(/(?:add\s*skills?|skills?\s*(?:are|is)?)\s*[:=]?\s*([a-zA-Z0-9+#.\s,/-]+)/i);
    if (skillsMatch) {
      const newSkillsRaw = skillsMatch[1]
        .split(/[,/|]+/)
        .map(s => s.trim())
        .filter(Boolean);
      const existing = brain.skills || [];
      const combined = Array.from(new Set([...existing, ...newSkillsRaw]));
      patternUpdates.skills = combined;
      updatedCardItems.push({ field: 'skills', label: 'Technical Skills', value: combined.join(', ') });
    }

    // GitHub pattern: e.g. "https://github.com/..."
    const gitMatch = userMessage.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+/i);
    if (gitMatch) {
      patternUpdates.githubUrl = gitMatch[0];
      updatedCardItems.push({ field: 'githubUrl', label: 'GitHub URL', value: gitMatch[0] });
    }

    // If patterns matched and we updated the profile:
    if (Object.keys(patternUpdates).length > 0) {
      await careerBrainStore.updateCareerBrain(patternUpdates);
      const newBrain = await careerBrainStore.getCareerBrain();
      const newAudit = auditCareerBrain(newBrain);
      const nextQ = newAudit.missingFields[0];

      const successReply =
        userLang === 'hinglish'
          ? `✅ **Profile Details Update Ho Gayi Hain!**\n\nNaya Profile Strength: **${newAudit.score}%**.\n\n${nextQ ? `👉 **${nextQ.promptQuestion}**` : '🎉 Aapka profile 100% complete ho chuka hai!'}`
          : `✅ **Profile Successfully Updated!**\n\nNew Profile Readiness: **${newAudit.score}%**.\n\n${nextQ ? `👉 **${nextQ.promptQuestion}**` : '🎉 Your profile is now 100% complete!'}`;

      return {
        reply: successReply,
        actionType: 'update',
        profileCompleteness: newAudit.score,
        updatedFields: updatedCardItems,
        quickOptions: nextQ?.quickOptions || [
          'Show My Profile',
          'Generate Cover Letter',
          'Check Fit for Open Job Page',
        ],
      };
    }

    // ─── LLM Conversational Processing ───
    const llm = await getActiveChatModel();
    if (llm) {
      const systemPrompt = `You are an expert AI Career Copilot for a candidate using a job automation extension.
CANDIDATE CAREER BRAIN:
- Full Name: "${brain.fullName}"
- Current Title: "${brain.currentTitle}"
- Experience: ${brain.yearsOfExperience} years
- Current Location: "${brain.currentLocation || 'Not set'}"
- Preferred Locations: ${JSON.stringify(brain.preferredLocations || [])}
- Notice Period: "${brain.noticePeriod || 'Not set'}"
- Expected CTC: "${brain.expectedCTC || 'Not set'}"
- Skills: ${JSON.stringify(brain.skills || [])}
- GitHub: "${brain.githubUrl || 'Not set'}"

LANGUAGE INSTRUCTION:
By default, reply in clean, professional English. ONLY if the user explicitly writes in Hinglish, reply in friendly Hinglish.

TASK:
1. If the user is providing any profile detail or answering a question (e.g. location, notice period, skill, salary, title):
   Extract it into JSON.
2. If the user is asking career/job questions (e.g. "how do I prepare for technical interviews?", "what projects should I build?"):
   Answer with practical, high-value technical advice tailored to their stack (${(brain.skills || []).slice(0, 5).join(', ')}).

OUTPUT STRICTLY VALID JSON:
{
  "isProfileUpdate": boolean,
  "updates": {
    "noticePeriod"?: string,
    "currentLocation"?: string,
    "preferredLocation"?: string,
    "preferredLocations"?: string[],
    "expectedCTC"?: string,
    "githubUrl"?: string,
    "currentTitle"?: string,
    "fullName"?: string,
    "skills"?: string[]
  },
  "naturalReply": string
}`;

      try {
        const lastAssistant = [...history].reverse().find(h => h.role === 'assistant')?.content || '';
        const response = await llm.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(`Last Assistant Message: "${lastAssistant}"\nUser Message: "${userMessage}"`),
        ]);

        const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
        const clean = raw.replace(/```json\s*|```\s*/gi, '').trim();
        const parsed = JSON.parse(clean);

        if (parsed.isProfileUpdate && parsed.updates && Object.keys(parsed.updates).length > 0) {
          await careerBrainStore.updateCareerBrain(parsed.updates);
          const newBrain = await careerBrainStore.getCareerBrain();
          const newAudit = auditCareerBrain(newBrain);
          const nextQ = newAudit.missingFields[0];

          return {
            reply:
              parsed.naturalReply ||
              (userLang === 'hinglish' ? `✅ Profile update save ho gaya!` : `✅ Profile successfully updated!`),
            actionType: 'update',
            profileCompleteness: newAudit.score,
            quickOptions: nextQ?.quickOptions || ['Show My Profile', 'Generate Cover Letter'],
          };
        }

        if (parsed.naturalReply) {
          return {
            reply: parsed.naturalReply,
            actionType: 'general',
            profileCompleteness: audit.score,
            quickOptions: ['Audit My Profile', 'Generate Cover Letter', 'Check Fit for Open Job Page'],
          };
        }
      } catch (err) {
        logger.warning('LLM conversational error, providing smart guidance:', err);
      }
    }

    // ─── Intelligent Contextual Fallback Response ───
    const nextQ = audit.missingFields[0];

    return {
      reply:
        userLang === 'hinglish'
          ? `Main aapka **AI Career Copilot** hoon. Aap mujhse pooch sakte hain:\n- *"Mera profile dikhao"* (Saved details & skills dekhne ke liye)\n- *"Cover letter generate karo"* (Is job ke liye customized letter)\n- *"Check fit for open job"* (Active tab JD match analysis)\n- *"Mere profile me kya missing hai?"*\n\n${nextQ ? `👉 **Next Step:** ${nextQ.promptQuestion}` : ''}`
          : `I am your **AI Career Copilot**. I can help you with:\n- *"Show my profile"* (Review all your saved skills, experience & preferences)\n- *"Generate cover letter"* (Tailored 3-paragraph letter for open jobs)\n- *"Check fit for open job page"* (Live match score & keyword analysis)\n- *"Audit my profile"* (Fill remaining screening questions)\n\n${nextQ ? `👉 **Next Step:** ${nextQ.promptQuestion}` : ''}`,
      actionType: 'general',
      profileCompleteness: audit.score,
      quickOptions: nextQ
        ? nextQ.quickOptions
        : ['Show My Profile', 'Generate Cover Letter', 'Check Fit for Open Job Page'],
    };
  }
}

export const careerCopilotEngine = new CareerCopilotEngine();
