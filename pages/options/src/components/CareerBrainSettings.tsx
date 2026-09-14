import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@extension/ui';
import {
  careerBrainStore,
  linkedInConfigStore,
  type ICareerBrain,
  type ILinkedInAutomationConfig,
  DEFAULT_CAREER_BRAIN,
  DEFAULT_LINKEDIN_CONFIG,
} from '@extension/storage';
import {
  FiUser,
  FiCode,
  FiCheck,
  FiShield,
  FiInfo,
  FiPlus,
  FiX,
  FiSliders,
  FiLock,
  FiCheckCircle,
  FiFileText,
} from 'react-icons/fi';
import { PREDEFINED_TECH_SKILLS } from '../constants/skillsList';

interface CareerBrainSettingsProps {
  isDarkMode?: boolean;
}

export const CareerBrainSettings: React.FC<CareerBrainSettingsProps> = ({ isDarkMode = false }) => {
  const [careerBrain, setCareerBrain] = useState<ICareerBrain>(DEFAULT_CAREER_BRAIN);
  const [config, setConfig] = useState<ILinkedInAutomationConfig>({ ...DEFAULT_LINKEDIN_CONFIG, dryRun: true });
  const [newSkill, setNewSkill] = useState<string>('');
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [showSafetyModal, setShowSafetyModal] = useState<boolean>(false);

  // Autocomplete dropdown state
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const skillInputContainerRef = useRef<HTMLDivElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([careerBrainStore.getCareerBrain(), linkedInConfigStore.getConfig()]).then(
      ([brainData, configData]) => {
        setCareerBrain(brainData);
        // Live-Mode is temporarily hardcode-disabled / locked for safety verification
        setConfig({ ...configData, dryRun: true });
      },
    );
  }, []);

  // Close suggestions on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (skillInputContainerRef.current && !skillInputContainerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSave = async () => {
    // Keep dryRun strictly locked to true for safety
    const safeConfig: ILinkedInAutomationConfig = { ...config, dryRun: true };
    await Promise.all([careerBrainStore.updateCareerBrain(careerBrain), linkedInConfigStore.updateConfig(safeConfig)]);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  // Compute filtered suggestions based on typed input
  const query = newSkill.trim().toLowerCase();
  const filteredSuggestions = query
    ? PREDEFINED_TECH_SKILLS.filter(
        skill =>
          skill.toLowerCase().includes(query) &&
          !careerBrain.skills.some(existing => existing.toLowerCase() === skill.toLowerCase()),
      )
        .sort((a, b) => {
          const aStarts = a.toLowerCase().startsWith(query);
          const bStarts = b.toLowerCase().startsWith(query);
          if (aStarts && !bStarts) return -1;
          if (!aStarts && bStarts) return 1;
          return a.localeCompare(b);
        })
        .slice(0, 15)
    : [];

  const handleAddSkill = (skillToAdd?: string) => {
    const skillName = (skillToAdd || newSkill).replace(/,/g, '').trim();
    if (skillName && !careerBrain.skills.some(s => s.toLowerCase() === skillName.toLowerCase())) {
      setCareerBrain(prev => ({
        ...prev,
        skills: [...prev.skills, skillName],
      }));
      setNewSkill('');
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setCareerBrain(prev => ({
      ...prev,
      skills: prev.skills.filter(s => s !== skillToRemove),
    }));
  };

  const handleSkillKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (filteredSuggestions.length > 0) {
        setHighlightedIndex(prev => (prev < filteredSuggestions.length - 1 ? prev + 1 : 0));
        setShowSuggestions(true);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (filteredSuggestions.length > 0) {
        setHighlightedIndex(prev => (prev > 0 ? prev - 1 : filteredSuggestions.length - 1));
        setShowSuggestions(true);
      }
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (showSuggestions && highlightedIndex >= 0 && highlightedIndex < filteredSuggestions.length) {
        handleAddSkill(filteredSuggestions[highlightedIndex]);
      } else {
        handleAddSkill();
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    }
  };

  return (
    <div className="space-y-6 text-left">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Career Brain & Easy Apply Settings</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Configure your candidate profile narrative, skills, and safety thresholds for automated job applications.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={handleSave}
          className="flex items-center gap-2 bg-sky-600 px-4 py-2 text-white hover:bg-sky-700">
          {saveSuccess ? <FiCheck className="size-4 text-green-300" /> : null}
          {saveSuccess ? 'Saved Successfully!' : 'Save Settings'}
        </Button>
      </div>

      {/* Safety Mode Banner — Hardcoded Safe Dry-Run */}
      <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
            <FiShield className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-gray-900 dark:text-white">
                Current Mode: 🛡️ Safe Dry-Run (Simulation Active)
              </h4>
              <span className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/70 dark:text-emerald-200">
                <FiLock className="size-3" />
                Live Mode Locked for Safety
              </span>
            </div>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">
              Automator navigates forms, fills screening answers, and tests fit scores, but stops at the review screen
              without submitting.
            </p>
          </div>
        </div>

        {/* Locked Safety Button / Trigger */}
        <button
          type="button"
          onClick={() => setShowSafetyModal(true)}
          className="shadow-xs flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700">
          <FiShield className="size-3.5" />
          Safety Details
        </button>
      </div>

      {/* Step 1: User Education / Resume Setup Notice */}
      <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50/80 p-4 dark:border-sky-800 dark:bg-sky-950/30">
        <div className="rounded-lg bg-sky-100 p-2 text-sky-700 dark:bg-sky-900/60 dark:text-sky-300">
          <FiFileText className="size-5" />
        </div>
        <div>
          <h4 className="text-sm font-bold text-gray-900 dark:text-white">
            📄 Seamless Automation Tip: One-Time Resume Setup
          </h4>
          <p className="mt-1 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            Due to browser security sandbox rules, background agents cannot inject local files into web uploaders.
            <strong className="font-semibold text-sky-700 dark:text-sky-300">
              {' '}
              Please ensure you have manually applied to at least one job on LinkedIn with your latest PDF resume.
            </strong>{' '}
            Our engine will automatically detect and select your most recent uploaded resume for all subsequent Easy
            Apply applications.
          </p>
        </div>
      </div>

      {/* Section 1: Background Narrative */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } space-y-4 p-6 shadow-sm`}>
        <div className="flex items-center gap-2.5 border-b border-gray-100 pb-2 dark:border-gray-700">
          <FiUser className="size-5 text-sky-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Candidate Background Narrative</h3>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Freeform Career Summary & Work History
            </label>
            <span className="text-xs text-gray-400">{careerBrain.backgroundNarrative.length} characters</span>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <FiInfo className="size-3.5 shrink-0 text-sky-500" />
            Write your background in natural paragraphs. The AI screening solver reads this context to truthfully answer
            custom questions (e.g., tech experience, leadership, project highlights).
          </p>
          <textarea
            rows={6}
            value={careerBrain.backgroundNarrative}
            onChange={e => setCareerBrain(prev => ({ ...prev, backgroundNarrative: e.target.value }))}
            placeholder="e.g. I am a Senior Full-Stack Engineer with 6+ years of experience building scalable distributed web applications using React, TypeScript, Node.js, and MongoDB. I have extensive experience with GraphQL, microservices, cloud deployments on AWS, and leading agile engineering teams..."
            className={`w-full rounded-lg border ${
              isDarkMode ? 'border-slate-600 bg-slate-700/80 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
            } p-3 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500`}
          />
        </div>

        {/* Structured Profile Fields Grid */}
        <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Current / Target Job Title
            </label>
            <input
              type="text"
              value={careerBrain.currentTitle}
              onChange={e => setCareerBrain(prev => ({ ...prev, currentTitle: e.target.value }))}
              placeholder="e.g. Senior Software Engineer"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Total Years of Experience
            </label>
            <input
              type="number"
              min={0}
              max={40}
              value={careerBrain.yearsOfExperience}
              onChange={e => setCareerBrain(prev => ({ ...prev, yearsOfExperience: Number(e.target.value) || 0 }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Notice Period / Availability
            </label>
            <input
              type="text"
              value={careerBrain.noticePeriod}
              onChange={e => setCareerBrain(prev => ({ ...prev, noticePeriod: e.target.value }))}
              placeholder="e.g. Immediate, 15 Days, 30 Days"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Work Authorization Status
            </label>
            <input
              type="text"
              value={careerBrain.workAuthorization}
              onChange={e => setCareerBrain(prev => ({ ...prev, workAuthorization: e.target.value }))}
              placeholder="e.g. Citizen of India / Authorized to work without sponsorship"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Target Salary Expectation
            </label>
            <input
              type="text"
              value={careerBrain.salaryExpectation}
              onChange={e => setCareerBrain(prev => ({ ...prev, salaryExpectation: e.target.value }))}
              placeholder="e.g. ₹18,00,000 - ₹24,00,000 / $130k"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Preferred Location / Remote
            </label>
            <input
              type="text"
              value={careerBrain.preferredLocation}
              onChange={e => setCareerBrain(prev => ({ ...prev, preferredLocation: e.target.value }))}
              placeholder="e.g. Remote / Bengaluru / Hybrid"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">Contact Phone</label>
            <input
              type="tel"
              value={careerBrain.phoneNumber}
              onChange={e => setCareerBrain(prev => ({ ...prev, phoneNumber: e.target.value }))}
              placeholder="e.g. +91 9876543210"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">Contact Email</label>
            <input
              type="email"
              value={careerBrain.email}
              onChange={e => setCareerBrain(prev => ({ ...prev, email: e.target.value }))}
              placeholder="e.g. user@example.com"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>
        </div>
      </div>

      {/* Section 2: Core Skills List with Autocomplete Dropdown */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } space-y-4 p-6 shadow-sm`}>
        <div className="flex items-center gap-2.5 border-b border-gray-100 pb-2 dark:border-gray-700">
          <FiCode className="size-5 text-indigo-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Core Skills & Tech Stack</h3>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Add skills you are proficient in. Start typing to see suggestions from over 200+ technologies or type any
          custom skill.
        </p>

        {/* Autocomplete Input Box */}
        <div className="relative" ref={skillInputContainerRef}>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={skillInputRef}
                type="text"
                value={newSkill}
                onChange={e => {
                  setNewSkill(e.target.value);
                  setShowSuggestions(true);
                  setHighlightedIndex(-1);
                }}
                onFocus={() => {
                  if (newSkill.trim().length > 0) {
                    setShowSuggestions(true);
                  }
                }}
                onKeyDown={handleSkillKeyDown}
                placeholder="Type skill (e.g. React, Python, AWS, Docker, Rust) and press Enter"
                className={`w-full rounded-md border ${
                  isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
                } px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500`}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => handleAddSkill()}
              className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-sm">
              <FiPlus className="size-4" />
              Add
            </Button>
          </div>

          {/* Floating Autocomplete Suggestions Dropdown */}
          {showSuggestions && filteredSuggestions.length > 0 && (
            <div
              className={`absolute left-0 right-16 top-full z-30 mt-1.5 max-h-60 overflow-y-auto rounded-lg border shadow-xl ${
                isDarkMode ? 'border-slate-700 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-800'
              }`}>
              <div className="space-y-0.5 p-1.5">
                <div className="px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  Matching Suggestions ({filteredSuggestions.length})
                </div>
                {filteredSuggestions.map((skill, index) => {
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <div
                      key={skill}
                      onMouseDown={e => {
                        e.preventDefault();
                        handleAddSkill(skill);
                      }}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      className={`flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm transition-colors ${
                        isHighlighted
                          ? 'bg-indigo-600 font-medium text-white'
                          : isDarkMode
                            ? 'text-gray-200 hover:bg-slate-700'
                            : 'text-gray-800 hover:bg-indigo-50'
                      }`}>
                      <span>{skill}</span>
                      <FiPlus className={`size-3.5 ${isHighlighted ? 'text-white' : 'text-gray-400'}`} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Skill Badges */}
        <div className="flex flex-wrap gap-2 pt-1">
          {careerBrain.skills.map(skill => (
            <span
              key={skill}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-100 px-3 py-1 text-xs font-medium text-sky-800 dark:border-sky-800 dark:bg-sky-900/60 dark:text-sky-200">
              {skill}
              <button
                type="button"
                onClick={() => handleRemoveSkill(skill)}
                className="cursor-pointer rounded-full hover:text-red-500 focus:outline-none">
                <FiX className="size-3.5" />
              </button>
            </span>
          ))}
          {careerBrain.skills.length === 0 && (
            <span className="text-xs italic text-gray-400">No skills added yet. Type a skill above to add.</span>
          )}
        </div>
      </div>

      {/* Section 3: Job Search Configuration & Thresholds */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } space-y-4 p-6 shadow-sm`}>
        <div className="flex items-center gap-2.5 border-b border-gray-100 pb-2 dark:border-gray-700">
          <FiSliders className="size-5 text-purple-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Job Search & Safeties Configuration</h3>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Target Job Title */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Target Search Role / Keywords
            </label>
            <input
              type="text"
              value={config.targetJobTitle}
              onChange={e => setConfig(prev => ({ ...prev, targetJobTitle: e.target.value }))}
              placeholder="e.g. Full Stack Engineer, Frontend Developer"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          {/* Target Location */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Target Search Location
            </label>
            <input
              type="text"
              value={config.targetLocation}
              onChange={e => setConfig(prev => ({ ...prev, targetLocation: e.target.value }))}
              placeholder="e.g. Remote, India, Bengaluru"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          {/* Min Fit Score Threshold */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                Minimum Fit Score Threshold
              </label>
              <span className="text-xs font-bold text-sky-600 dark:text-sky-400">{config.minFitScore} / 100</span>
            </div>
            <input
              type="range"
              min={50}
              max={95}
              step={5}
              value={config.minFitScore}
              onChange={e => setConfig(prev => ({ ...prev, minFitScore: Number(e.target.value) }))}
              className="w-full cursor-pointer accent-sky-600"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Jobs with RAG fit score below {config.minFitScore} are automatically skipped. (Default: 75)
            </p>
          </div>

          {/* Daily Application Limit */}
          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Daily Application Limit (Safe Quota)
            </label>
            <input
              type="number"
              min={1}
              max={50}
              value={config.dailyApplicationLimit}
              onChange={e =>
                setConfig(prev => ({ ...prev, dailyApplicationLimit: Math.max(1, Number(e.target.value) || 15) }))
              }
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Maximum applications per day. Automatically pauses and reschedules for next day upon limit.
            </p>
          </div>
        </div>
      </div>

      {/* Safety Mode Details Modal */}
      {showSafetyModal && (
        <div className="backdrop-blur-xs fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div
            className={`w-full max-w-lg rounded-2xl border p-6 shadow-2xl ${
              isDarkMode
                ? 'border-emerald-500/40 bg-slate-800 text-gray-100'
                : 'border-emerald-400 bg-white text-gray-900'
            } space-y-4`}>
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
              <div className="rounded-xl bg-emerald-100 p-3 dark:bg-emerald-950/60">
                <FiShield className="size-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold">Safe Dry-Run Simulation Active</h3>
                <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  Live Submissions are locked for safety
                </p>
              </div>
            </div>

            <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
              NanoBrowser Easy Apply automation runs exclusively in <strong>Safe Dry-Run Simulation</strong> mode during
              the verification phase.
            </p>

            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3.5 text-xs text-gray-600 dark:border-emerald-800/60 dark:bg-emerald-950/20 dark:text-gray-300">
              <div className="mb-1 font-semibold text-emerald-800 dark:text-emerald-200">
                What Happens in Dry-Run Mode:
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  Validates active LinkedIn session cookies (<code>li_at</code>, <code>JSESSIONID</code>).
                </span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  Sanitizes job descriptions and calculates RAG Fit Scores (skipping &lt; {config.minFitScore}%).
                </span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>Solves screening questions with your Career Brain and navigates multi-step forms safely.</span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span>
                  <strong>Stops at the final review modal step without ever clicking the Submit button.</strong>
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end pt-2">
              <Button
                variant="primary"
                onClick={() => setShowSafetyModal(false)}
                className="cursor-pointer bg-emerald-600 px-4 py-2 text-xs text-white hover:bg-emerald-700">
                Understood (Keep Safe Dry-Run)
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CareerBrainSettings;
