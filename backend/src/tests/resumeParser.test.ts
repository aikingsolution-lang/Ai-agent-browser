import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { setupTestDatabase, type TestDbInstance } from './setupTestDb.js';
import { LlmProviderFactory } from '../services/llm/llmProviderFactory.js';
import { ResumeParserService } from '../services/resumeParser.service.js';
import { CareerBrain } from '../models/careerBrain.model.js';

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
});
