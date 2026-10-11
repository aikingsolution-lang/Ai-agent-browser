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
  // Step 1: Personal & Date Calibration (Gender, DOB, Education)
  // Step 2: Salary, Availability & Work Location (CTC, Notice Period, Cities, Relocation)
  // Step 3: Skill Experience Matrix (Years of experience in each project / internship skill)
  // Step 4: Success & Calibration Complete
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-fade-in font-sans">
      <div
        className={`relative w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden transition-all duration-300 flex flex-col max-h-[92vh] ${
          isDarkMode
            ? 'bg-slate-950 border-slate-800 text-slate-100 shadow-sky-950/40'
            : 'bg-white border-slate-200 text-slate-800 shadow-xl'
        }`}>
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-blue-950/80 text-blue-400 border border-blue-700/50">
              <FiZap className="size-4" />
            </div>
            <div>
              <h3 className="font-semibold text-sm tracking-wide text-white flex items-center gap-1.5">
                <span>AI Career Profile Calibration</span>
              </h3>
              <p className="text-[11px] text-slate-400">Step {currentStep + 1} of 5 • Structured Onboarding</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
            <FiX className="size-4" />
          </button>
        </div>

        {/* Progress Bar (System Colored) */}
        <div className="w-full bg-slate-900 h-1">
          <div
            className="bg-blue-500 h-1 transition-all duration-300"
            style={{ width: `${((currentStep + 1) / 5) * 100}%` }}
          />
        </div>

        {/* Card Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* STEP 0: WELCOME & RESUME SCAN OVERVIEW */}
          {currentStep === 0 && (
            <div className="space-y-4 text-center py-2 animate-fade-in">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-slate-900 border border-blue-500/30 flex items-center justify-center text-blue-400 shadow-lg">
                <FiAward className="size-7" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-white">Resume Analysis Complete</h4>
                <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                  We scanned your resume and projects. Let’s calibrate your key personal profile fields and skill
                  experience so recruiter screening popups on Naukri, LinkedIn and Indeed are filled without getting
                  stuck.
                </p>
              </div>

              {/* Color Code Legend Banner */}
              <div className="flex items-center justify-center gap-4 text-[10px] py-1.5 px-3 rounded-lg bg-slate-900/60 border border-slate-800 text-slate-300">
                <span className="flex items-center gap-1 text-emerald-400">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> Dates & Time
                </span>
                <span className="flex items-center gap-1 text-blue-400">
                  <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" /> Identity & Meaning
                </span>
                <span className="flex items-center gap-1 text-amber-400">
                  <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" /> CTC & Numbers
                </span>
              </div>

              <div
                className={`p-3.5 rounded-xl border text-left text-xs space-y-2.5 ${
                  isDarkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-slate-50 border-slate-200'
                }`}>
                <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold border-b border-slate-800 pb-1.5">
                  <span>DETECTED RESUME PROFILE</span>
                  <span className="text-emerald-400 font-medium">Ready</span>
                </div>
                <div className="grid grid-cols-2 gap-2.5 text-[11px]">
                  <div>
                    <span className="text-slate-400 block text-[10px]">Candidate Name</span>
                    <span className="font-semibold text-white">{profile.fullName || 'Not specified'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Total Work Tenure</span>
                    <span className="font-semibold text-amber-400">{profile.yearsOfExperience || 0} Years</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Extracted Technologies</span>
                    <span className="font-semibold text-blue-400">{allSkills.length} Verified Skills</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">Work Positions</span>
                    <span className="font-semibold text-white">{profile.workExperience?.length || 0} Roles</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 1: IDENTITY & DATES (GENDER, DOB, EDUCATION) */}
          {currentStep === 1 && (
            <div className="space-y-4 animate-fade-in">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="text-xs font-bold text-blue-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <FiUser className="size-3.5 text-blue-400" />
                  <span>Flashcard 1: Personal Identity & Dates</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Recruiters on Naukri, Indeed & LinkedIn require these mandatory demographic screening questions.
                </p>
              </div>

              <div className="space-y-3.5 text-xs">
                {/* Gender Identity [Rule: Blue/Dark Blue = Identity & Meaning] */}
                <div>
                  <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                    <FiUser className="size-3 text-blue-400" />
                    <span>Gender Identity</span>
                  </label>
                  <select
                    value={gender}
                    onChange={e => setGender(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500">
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                    <option value="Prefer not to say">Prefer not to say</option>
                  </select>
                </div>

                {/* Date of Birth [Rule: Green = Dates & Timelines] */}
                <div>
                  <label className="block text-[11px] font-medium text-emerald-300 mb-1 flex items-center gap-1">
                    <FiCalendar className="size-3 text-emerald-400" />
                    <span>Date of Birth</span>
                  </label>
                  <input
                    type="date"
                    value={dateOfBirth}
                    onChange={e => setDateOfBirth(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-[10px] text-slate-500 mt-0.5 block">
                    Used to confirm 18+ age verification and birthday screening fields.
                  </span>
                </div>

                {/* Highest Education Degree [Rule: Blue = Meaning] */}
                <div>
                  <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                    <FiBookOpen className="size-3 text-blue-400" />
                    <span>Highest Completed Education Level</span>
                  </label>
                  <select
                    value={highestEducation}
                    onChange={e => setHighestEducation(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500">
                    <option value="Bachelor's Degree">Bachelor's Degree (B.Tech / B.E / B.Sc / BCA)</option>
                    <option value="Master's Degree">Master's Degree (M.Tech / M.E / M.Sc / MCA)</option>
                    <option value="Doctorate / PhD">Doctorate / PhD</option>
                    <option value="Diploma">Diploma / Associate Degree</option>
                    <option value="High School">High School (12th Grade)</option>
                  </select>
                </div>

                {/* Relocation Willingness [Rule: Blue = Meaning] */}
                <div>
                  <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                    <FiMapPin className="size-3 text-blue-400" />
                    <span>Are you willing to relocate for the job?</span>
                  </label>
                  <select
                    value={willingToRelocate}
                    onChange={e => setWillingToRelocate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500">
                    <option value="Yes">Yes (Preferred for maximum matches)</option>
                    <option value="No">No (Remote / Current City only)</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: SALARY, DATES & LOCATION */}
          {currentStep === 2 && (
            <div className="space-y-4 animate-fade-in">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <FiDollarSign className="size-3.5 text-amber-400" />
                  <span>Flashcard 2: CTC, Notice Period & Location</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Job boards use notice period and CTC to screen applicants before forwarding to HR.
                </p>
              </div>

              <div className="space-y-3.5 text-xs">
                {/* Notice Period [Rule: Green = Timeline/Dates] */}
                <div>
                  <label className="block text-[11px] font-medium text-emerald-300 mb-1 flex items-center gap-1">
                    <FiClock className="size-3 text-emerald-400" />
                    <span>Notice Period / Availability to Join</span>
                  </label>
                  <select
                    value={noticePeriod}
                    onChange={e => setNoticePeriod(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-emerald-500">
                    <option value="Immediate">Immediate (0 days)</option>
                    <option value="15 Days">15 Days</option>
                    <option value="30 Days">30 Days (1 Month)</option>
                    <option value="60 Days">60 Days (2 Months)</option>
                    <option value="Serving Notice Period">Currently Serving Notice Period</option>
                  </select>
                </div>

                {/* Current & Expected CTC [Rule: Yellow = Numbers, CTC, Equations] */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-2.5 rounded-xl bg-slate-900 border border-amber-500/20">
                    <label className="block text-[11px] font-semibold text-amber-400 mb-1 flex items-center gap-1">
                      <FiDollarSign className="size-3 text-amber-400" />
                      <span>Current CTC (Lakhs)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 6 or 6.5 LPA"
                      value={currentCTC}
                      onChange={e => setCurrentCTC(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-black border border-amber-500/30 text-xs text-amber-300 font-mono focus:outline-none focus:border-amber-400"
                    />
                  </div>
                  <div className="p-2.5 rounded-xl bg-slate-900 border border-amber-500/20">
                    <label className="block text-[11px] font-semibold text-amber-400 mb-1 flex items-center gap-1">
                      <FiDollarSign className="size-3 text-amber-400" />
                      <span>Expected CTC (Lakhs)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 10 or 12 LPA"
                      value={expectedCTC}
                      onChange={e => setExpectedCTC(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-black border border-amber-500/30 text-xs text-amber-300 font-mono focus:outline-none focus:border-amber-400"
                    />
                  </div>
                </div>

                {/* Current City & Preferred City [Rule: Blue = Meaning, Standard Autocomplete] */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                      <FiMapPin className="size-3 text-blue-400" />
                      <span>Current City</span>
                    </label>
                    <LocationAutocompleteInput
                      value={currentLocation}
                      onChange={loc => setCurrentLocation(loc)}
                      placeholder="e.g. Kolkata, West Bengal, India"
                      isDarkMode={isDarkMode}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                      <FiMapPin className="size-3 text-blue-400" />
                      <span>Preferred City / Remote</span>
                    </label>
                    <LocationAutocompleteInput
                      value={preferredLocation}
                      onChange={loc => setPreferredLocation(loc)}
                      isPreferred={true}
                      placeholder="e.g. Remote or Bengaluru"
                      isDarkMode={isDarkMode}
                      className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </div>

                {/* Work Authorization [Rule: Blue = Meaning] */}
                <div>
                  <label className="block text-[11px] font-medium text-blue-300 mb-1 flex items-center gap-1">
                    <FiShield className="size-3 text-blue-400" />
                    <span>Work Authorization</span>
                  </label>
                  <select
                    value={workAuth}
                    onChange={e => setWorkAuth(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-blue-500">
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
            <div className="space-y-4 animate-fade-in">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="text-xs font-bold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <FiAward className="size-3.5 text-amber-400" />
                  <span>Flashcard 3: Skill Experience (Years of Experience)</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  LLM identified these skills from your resume projects & internships. Adjust the years of experience
                  counter so recruiter questions are answered 100% accurately!
                </p>
              </div>

              {/* Add New Skill Input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Add missing skill (e.g. Docker, GraphQL)..."
                  value={newSkillInput}
                  onChange={e => setNewSkillInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddNewSkill()}
                  className="flex-1 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 text-xs text-white focus:outline-none focus:border-amber-400"
                />
                <button
                  type="button"
                  onClick={handleAddNewSkill}
                  className="px-3.5 py-2 bg-slate-900 text-amber-400 border border-amber-500/40 rounded-xl text-xs font-semibold hover:bg-slate-800 transition-colors flex items-center gap-1">
                  <FiPlus className="size-3.5" />
                  <span>Add</span>
                </button>
              </div>

              {/* Skills Interactive List */}
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {Object.entries(skillsMap).map(([skill, yrs]) => (
                  <div
                    key={skill}
                    className={`flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                      isDarkMode
                        ? 'bg-slate-900/90 border-slate-800 hover:border-amber-500/40'
                        : 'bg-slate-50 border-slate-200 hover:border-amber-400'
                    }`}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-xs text-white">{skill}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, -1)}
                        className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors">
                        <FiMinus className="size-3" />
                      </button>
                      <span className="w-14 text-center text-xs font-bold text-amber-400 font-mono bg-black/60 px-2 py-0.5 rounded border border-amber-500/30">
                        {yrs} {yrs === 1 ? 'yr' : 'yrs'}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, 1)}
                        className="p-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors">
                        <FiPlus className="size-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 4: SUCCESS & CALIBRATION COMPLETE */}
          {currentStep === 4 && (
            <div className="text-center py-6 space-y-4 animate-fade-in">
              <div className="mx-auto w-16 h-16 rounded-full bg-emerald-950 text-emerald-400 flex items-center justify-center border border-emerald-500/40">
                <FiCheckCircle className="size-8" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-white">Career Brain Calibrated & Ready!</h4>
                <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                  Your demographic details, salary expectations, and verified skill matrix are saved. Auto-apply agents
                  will now answer all screening questions with maximum precision.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation Buttons */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800 bg-slate-900/90">
          {currentStep > 0 && currentStep < 4 ? (
            <button
              type="button"
              onClick={() => setCurrentStep(prev => prev - 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-400 hover:text-white transition-colors">
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
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-900/40 transition-all cursor-pointer">
              <span>Start Calibration</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 1 && (
            <button
              type="button"
              onClick={() => setCurrentStep(2)}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-900/40 transition-all cursor-pointer">
              <span>Next: Compensation & City</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 2 && (
            <button
              type="button"
              onClick={() => setCurrentStep(3)}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-blue-900/40 transition-all cursor-pointer">
              <span>Next: Skill Experience</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 3 && (
            <button
              type="button"
              disabled={isSaving}
              onClick={handleFinalSubmit}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-emerald-950/50 transition-all cursor-pointer disabled:opacity-50">
              <span>{isSaving ? 'Saving...' : 'Save & Calibrate Brain'}</span>
              <FiCheckCircle className="size-3.5" />
            </button>
          )}

          {currentStep === 4 && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto inline-flex items-center gap-1.5 px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition-all cursor-pointer">
              <span>Done</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
export default ResumeEnrichmentFlashcards;
