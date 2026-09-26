import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { ResumeParserService } from '../services/resumeParser.service.js';
import { CareerBrain } from '../models/careerBrain.model.js';
import { cleanLocationForCityField } from '../utils/skillValidator.js';

const app = createApp();
let testDb: TestDbInstance;

describe('Phase 1: Resume Parsing & Career Brain Intelligence Tests', () => {
  beforeAll(async () => {
    testDb = await setupTestDatabase();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    LlmProviderFactory.reset();
    await testDb.clearCollections();
  });

  async function registerUser(emailPrefix: string) {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: `${emailPrefix} Developer`,
        email: `${emailPrefix}@resumetest.com`,
        password: 'Password123!',
      });
    return {
      token: res.body.data.token,
      userId: res.body.data.user._id || res.body.data.user.id,
    };
  }

  it('1. Extracts structured data and strips markdown blocks returned by Bedrock LLM', async () => {
    const mockJsonOutput = `\`\`\`json
{
  "fullName": "Alice Smith",
  "email": "alice.smith@example.com",
  "phoneNumber": "+1-555-0199",
  "currentTitle": "Senior Full Stack Engineer",
  "skills": ["TypeScript", "React", "Node.js", "MongoDB", "AWS", "Docker"],
  "yearsOfExperience": 5,
  "education": "B.S. in Software Engineering, Stanford University",
  "workHistory": [
    {
      "role": "Lead Frontend Engineer",
      "company": "Tech Innovations Inc",
      "duration": "2021 - Present",
      "highlights": ["Architected microfrontends", "Improved page load by 40%"]
    }
  ],
  "backgroundNarrative": "Accomplished software engineer with 5 years building scalable web architectures.",
  "preferredLocation": "Bengaluru, India",
  "workAuthorization": "Authorized to work without sponsorship",
  "salaryExpectation": "Competitive",
  "portfolioUrl": "https://alicesmith.dev",
  "githubUrl": "https://github.com/alicesmith",
  "linkedinUrl": "https://linkedin.com/in/alicesmith"
}
\`\`\``;

    // Configure mock LLM to return markdown-wrapped JSON (replicating Bedrock behavior)
    LlmProviderFactory.setMockOptions({
      mockResponseText: mockJsonOutput,
    });

    const sampleRawText = `Alice Smith
alice.smith@example.com | +1-555-0199
Senior Full Stack Engineer
Skills: TypeScript, React, Node.js, MongoDB, AWS
Stanford University - B.S. in Software Engineering`;

    const parsed = await ResumeParserService.extractStructuredData(sampleRawText);

    expect(parsed.fullName).toBe('Alice Smith');
    expect(parsed.email).toBe('alice.smith@example.com');
    expect(parsed.currentTitle).toBe('Senior Full Stack Engineer');
    expect(parsed.skills).toContain('TypeScript');
    expect(parsed.skills).toContain('React');
    expect(parsed.yearsOfExperience).toBe(5);
    expect(parsed.workHistory).toHaveLength(1);
    expect(parsed.workHistory[0].company).toBe('Tech Innovations Inc');
    expect(parsed.githubUrl).toBe('https://github.com/alicesmith');
  });

  it('2. Falls back safely to regex & keyword extraction if LLM fails or returns non-JSON', async () => {
    LlmProviderFactory.setMockOptions({
      mockResponseText: 'I cannot parse this resume due to internal policy.',
    });

    const sampleText = `Bob Johnson
bob.johnson@example.com
Phone: 555-234-5678
Software Developer with experience in React, Python, Docker, and PostgreSQL.
GitHub: https://github.com/bobjohnson`;

    const fallbackResult = await ResumeParserService.extractStructuredData(sampleText);

    expect(fallbackResult.fullName).toBe('Bob Johnson');
    expect(fallbackResult.email).toBe('bob.johnson@example.com');
    expect(fallbackResult.skills).toContain('React');
    expect(fallbackResult.skills).toContain('Python');
    expect(fallbackResult.githubUrl).toBe('https://github.com/bobjohnson');
  });

  it('3. POST /api/v1/resume/upload-and-parse rejects requests without authentication', async () => {
    const res = await request(app)
      .post('/api/v1/resume/upload-and-parse')
      .attach('resume', Buffer.from('Mock resume content text here...'), 'resume.txt');

    expect(res.status).toBe(401);
  });

  it('4. POST /api/v1/resume/upload-and-parse rejects requests without file', async () => {
    const { token } = await registerUser('nofile');

    const res = await request(app).post('/api/v1/resume/upload-and-parse').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('5. POST /api/v1/resume/upload-and-parse successfully parses file and updates CareerBrain in MongoDB', async () => {
    const { token, userId } = await registerUser('carol');

    const mockAiJson = JSON.stringify({
      fullName: 'Carol Danvers',
      email: 'carol@marvel.com',
      phoneNumber: '+91-9876543210',
      currentTitle: 'Staff AI Engineer',
      skills: ['Python', 'TypeScript', 'LangChain', 'AWS Bedrock', 'React'],
      yearsOfExperience: 6,
      education: 'M.S. in Computer Science',
      workHistory: [
        {
          role: 'Staff Engineer',
          company: 'Avengers Tech',
          duration: '2020 - Present',
          highlights: ['Designed agentic workflows'],
        },
      ],
      backgroundNarrative: 'Staff engineer specialized in autonomous browser agents and LLM gateways.',
      preferredLocation: 'Remote',
      workAuthorization: 'Authorized to work without sponsorship',
      salaryExpectation: '$180,000',
      portfolioUrl: 'https://carol.dev',
      githubUrl: 'https://github.com/carol',
      linkedinUrl: 'https://linkedin.com/in/carol',
    });

    LlmProviderFactory.setMockOptions({
      mockResponseText: mockAiJson,
    });

    const fileBuffer = Buffer.from(`Carol Danvers\ncarol@marvel.com\nStaff AI Engineer with 6 years experience.`);

    const res = await request(app)
      .post('/api/v1/resume/upload-and-parse')
      .set('Authorization', `Bearer ${token}`)
      .attach('resume', fileBuffer, 'carol_resume.doc');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fileName).toBe('carol_resume.doc');
    expect(res.body.data.parsedData.fullName).toBe('Carol Danvers');
    expect(res.body.data.parsedData.skills).toContain('AWS Bedrock');

    // Verify MongoDB persistence
    const savedCareerBrain = await CareerBrain.findOne({ userId });
    expect(savedCareerBrain).not.toBeNull();
    expect(savedCareerBrain?.fullName).toBe('Carol Danvers');
    expect(savedCareerBrain?.currentTitle).toBe('Staff AI Engineer');
    expect(savedCareerBrain?.skills).toContain('AWS Bedrock');
    expect(savedCareerBrain?.workHistory).toHaveLength(1);
    expect(savedCareerBrain?.resumeFileName).toBe('carol_resume.doc');
  });

  it('6. Regression: purges fabricated "5 years" across skills when candidate is an intern with no explicit durations', async () => {
    const exactResumeFixture = `MUBASSHIR ALI
Full Stack MERN Developer | Building Scalable Web Experiences with React, Next.js & Node.js
+91 70031 51313 | mubasshirali0710@gmail.com | Bengaluru, India | LinkedIn | GitHub
PROFESSIONAL SUMMARY
B.Tech Computer Science graduate and full-stack MERN developer with hands-on internship and project experience building responsive, production-grade web applications using React.js, Next.js, Node.js, Express.js, and MongoDB.
EDUCATION
B.Tech, Computer Science & Engineering 2024
Maulana Abul Kalam Azad University of Technology, West Bengal | CGPA: 8.57 / 10
EXPERIENCE
Next.js Developer Intern | AiKing Solutions Aug 2026 – Present
● Owning full-stack development of NanoBrowser SaaS, a subscription-based AI browser-automation Chrome extension built on an open-source base, architecting the backend with Node.js, TypeScript, Express.js, and MongoDB.
PROJECTS
AI Refund Support Agent | Next.js 15, React 19, Node.js, Express.js, Groq LLM Github
AttendPro – Smart Attendance Management System | React.js, Node.js, Express.js, MongoDB, JWT Github
AI-Based Diabetes Prediction System | Python, Scikit-learn, Flask, Render Github
TECHNICAL SKILLS
Languages: JavaScript (ES6+), TypeScript, Python, C++, SQL
Frontend: React.js, Next.js, Redux Toolkit, Tailwind CSS, HTML5, CSS3
Backend: Node.js, Express.js, REST APIs, JWT Authentication, MVC Architecture
Database: MongoDB, MongoDB Atlas, MySQL, PostgreSQL
Cloud, Payments & Tools: AWS Bedrock, Razorpay, Vercel, Render, Netlify, Git, GitHub, Postman
Machine Learning: Scikit-learn, Pandas, NumPy, Flask, Model Training & Evaluation`;

    const hallucinatedSkillExperience: Record<string, number> = {
      C: 5,
      CSS3: 5,
      'Express.js': 5,
      Flask: 5,
      Git: 5,
      GitHub: 5,
      HTML5: 5,
      'JWT Authentication': 5,
      JavaScript: 5,
      MongoDB: 5,
      MySQL: 5,
      Netlify: 5,
      'Node.js': 5,
      NumPy: 5,
      Pandas: 5,
      Postman: 5,
      Python: 5,
      'REST APIs': 5,
      'React.js': 5,
      'Redux Toolkit': 5,
      Render: 5,
      SQL: 5,
      'Scikit-learn': 5,
      'Tailwind CSS': 5,
      TypeScript: 5,
      Vercel: 5,
    };

    LlmProviderFactory.setMockOptions({
      mockResponseText: JSON.stringify({
        fullName: 'Mubasshir Ali',
        email: 'mubasshirali0710@gmail.com',
        currentTitle: 'Full Stack MERN Developer',
        skills: Object.keys(hallucinatedSkillExperience),
        yearsOfExperience: 0,
        hasWorkExperience: true,
        workExperience: [
          {
            company: 'AiKing Solutions',
            title: 'Next.js Developer Intern',
            startMonth: 'Aug',
            startYear: '2026',
            endMonth: null,
            endYear: null,
            isCurrent: true,
            description: 'Owning full-stack development of NanoBrowser SaaS...',
          },
        ],
        skillExperience: hallucinatedSkillExperience,
      }),
    });

    const parsed = await ResumeParserService.extractStructuredData(exactResumeFixture);

    // Assert that NO skill receives the fabricated "5"
    const remainingExp = parsed.skillExperience || {};
    for (const [skill, yrs] of Object.entries(remainingExp)) {
      expect(yrs).not.toBe(5);
    }

    // Assert ungrounded skills without explicit duration are completely omitted
    expect(remainingExp['NumPy']).toBeUndefined();
    expect(remainingExp['SQL']).toBeUndefined();
    expect(remainingExp['Scikit-learn']).toBeUndefined();
    expect(remainingExp['Pandas']).toBeUndefined();
    expect(remainingExp['React.js']).toBeUndefined();
  });

  it('7. Cleans location fields stripping "or Remote" / "Remote /" / "(Remote)" suffixes', () => {
    expect(cleanLocationForCityField('Bengaluru, India or Remote')).toBe('Bengaluru, India');
    expect(cleanLocationForCityField('Bengaluru (Remote)')).toBe('Bengaluru');
    expect(cleanLocationForCityField('Remote, Bengaluru')).toBe('Bengaluru');
    expect(cleanLocationForCityField('San Francisco, CA / Remote')).toBe('San Francisco, CA');
    expect(cleanLocationForCityField('Greater Bengaluru Area')).toBe('Greater Bengaluru Area');
    expect(cleanLocationForCityField('Remote')).toBe('');
  });
});
