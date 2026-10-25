import { describe, it, expect } from 'vitest';
import type { ICareerBrain } from '@extension/storage';
import {
  matchRuleBased,
  matchDateOption,
  extractWorkHistoryDates,
  type FormFieldDescriptor,
} from '../linkedin/formQuestionResolver';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const YEARS = ['2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'];

function makeBrain(overrides: Partial<ICareerBrain> = {}): ICareerBrain {
  return {
    fullName: 'Test Candidate',
    email: 'test@example.com',
    phoneNumber: '+91 9876543210',
    currentTitle: 'Full Stack Developer',
    yearsOfExperience: 3,
    currentLocation: 'Bengaluru, Karnataka, India',
    skills: ['JavaScript'],
    skillExperience: {},
    goldenAnswers: [],
    customAnswers: {},
    workExperience: [
      {
        id: 'w1',
        title: 'Senior Software Engineer',
        company: 'Acme Corp',
        startMonth: 'March',
        startYear: '2021',
        endMonth: 'June',
        endYear: '2024',
        isCurrent: false,
        description: 'Built and shipped web applications.',
      },
    ],
    ...overrides,
  } as ICareerBrain;
}

function dateField(label: string, kind: 'month' | 'year'): FormFieldDescriptor {
  return {
    label,
    fieldType: 'dropdown',
    options: kind === 'month' ? MONTHS : YEARS,
  };
}

describe('LinkedIn work-experience sub-form (Month/Year date selects)', () => {
  const brain = makeBrain();

  it('fills "From Month" from the primary role start month', () => {
    const res = matchRuleBased(dateField('From Month', 'month'), brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('March');
  });

  it('fills "From Year" from the primary role start year', () => {
    const res = matchRuleBased(dateField('From Year', 'year'), brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('2021');
  });

  it('fills "To Month" from the primary role end month', () => {
    const res = matchRuleBased(dateField('To Month', 'month'), brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('June');
  });

  it('fills "To Year" from the primary role end year', () => {
    const res = matchRuleBased(dateField('To Year', 'year'), brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('2024');
  });

  it('tolerates required markers and (required) suffixes on date labels', () => {
    expect(matchRuleBased(dateField('From Month *', 'month'), brain).answer).toBe('March');
    expect(matchRuleBased(dateField('To Year (required)', 'year'), brain).answer).toBe('2024');
  });

  it('never feeds a year into a month select or a month into a year select', () => {
    expect(matchDateOption(dateField('From Month', 'month'), '2021', 'month')).toBeNull();
    expect(matchDateOption(dateField('From Year', 'year'), 'March', 'year')).toBeNull();
  });

  it('maps a month number onto the available month names', () => {
    const numericOptions = ['01', '02', '03', '04'];
    expect(
      matchDateOption({ label: 'From Month', fieldType: 'dropdown', options: numericOptions }, 'March', 'month'),
    ).toBe('03');
  });

  it('uses the current month/year for the end date of a current role', () => {
    const currentBrain = makeBrain({
      workExperience: [
        {
          id: 'w2',
          title: 'Developer',
          company: 'Present Co',
          startMonth: 'January',
          startYear: '2022',
          endMonth: null,
          endYear: null,
          isCurrent: true,
          description: '',
          source: 'manual',
        },
      ],
    });
    const now = new Date();
    const dates = extractWorkHistoryDates(currentBrain);
    expect(dates.isCurrentRole).toBe(true);
    expect(dates.endYear).toBe(String(now.getFullYear()));
    expect(dates.startYear).toBe('2022');
  });
});

describe('LinkedIn work-experience sub-form (text fields)', () => {
  const brain = makeBrain();

  it('fills Position from the primary role title', () => {
    const res = matchRuleBased({ label: 'Position', fieldType: 'text' }, brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('Senior Software Engineer');
  });

  it('fills Company from the primary role company', () => {
    const res = matchRuleBased({ label: 'Company', fieldType: 'text' }, brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('Acme Corp');
  });

  it('fills Description from the primary role description', () => {
    const res = matchRuleBased({ label: 'Description', fieldType: 'text', isTextArea: true }, brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('Built and shipped web applications.');
  });

  it('fills City from the candidate location', () => {
    const res = matchRuleBased({ label: 'City', fieldType: 'text' }, brain);
    expect(res.matched).toBe(true);
    expect(res.answer).toBe('Bengaluru');
  });
});
