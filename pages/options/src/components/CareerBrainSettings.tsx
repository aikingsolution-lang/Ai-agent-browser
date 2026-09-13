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
          className="flex items-center gap-2 bg-sky-600 hover:bg-sky-700 text-white px-4 py-2">
          {saveSuccess ? <FiCheck className="w-4 h-4 text-green-300" /> : null}
          {saveSuccess ? 'Saved Successfully!' : 'Save Settings'}
        </Button>
      </div>

      {/* Safety Mode Banner — Hardcoded Safe Dry-Run */}
      <div className="p-4 rounded-xl border flex items-center justify-between bg-emerald-50/80 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300">
            <FiShield className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-gray-900 dark:text-white">
                Current Mode: 🛡️ Safe Dry-Run (Simulation Active)
              </h4>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-100 text-emerald-800 dark:bg-emerald-900/70 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700">
                <FiLock className="w-3 h-3" />
                Live Mode Locked for Safety
              </span>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 mt-0.5">
              Automator navigates forms, fills screening answers, and tests fit scores, but stops at the review screen
              without submitting.
            </p>
          </div>
        </div>

        {/* Locked Safety Button / Trigger */}
        <button
          type="button"
          onClick={() => setShowSafetyModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs transition-colors shrink-0 cursor-pointer">
          <FiShield className="w-3.5 h-3.5" />
          Safety Details
        </button>
      </div>

      {/* Section 1: Background Narrative */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } p-6 shadow-sm space-y-4`}>
        <div className="flex items-center gap-2.5 pb-2 border-b border-gray-100 dark:border-gray-700">
          <FiUser className="w-5 h-5 text-sky-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Candidate Background Narrative</h3>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Freeform Career Summary & Work History
            </label>
            <span className="text-xs text-gray-400">{careerBrain.backgroundNarrative.length} characters</span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
            <FiInfo className="w-3.5 h-3.5 text-sky-500 shrink-0" />
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Contact Phone</label>
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">Contact Email</label>
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
        } p-6 shadow-sm space-y-4`}>
        <div className="flex items-center gap-2.5 pb-2 border-b border-gray-100 dark:border-gray-700">
          <FiCode className="w-5 h-5 text-indigo-500" />
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
              className="flex items-center gap-1.5 px-3 py-2 text-sm cursor-pointer">
              <FiPlus className="w-4 h-4" />
              Add
            </Button>
          </div>

          {/* Floating Autocomplete Suggestions Dropdown */}
          {showSuggestions && filteredSuggestions.length > 0 && (
            <div
              className={`absolute left-0 right-16 top-full mt-1.5 z-30 max-h-60 overflow-y-auto rounded-lg shadow-xl border ${
                isDarkMode ? 'bg-slate-800 border-slate-700 text-gray-100' : 'bg-white border-gray-200 text-gray-800'
              }`}>
              <div className="p-1.5 space-y-0.5">
                <div className="px-2.5 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">
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
                      className={`flex items-center justify-between px-3 py-2 rounded-md text-sm cursor-pointer transition-colors ${
                        isHighlighted
                          ? 'bg-indigo-600 text-white font-medium'
                          : isDarkMode
                            ? 'hover:bg-slate-700 text-gray-200'
                            : 'hover:bg-indigo-50 text-gray-800'
                      }`}>
                      <span>{skill}</span>
                      <FiPlus className={`w-3.5 h-3.5 ${isHighlighted ? 'text-white' : 'text-gray-400'}`} />
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
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-900/60 dark:text-sky-200 border border-sky-200 dark:border-sky-800">
              {skill}
              <button
                type="button"
                onClick={() => handleRemoveSkill(skill)}
                className="hover:text-red-500 rounded-full focus:outline-none cursor-pointer">
                <FiX className="w-3.5 h-3.5" />
              </button>
            </span>
          ))}
          {careerBrain.skills.length === 0 && (
            <span className="text-xs text-gray-400 italic">No skills added yet. Type a skill above to add.</span>
          )}
        </div>
      </div>

      {/* Section 3: Job Search Configuration & Thresholds */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } p-6 shadow-sm space-y-4`}>
        <div className="flex items-center gap-2.5 pb-2 border-b border-gray-100 dark:border-gray-700">
          <FiSliders className="w-5 h-5 text-purple-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Job Search & Safeties Configuration</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Target Job Title */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <div className="flex items-center justify-between mb-1">
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
              className="w-full accent-sky-600 cursor-pointer"
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Jobs with RAG fit score below {config.minFitScore} are automatically skipped. (Default: 75)
            </p>
          </div>

          {/* Daily Application Limit */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
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
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Maximum applications per day. Automatically pauses and reschedules for next day upon limit.
            </p>
          </div>
        </div>
      </div>

      {/* Safety Mode Details Modal */}
      {showSafetyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`max-w-lg w-full rounded-2xl p-6 shadow-2xl border ${
              isDarkMode
                ? 'bg-slate-800 border-emerald-500/40 text-gray-100'
                : 'bg-white border-emerald-400 text-gray-900'
            } space-y-4`}>
            <div className="flex items-center gap-3 text-emerald-600 dark:text-emerald-400">
              <div className="p-3 bg-emerald-100 dark:bg-emerald-950/60 rounded-xl">
                <FiShield className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold">Safe Dry-Run Simulation Active</h3>
                <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">
                  Live Submissions are locked for safety
                </p>
              </div>
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              NanoBrowser Easy Apply automation runs exclusively in <strong>Safe Dry-Run Simulation</strong> mode during
              the verification phase.
            </p>

            <div className="space-y-2 text-xs text-gray-600 dark:text-gray-300 bg-emerald-50/50 dark:bg-emerald-950/20 p-3.5 rounded-xl border border-emerald-200 dark:border-emerald-800/60">
              <div className="font-semibold text-emerald-800 dark:text-emerald-200 mb-1">
                What Happens in Dry-Run Mode:
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  Validates active LinkedIn session cookies (<code>li_at</code>, <code>JSESSIONID</code>).
                </span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  Sanitizes job descriptions and calculates RAG Fit Scores (skipping &lt; {config.minFitScore}%).
                </span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>Solves screening questions with your Career Brain and navigates multi-step forms safely.</span>
              </div>
              <div className="flex items-start gap-2">
                <FiCheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>
                  <strong>Stops at the final review modal step without ever clicking the Submit button.</strong>
                </span>
              </div>
            </div>

            <div className="flex items-center justify-end pt-2">
              <Button
                variant="primary"
                onClick={() => setShowSafetyModal(false)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-4 py-2 cursor-pointer">
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
