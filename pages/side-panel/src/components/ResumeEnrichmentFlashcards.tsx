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
} from 'react-icons/fi';
import { LocationAutocompleteInput } from './LocationAutocompleteInput';

interface ResumeEnrichmentFlashcardsProps {
  isOpen: boolean;
  onClose: () => void;
  profile: ICareerBrain;
  onSave: (updatedProfile: Partial<ICareerBrain>) => Promise<void>;
  isDarkMode?: boolean;
}

export const ResumeEnrichmentFlashcards: React.FC<ResumeEnrichmentFlashcardsProps> = ({
  isOpen,
  onClose,
  profile,
  onSave,
  isDarkMode = true,
}) => {
  if (!isOpen) return null;

  // Flashcard steps:
  // Step 0: Welcome & Overview
  // Step 1: Missing Basic Fields (Notice period, CTC, Location, Work Auth)
  // Step 2: Skill Experience Matrix (Years of experience in each project / internship skill)
  // Step 3: Success & Complete
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [isSaving, setIsSaving] = useState(false);

  // Form State for Step 1: Missing Fields
  const [noticePeriod, setNoticePeriod] = useState(profile.noticePeriod || 'Immediate');
  const [currentCTC, setCurrentCTC] = useState(profile.currentCTC || '');
  const [expectedCTC, setExpectedCTC] = useState(profile.expectedCTC || profile.salaryExpectation || '');
  const [currentLocation, setCurrentLocation] = useState(profile.currentLocation || '');
  const [preferredLocation, setPreferredLocation] = useState(profile.preferredLocation || '');
  const [workAuth, setWorkAuth] = useState(
    profile.workAuthorization || 'Citizen of India / Authorized to work without sponsorship',
  );

  // Form State for Step 2: Skills Experience Matrix
  // Initialize with skills from profile and their skillExperience years
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
      setCurrentStep(3); // Go to finish state
    } catch (err) {
      console.error('[Flashcards] Failed to save profile updates:', err);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div
        className={`relative w-full max-w-lg rounded-2xl border shadow-2xl overflow-hidden transition-all duration-300 flex flex-col max-h-[92vh] ${
          isDarkMode
            ? 'bg-slate-900 border-sky-500/30 text-slate-100 shadow-sky-950/50'
            : 'bg-white border-sky-200 text-slate-800 shadow-xl'
        }`}>
        {/* Header Bar */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-sky-500/20 bg-gradient-to-r from-sky-500/10 via-purple-500/10 to-transparent">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-sky-500/20 text-sky-400 border border-sky-500/30">
              <FiZap className="size-4 animate-pulse" />
            </div>
            <div>
              <h3 className="font-semibold text-sm tracking-wide flex items-center gap-1.5">
                <span>AI Resume Intelligence Flashcards</span>
              </h3>
              <p className="text-[11px] text-slate-400">Step {currentStep + 1} of 4 • Profile & Skill Calibration</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors">
            <FiX className="size-4" />
          </button>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-800/60 h-1">
          <div
            className="bg-gradient-to-r from-sky-400 to-indigo-500 h-1 transition-all duration-300"
            style={{ width: `${((currentStep + 1) / 4) * 100}%` }}
          />
        </div>

        {/* Card Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* STEP 0: WELCOME & RESUME SCAN SUMMARY */}
          {currentStep === 0 && (
            <div className="space-y-4 text-center py-2 animate-fade-in">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-gradient-to-tr from-sky-500 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-sky-500/25">
                <FiAward className="size-7" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-sky-400">Resume Upload Complete!</h4>
                <p className="text-xs text-slate-300 max-w-sm mx-auto leading-relaxed">
                  We’ve scanned your projects, internships, and work history. Let’s calibrate a few crucial screening
                  answers and skill durations so that LinkedIn & Naukri bots never skip your job applications!
                </p>
              </div>

              <div
                className={`p-3.5 rounded-xl border text-left text-xs space-y-2 ${
                  isDarkMode ? 'bg-slate-800/60 border-slate-700/80' : 'bg-slate-50 border-slate-200'
                }`}>
                <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold border-b border-slate-700/50 pb-1.5">
                  <span>DETECTED HIGHLIGHTS</span>
                  <span className="text-emerald-400">Ready for review</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <span className="text-slate-400">Candidate:</span>{' '}
                    <span className="font-medium text-slate-200">{profile.fullName || 'Not specified'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Total Experience:</span>{' '}
                    <span className="font-medium text-sky-300">{profile.yearsOfExperience || 0} Years</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Extracted Skills:</span>{' '}
                    <span className="font-medium text-purple-300">{allSkills.length} Tech Skills</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Work Positions:</span>{' '}
                    <span className="font-medium text-slate-200">{profile.workExperience?.length || 0} Roles</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 1: UNFILLED SCREENING QUESTIONS & CAREER GAPS */}
          {currentStep === 1 && (
            <div className="space-y-4 animate-fade-in">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="text-xs font-bold text-sky-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <FiHelpCircle className="size-3.5" />
                  <span>Flashcard 1: Screening & Salary Calibration</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Recruiters on Naukri & LinkedIn filter candidates by notice period and CTC. Fill these once to enable
                  1-click auto-apply.
                </p>
              </div>

              <div className="space-y-3 text-xs">
                {/* Notice Period */}
                <div>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                    <FiClock className="size-3 text-sky-400" />
                    <span>Notice Period / Joining Availability</span>
                  </label>
                  <select
                    value={noticePeriod}
                    onChange={e => setNoticePeriod(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500">
                    <option value="Immediate">Immediate (0 days)</option>
                    <option value="15 Days">15 Days</option>
                    <option value="30 Days">30 Days (1 Month)</option>
                    <option value="60 Days">60 Days (2 Months)</option>
                    <option value="Serving Notice Period">Currently Serving Notice Period</option>
                  </select>
                </div>

                {/* Current & Expected CTC */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                      <FiDollarSign className="size-3 text-emerald-400" />
                      <span>Current CTC (in LPA)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 6 or 6.5 LPA"
                      value={currentCTC}
                      onChange={e => setCurrentCTC(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                      <FiDollarSign className="size-3 text-emerald-400" />
                      <span>Expected CTC (in LPA)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 10 or 12 LPA"
                      value={expectedCTC}
                      onChange={e => setExpectedCTC(e.target.value)}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                {/* Current & Preferred Location with Standardized Autocomplete Dropdown */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                      <FiMapPin className="size-3 text-amber-400" />
                      <span>Current City</span>
                    </label>
                    <LocationAutocompleteInput
                      value={currentLocation}
                      onChange={loc => setCurrentLocation(loc)}
                      placeholder="e.g. Kolkata, West Bengal, India"
                      isDarkMode={isDarkMode}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                      <FiMapPin className="size-3 text-amber-400" />
                      <span>Preferred City / Remote</span>
                    </label>
                    <LocationAutocompleteInput
                      value={preferredLocation}
                      onChange={loc => setPreferredLocation(loc)}
                      isPreferred={true}
                      placeholder="e.g. Remote or Bengaluru"
                      isDarkMode={isDarkMode}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                {/* Work Authorization */}
                <div>
                  <label className="block text-[11px] font-medium text-slate-300 mb-1 flex items-center gap-1">
                    <FiShield className="size-3 text-purple-400" />
                    <span>Work Authorization</span>
                  </label>
                  <select
                    value={workAuth}
                    onChange={e => setWorkAuth(e.target.value)}
                    className="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500">
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

          {/* STEP 2: PROJECT & INTERNSHIP SKILL EXPERIENCE MATRIX */}
          {currentStep === 2 && (
            <div className="space-y-4 animate-fade-in">
              <div className="border-b border-slate-800 pb-2">
                <h4 className="text-xs font-bold text-sky-400 flex items-center gap-1.5 uppercase tracking-wider">
                  <FiAward className="size-3.5" />
                  <span>Flashcard 2: Skill Experience Counter (Years)</span>
                </h4>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  LLM extracted these skills from your projects, internships & jobs. Adjust the years of experience so
                  recruiter questions are filled with 100% precision!
                </p>
              </div>

              {/* Add New Skill Input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Add missing skill (e.g. GraphQL, AWS)..."
                  value={newSkillInput}
                  onChange={e => setNewSkillInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddNewSkill()}
                  className="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={handleAddNewSkill}
                  className="px-3 py-1.5 bg-sky-500/20 text-sky-300 border border-sky-500/40 rounded-lg text-xs font-medium hover:bg-sky-500/30 transition-colors flex items-center gap-1">
                  <FiPlus className="size-3" />
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
                        ? 'bg-slate-800/80 border-slate-700/70 hover:border-sky-500/40'
                        : 'bg-slate-50 border-slate-200 hover:border-sky-300'
                    }`}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-xs text-slate-200">{skill}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, -1)}
                        className="p-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                        <FiMinus className="size-3" />
                      </button>
                      <span className="w-12 text-center text-xs font-bold text-sky-400">
                        {yrs} {yrs === 1 ? 'yr' : 'yrs'}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateSkillYears(skill, 1)}
                        className="p-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                        <FiPlus className="size-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* STEP 3: SUCCESS & COMPLETE */}
          {currentStep === 3 && (
            <div className="text-center py-6 space-y-4 animate-fade-in">
              <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
                <FiCheckCircle className="size-8" />
              </div>
              <div className="space-y-1">
                <h4 className="text-base font-bold text-emerald-400">Career Brain Fully Calibrated!</h4>
                <p className="text-xs text-slate-300 max-w-sm mx-auto leading-relaxed">
                  Your screening answers and skill matrix are saved. The autonomous apply agent is now equipped to
                  answer recruiter screening popups smoothly!
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Navigation Buttons */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800 bg-slate-900/90">
          {currentStep > 0 && currentStep < 3 ? (
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
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-sky-500/20 transition-all cursor-pointer">
              <span>Start Calibration</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 1 && (
            <button
              type="button"
              onClick={() => setCurrentStep(2)}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-sky-500 to-indigo-600 hover:from-sky-400 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-sky-500/20 transition-all cursor-pointer">
              <span>Next: Skill Experience</span>
              <FiChevronRight className="size-3.5" />
            </button>
          )}

          {currentStep === 2 && (
            <button
              type="button"
              disabled={isSaving}
              onClick={handleFinalSubmit}
              className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-emerald-500/20 transition-all cursor-pointer disabled:opacity-50">
              <span>{isSaving ? 'Saving...' : 'Save & Calibrate Brain'}</span>
              <FiCheckCircle className="size-3.5" />
            </button>
          )}

          {currentStep === 3 && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto inline-flex items-center gap-1.5 px-5 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-xl text-xs font-semibold transition-all cursor-pointer">
              <span>Done</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
export default ResumeEnrichmentFlashcards;
