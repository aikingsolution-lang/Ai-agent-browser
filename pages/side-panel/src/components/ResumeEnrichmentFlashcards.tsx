import React, { useState } from 'react';
import type { ICareerBrain } from '@extension/storage';
import {
  FiCheckCircle,
  FiChevronRight,
  FiChevronLeft,
  FiZap,
  FiAward,
  FiHelpCircle,
  FiX,
  FiPlus,
  FiMinus,
  FiDollarSign,
  FiClock,
  FiMapPin,
  FiShield,
  FiCalendar,
  FiUser,
  FiBookOpen,
} from 'react-icons/fi';
import { LocationAutocompleteInput } from './LocationAutocompleteInput';
import { SkillAutocompleteInput } from './SkillAutocompleteInput';

interface ResumeEnrichmentFlashcardsProps {
  isOpen: boolean;
  onClose: () => void;
  profile: ICareerBrain;
  onSave: (updatedProfile: Partial<ICareerBrain>) => Promise<void>;
  isDarkMode?: boolean;
}

/**
 * STRICT SYSTEM COLOR LOGIC RULES:
 * 🟢 GREEN: Dates, Timelines, Joining Availability (DOB, Notice Period)
 * 🔵 BLUE / DARK BLUE: Meaning, Definitions, Identity, Titles (Gender, City, Work Auth, Degree)
 * 🟡 YELLOW / GOLD: Numbers, CTC, Salary, Calculations, Experience Counters (CTC, YOE)
 * ⚪ SLATE / BLACK: High contrast canvas, deep focus container cards
 */
export const ResumeEnrichmentFlashcards: React.FC<ResumeEnrichmentFlashcardsProps> = ({
  isOpen,
  onClose,
  profile,
  onSave,
  isDarkMode = true,
}) => {
  if (!isOpen) return null;

  // Flashcard steps:
  // Step 0: Welcome & Scan Overview
  // Step 1: Personal & Date Update (Gender, DOB, Education)
  // Step 2: Salary, Availability & Work Location (CTC, Notice Period, Cities, Relocation)
  // Step 3: Skill Experience Matrix (Years of experience in each project / internship skill)
  // Step 4: Success & Profile Update Complete
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);

  // Form State: Personal & Dates (Step 1)
  const [gender, setGender] = useState(profile.gender || 'Male');
  const [dateOfBirth, setDateOfBirth] = useState(profile.dateOfBirth || '');
  const [highestEducation, setHighestEducation] = useState(profile.highestEducation || "Bachelor's Degree");
  const [willingToRelocate, setWillingToRelocate] = useState(profile.willingToRelocate || 'Yes');

  // Form State: Compensation & Locations (Step 2)
  const [noticePeriod, setNoticePeriod] = useState(profile.noticePeriod || 'Immediate');
  const [currentCTC, setCurrentCTC] = useState(profile.currentCTC || '');
  const [expectedCTC, setExpectedCTC] = useState(profile.expectedCTC || profile.salaryExpectation || '');
  const [currentLocation, setCurrentLocation] = useState(profile.currentLocation || '');
  const [preferredLocation, setPreferredLocation] = useState(profile.preferredLocation || '');
  const [workAuth, setWorkAuth] = useState(
    profile.workAuthorization || 'Citizen of India / Authorized to work without sponsorship',
  );

  // Form State: Skills Matrix (Step 3)
  const initialSkillExp = { ...(profile.skillExperience || {}) };
  const allSkills = Array.from(
    new Set([...(profile.skills || []), ...(profile.autoExtractedSkills || []), ...Object.keys(initialSkillExp)]),
  ).filter(Boolean);

  const [skillsMap, setSkillsMap] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = { ...initialSkillExp };
    const defaultYrs = Math.max(1, profile.yearsOfExperience || 1);
    for (const s of allSkills) {
      if (map[s] === undefined || map[s] <= 0) {
        map[s] = defaultYrs;
      }
    }
    return map;
  });

  const [newSkillInput, setNewSkillInput] = useState('');
  const [stepError, setStepError] = useState<string>('');

  // Validation Rules:
  // Step 1 Mandatory: dateOfBirth, gender, highestEducation
  const isStep1Valid = Boolean(dateOfBirth && dateOfBirth.trim() && gender && highestEducation);

  // Step 2 Mandatory: currentCTC, expectedCTC, currentLocation
  const isStep2Valid = Boolean(
    currentCTC && currentCTC.trim() && expectedCTC && expectedCTC.trim() && currentLocation && currentLocation.trim(),
  );

  const handleStep1Next = () => {
    if (!dateOfBirth || !dateOfBirth.trim()) {
      setStepError('Please enter your Date of Birth before proceeding.');
      return;
    }
    setStepError('');
    setCurrentStep(2);
  };

  const handleStep2Next = () => {
    if (!currentCTC || !currentCTC.trim()) {
      setStepError('Please enter your Current CTC (e.g. 6 or 0 for freshers).');
      return;
    }
    if (!expectedCTC || !expectedCTC.trim()) {
      setStepError('Please enter your Expected CTC.');
      return;
    }
    if (!currentLocation || !currentLocation.trim()) {
      setStepError('Please select your Current City.');
      return;
    }
    setStepError('');
    setCurrentStep(3);
  };

  const updateSkillYears = (skillName: string, delta: number) => {
    setSkillsMap(prev => {
      const current = prev[skillName] || 0;
      const nextVal = Math.max(0, Math.min(30, current + delta));
      return { ...prev, [skillName]: nextVal };
    });
  };

  const handleAddNewSkill = () => {
    const trimmed = newSkillInput.trim();
    if (!trimmed) return;
    setSkillsMap(prev => ({
      ...prev,
      [trimmed]: Math.max(1, profile.yearsOfExperience || 1),
    }));
    setNewSkillInput('');
  };

  const handleFinalSubmit = async () => {
    setIsSaving(true);
    try {
      const updatedSkillsList = Array.from(new Set([...Object.keys(skillsMap), ...(profile.skills || [])]));

      const updates: Partial<ICareerBrain> = {
        gender: gender.trim(),
        dateOfBirth: dateOfBirth.trim(),
        highestEducation: highestEducation.trim(),
        willingToRelocate: willingToRelocate.trim(),
        noticePeriod: noticePeriod.trim() || 'Immediate',
        currentCTC: currentCTC.trim(),
        expectedCTC: expectedCTC.trim(),
        currentLocation: currentLocation.trim(),
        preferredLocation: preferredLocation.trim(),
        workAuthorization: workAuth.trim(),
        skillExperience: skillsMap,
        skills: updatedSkillsList,
        autoExtractedSkills: updatedSkillsList,
      };

      await onSave(updates);
      setCurrentStep(4); // Advance to completion state
    } catch (err) {
      console.error('[Flashcards] Failed to save profile updates:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 font-sans backdrop-blur-sm">
      <div className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-2xl shadow-sky-950/40 transition-all duration-300">
        {/* Header Bar */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/95 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg border border-blue-700/50 bg-blue-950/80 p-1.5 text-blue-400">
              <FiZap className="size-4" />
            </div>
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold tracking-wide text-white">
                <span>AI Career Profile Quick Update</span>
              </h3>
              <p className="text-[11px] text-slate-400">Step {currentStep + 1} of 5 • Structured Onboarding</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white">
            <FiX className="size-4" />
          </button>
        </div>

        {/* Progress Bar (System Colored) */}
        <div className="h-1 w-full bg-slate-900">
          <div
            className="h-1 bg-blue-500 transition-all duration-300"
            style={{ width: `${((currentStep + 1) / 5) * 100}%` }}
          />
        </div>

        {/* Card Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* STEP 0: WELCOME & RESUME SCAN OVERVIEW */}
          {currentStep === 0 && (
            <div className="animate-fade-in space-y-4 py-2 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-blue-500/30 bg-slate-900 text-blue-400 shadow-lg">
                <FiAward className="size-7" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-white">Resume Analysis Complete</h4>
                <p className="mx-auto max-w-sm text-xs leading-relaxed text-slate-400">
                  We scanned your resume and projects. Let’s update your key personal profile fields and skill
                  experience so recruiter screening popups on Naukri, LinkedIn and Indeed are filled without getting
                  stuck.
                </p>
              </div>

              {/* Color Code Legend Banner */}
              <div className="flex items-center justify-center gap-4 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[10px] text-slate-300">
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="inline-block size-2 rounded-full bg-emerald-500" /> Dates & Time
                </span>
                <span className="flex items-center gap-1 text-blue-400">
                  <span className="inline-block size-2 rounded-full bg-blue-500" /> Identity & Meaning
                </span>
                <span className="flex items-center gap-1 text-amber-400">
                  <span className="inline-block size-2 rounded-full bg-amber-400" /> CTC & Numbers
                </span>
              </div>

              <div className="space-y-2.5 rounded-xl border border-slate-800 bg-slate-900/90 p-3.5 text-left text-xs shadow-inner">
                <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 text-[11px] font-semibold text-slate-400">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400">DETECTED RESUME PROFILE</span>
                  <span className="font-medium text-emerald-400">Ready</span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 text-[11px]">
                  <div>
                    <span className="block text-[10px] text-slate-400">Candidate Name</span>
                    <span className="font-semibold text-slate-100">{profile.fullName || 'Not specified'}</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Total Work Tenure</span>
                    <span className="font-semibold text-amber-400">{profile.yearsOfExperience || 0} Years</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Extracted Technologies</span>
                    <span className="font-semibold text-blue-400">{allSkills.length} Verified Skills</span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-slate-400">Work Positions</span>
                    <span className="font-semibold text-slate-100">{profile.workExperience?.length || 0} Roles</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 1: IDENTITY & DATES (GENDER, DOB, EDUCATION) */}
          {currentStep === 1 && (
            <div className="animate-fade-in space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-blue-400">
                  <FiUser className="size-3.5 text-blue-400" />
                  <span>Flashcard 1: Personal Identity & Dates</span>
                </h4>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Recruiters on Naukri, Indeed & LinkedIn require these mandatory demographic screening questions.
                </p>
              </div>

              {stepError && (
                <div className="flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-950/80 p-2.5 text-xs text-red-200">
                  <FiX className="size-4 shrink-0 text-red-400" />
                  <span>{stepError}</span>
                </div>
              )}

              <div className="space-y-3.5 text-xs">
                {/* Gender Identity [Rule: Blue/Dark Blue = Identity & Meaning] */}
                <div>
                  <label className="mb-1 block flex items-center justify-between text-[11px] font-medium text-blue-300">
                    <span className="flex items-center gap-1">
                      <FiUser className="size-3 text-blue-400" />
                      <span>Gender Identity</span>
                      <span className="font-bold text-red-400">*</span>
                    </span>
                    <span className="text-[10px] font-normal text-slate-500">Required</span>
                  </label>
                  <select
                    value={gender}
                    onChange={e => {
                      setGender(e.target.value);
                      if (stepError) setStepError('');
                    }}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                  </select>
                </div>

                {/* Date of Birth [Rule: Green = Dates & Timelines] */}
                <div>
                  <label className="mb-1 block flex items-center justify-between text-[11px] font-medium text-emerald-300">
                    <span className="flex items-center gap-1">
                      <FiCalendar className="size-3 text-emerald-400" />
                      <span>Date of Birth</span>
                      <span className="font-bold text-red-400">*</span>
                    </span>
                    <span className="text-[10px] font-medium text-red-400/90">Required</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={dateOfBirth}
                    onChange={e => {
                      setDateOfBirth(e.target.value);
                      if (stepError) setStepError('');
                    }}
                    className={`w-full rounded-xl bg-slate-900 px-3 py-2 text-xs text-white transition-colors focus:outline-none ${
                      !dateOfBirth && stepError
                        ? 'border-2 border-red-500 focus:border-red-400'
                        : 'border border-slate-800 focus:border-emerald-500'
                    }`}
                  />
                  <span className="mt-0.5 block text-[10px] text-slate-500">
                    Used to confirm 18+ age verification and birthday screening fields.
                  </span>
                </div>

                {/* Highest Education Degree [Rule: Blue = Meaning] */}
                <div>
                  <label className="mb-1 block flex items-center gap-1 text-[11px] font-medium text-blue-300">
                    <FiBookOpen className="size-3 text-blue-400" />
                    <span>Highest Completed Education Level</span>
                  </label>
                  <select
                    value={highestEducation}
                    onChange={e => setHighestEducation(e.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
                    <option value="Bachelor's Degree">Bachelor's Degree (B.Tech / B.E / B.Sc / BCA)</option>
                    <option value="Master's Degree">Master's Degree (M.Tech / M.E / M.Sc / MCA)</option>
                    <option value="Doctorate / PhD">Doctorate / PhD</option>
                    <option value="Diploma">Diploma / Associate Degree</option>
                    <option value="High School">High School (12th Grade)</option>
                  </select>
                </div>

                {/* Relocation Willingness [Rule: Blue = Meaning] */}
                <div>
                  <label className="mb-1 block flex items-center gap-1 text-[11px] font-medium text-blue-300">
                    <FiMapPin className="size-3 text-blue-400" />
                    <span>Are you willing to relocate for the job?</span>
                  </label>
                  <select
                    value={willingToRelocate}
                    onChange={e => setWillingToRelocate(e.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
                    <option value="Yes">Yes (Preferred for maximum matches)</option>
                    <option value="No">No (Remote / Current City only)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: SALARY, DATES & LOCATION */}
          {currentStep === 2 && (
            <div className="animate-fade-in space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                  <FiDollarSign className="size-3.5 text-amber-400" />
                  <span>Flashcard 2: CTC, Notice Period & Location</span>
                </h4>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  Job boards use notice period and CTC to screen applicants before forwarding to HR.
                </p>
              </div>

              {stepError && (
                <div className="flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-950/80 p-2.5 text-xs text-red-200">
                  <FiX className="size-4 shrink-0 text-red-400" />
                  <span>{stepError}</span>
                </div>
              )}

              <div className="space-y-3.5 text-xs">
                {/* Notice Period [Rule: Green = Timeline/Dates] */}
                <div>
                  <label className="mb-1 block flex items-center gap-1 text-[11px] font-medium text-emerald-300">
                    <FiClock className="size-3 text-emerald-400" />
                    <span>Notice Period / Availability to Join</span>
                  </label>
                  <select
                    value={noticePeriod}
                    onChange={e => setNoticePeriod(e.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none">
                    <option value="Immediate">Immediate (0 days)</option>
                    <option value="15 Days">15 Days</option>
                    <option value="30 Days">30 Days (1 Month)</option>
                    <option value="60 Days">60 Days (2 Months)</option>
                    <option value="Serving Notice Period">Currently Serving Notice Period</option>
                  </select>
                </div>

                {/* Current & Expected CTC [Rule: Yellow = Numbers, CTC, Equations] */}
                <div className="grid grid-cols-2 gap-3">
                  <div
                    className={`rounded-xl border bg-slate-900 p-2.5 transition-colors ${
                      !currentCTC && stepError ? 'border-red-500/80' : 'border-amber-500/20'
                    }`}>
                    <label className="mb-1 block flex items-center justify-between text-[11px] font-semibold text-amber-400">
                      <span className="flex items-center gap-1">
                        <FiDollarSign className="size-3 text-amber-400" />
                        <span>Current CTC</span>
                        <span className="font-bold text-red-400">*</span>
                      </span>
                      <span className="text-[10px] font-medium text-red-400/90">Required</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 6 LPA (0 if fresher)"
                      value={currentCTC}
                      onChange={e => {
                        setCurrentCTC(e.target.value);
                        if (stepError) setStepError('');
                      }}
                      className="w-full rounded-lg border border-amber-500/30 bg-black px-2.5 py-1.5 font-mono text-xs text-amber-300 focus:border-amber-400 focus:outline-none"
                    />
                  </div>
                  <div
                    className={`rounded-xl border bg-slate-900 p-2.5 transition-colors ${
                      !expectedCTC && stepError ? 'border-red-500/80' : 'border-amber-500/20'
                    }`}>
                    <label className="mb-1 block flex items-center justify-between text-[11px] font-semibold text-amber-400">
                      <span className="flex items-center gap-1">
                        <FiDollarSign className="size-3 text-amber-400" />
                        <span>Expected CTC</span>
                        <span className="font-bold text-red-400">*</span>
                      </span>
                      <span className="text-[10px] font-medium text-red-400/90">Required</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 10 or 12 LPA"
                      value={expectedCTC}
                      onChange={e => {
                        setExpectedCTC(e.target.value);
                        if (stepError) setStepError('');
                      }}
                      className="w-full rounded-lg border border-amber-500/30 bg-black px-2.5 py-1.5 font-mono text-xs text-amber-300 focus:border-amber-400 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Current City & Preferred City [Rule: Blue = Meaning, Standard Autocomplete] */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block flex items-center justify-between text-[11px] font-semibold text-blue-300">
                      <span className="flex items-center gap-1">
                        <FiMapPin className="size-3 text-blue-400" />
                        <span>Current City</span>
                        <span className="font-bold text-red-400">*</span>
                      </span>
                      <span className="text-[10px] font-medium text-red-400/90">Required</span>
                    </label>
                    <LocationAutocompleteInput
                      value={currentLocation}
                      onChange={loc => {
                        setCurrentLocation(loc);
                        if (stepError) setStepError('');
                      }}
                      placeholder="e.g. Kolkata, West Bengal, India"
                      isDarkMode={true}
                      className={`!bg-slate-900 font-medium !text-white placeholder:!text-slate-400 ${
                        !currentLocation && stepError ? '!border-red-500' : '!border-slate-700'
                      }`}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block flex items-center gap-1 text-[11px] font-semibold text-blue-300">
                      <FiMapPin className="size-3 text-blue-400" />
                      <span>Preferred City / Remote</span>
                    </label>
                    <LocationAutocompleteInput
                      value={preferredLocation}
                      onChange={loc => setPreferredLocation(loc)}
                      isPreferred={true}
                      placeholder="e.g. Remote or Bengaluru"
                      isDarkMode={true}
                      className="!border-slate-700 !bg-slate-900 font-medium !text-white placeholder:!text-slate-400"
                    />
                  </div>
                </div>

                {/* Work Authorization [Rule: Blue = Meaning] */}
                <div>
                  <label className="mb-1 block flex items-center gap-1 text-[11px] font-medium text-blue-300">
                    <FiShield className="size-3 text-blue-400" />
                    <span>Work Authorization</span>
                  </label>
                  <select
                    value={workAuth}
                    onChange={e => setWorkAuth(e.target.value)}
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none">
                    <option value="Citizen of India / Authorized to work without sponsorship">
                      Citizen of India / No Sponsorship Needed
                    </option>
                    <option value="US Citizen / Green Card Holder">US Citizen / Green Card Holder</option>
                    <option value="Requires Visa Sponsorship">Requires Visa Sponsorship</option>
                    <option value="Authorized to work in EU/UK">Authorized to work in EU/UK</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: SKILL EXPERIENCE MATRIX (NUMBERS / COUNTERS = YELLOW) */}
          {currentStep === 3 && (
            <div className="animate-fade-in space-y-4">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-400">
                  <FiAward className="size-3.5 text-amber-400" />
                  <span>Flashcard 3: Skill Experience (Years of Experience)</span>
                </h4>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  LLM identified these skills from your resume projects & internships. Adjust the years of experience
                  counter so recruiter questions are answered 100% accurately!
                </p>
              </div>

              {/* Add New Skill Input with 250+ Tech Skills Autocomplete */}
              <div className="flex items-center gap-2">
                <SkillAutocompleteInput
                  value={newSkillInput}
                  onChange={val => setNewSkillInput(val)}
                  onSelect={skill => {
                    const trimmed = skill.trim();
                    if (!trimmed) return;
                    setSkillsMap(prev => ({
                      ...prev,
                      [trimmed]: Math.max(1, profile.yearsOfExperience || 1),
                    }));
                    setNewSkillInput('');
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddNewSkill();
                    }
                  }}
                  placeholder="Type skill (e.g. Python, Docker, React)..."
                  isDarkMode={true}
                  containerClassName="relative flex-1"
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white placeholder:text-slate-500 focus:border-amber-400 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleAddNewSkill}
                  className="flex shrink-0 items-center gap-1 rounded-xl border border-amber-500/40 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-amber-400 transition-colors hover:bg-slate-800">
                  <FiPlus className="size-3.5" />
                  <span>Add</span>
                </button>
              </div>

              {/* Skills Interactive List */}
              <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                {Object.entries(skillsMap).map(([skill, yrs]) => (
                  <div
                    key={skill}
                    className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-900/90 p-3 shadow-sm transition-all hover:border-amber-500/50">
                    <div className="flex items-center gap-2.5">
                      <div className="size-2 rounded-full bg-blue-400" />
                      <span className="text-xs font-semibold tracking-wide text-white">{skill}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, -1)}
                        className="rounded-lg bg-slate-800 p-1 text-slate-300 transition-colors hover:bg-slate-700">
                        <FiMinus className="size-3" />
                      </button>
                      <span className="w-16 rounded-md border border-amber-500/40 bg-black px-2.5 py-1 text-center font-mono text-xs font-bold text-amber-400 shadow-inner">
                        {yrs} {yrs === 1 ? 'yr' : 'yrs'}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, 1)}
                        className="rounded-lg bg-slate-800 p-1 text-slate-300 transition-colors hover:bg-slate-700">
                        <FiPlus className="size-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 4: SUCCESS & PROFILE UPDATE COMPLETE */}
          {currentStep === 4 && (
            <div className="animate-fade-in space-y-4 py-6 text-center">
              <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-950 text-emerald-400">
                <FiCheckCircle className="size-8" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-white">Career Profile Updated & Ready!</h4>
                <p className="mx-auto max-w-sm text-xs leading-relaxed text-slate-400">
                  Your demographic details, salary expectations, and verified skill matrix are saved. Auto-apply agents
                  will now answer all screening questions with maximum precision.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation Buttons */}
        <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/90 px-5 py-3">
          {currentStep > 0 && currentStep < 4 ? (
            <button
              type="button"
              onClick={() => setCurrentStep(prev => prev - 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 transition-colors hover:text-white">
              <FiChevronLeft className="size-3.5" />
              <span>Back</span>
            </button>
          ) : (
            <div />
          )}

          {currentStep === 0 && (
            <button
              type="button"
              onClick={() => setCurrentStep(1)}
              className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-900/40 transition-all hover:bg-blue-500">
              <span>Start Profile Update</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 1 && (
            <button
              type="button"
              onClick={handleStep1Next}
              className={`ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white shadow-lg transition-all ${
                isStep1Valid
                  ? 'bg-blue-600 shadow-blue-900/40 hover:bg-blue-500'
                  : 'cursor-not-allowed bg-slate-800 text-slate-400 opacity-80 hover:bg-slate-700'
              }`}>
              <span>Next: Compensation & City</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 2 && (
            <button
              type="button"
              onClick={handleStep2Next}
              className={`ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white shadow-lg transition-all ${
                isStep2Valid
                  ? 'bg-blue-600 shadow-blue-900/40 hover:bg-blue-500'
                  : 'cursor-not-allowed bg-slate-800 text-slate-400 opacity-80 hover:bg-slate-700'
              }`}>
              <span>Next: Skill Experience</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 3 && (
            <button
              type="button"
              disabled={isSaving}
              onClick={handleFinalSubmit}
              className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-emerald-950/50 transition-all hover:bg-emerald-500 disabled:opacity-50">
              <span>{isSaving ? 'Saving...' : 'Save & Calibrate Brain'}</span>
              <FiCheckCircle className="size-3.5" />
            </button>
          )}

          {currentStep === 4 && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2 text-xs font-semibold text-white transition-all hover:bg-blue-500">
              <span>Done</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
export default ResumeEnrichmentFlashcards;
