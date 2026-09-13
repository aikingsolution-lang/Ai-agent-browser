import React, { useState, useEffect } from 'react';
import { Button } from '@extension/ui';
import {
  careerBrainStore,
  linkedInConfigStore,
  type ICareerBrain,
  type ILinkedInAutomationConfig,
  DEFAULT_CAREER_BRAIN,
  DEFAULT_LINKEDIN_CONFIG,
} from '@extension/storage';
import { FiUser, FiCode, FiCheck, FiAlertTriangle, FiShield, FiInfo, FiPlus, FiX, FiSliders } from 'react-icons/fi';

interface CareerBrainSettingsProps {
  isDarkMode?: boolean;
}

export const CareerBrainSettings: React.FC<CareerBrainSettingsProps> = ({ isDarkMode = false }) => {
  const [careerBrain, setCareerBrain] = useState<ICareerBrain>(DEFAULT_CAREER_BRAIN);
  const [config, setConfig] = useState<ILinkedInAutomationConfig>(DEFAULT_LINKEDIN_CONFIG);
  const [newSkill, setNewSkill] = useState<string>('');
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [showLiveConfirmModal, setShowLiveConfirmModal] = useState<boolean>(false);

  useEffect(() => {
    Promise.all([careerBrainStore.getCareerBrain(), linkedInConfigStore.getConfig()]).then(
      ([brainData, configData]) => {
        setCareerBrain(brainData);
        setConfig(configData);
      },
    );
  }, []);

  const handleSave = async () => {
    await Promise.all([careerBrainStore.updateCareerBrain(careerBrain), linkedInConfigStore.updateConfig(config)]);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  const handleAddSkill = () => {
    const trimmed = newSkill.trim();
    if (trimmed && !careerBrain.skills.includes(trimmed)) {
      setCareerBrain(prev => ({
        ...prev,
        skills: [...prev.skills, trimmed],
      }));
      setNewSkill('');
    }
  };

  const handleRemoveSkill = (skillToRemove: string) => {
    setCareerBrain(prev => ({
      ...prev,
      skills: prev.skills.filter(s => s !== skillToRemove),
    }));
  };

  const handleLiveModeToggle = () => {
    if (config.dryRun) {
      // Currently in Safe Dry-Run -> user wants to enable Live Mode -> show confirmation safety modal
      setShowLiveConfirmModal(true);
    } else {
      // Currently in Live Mode -> user wants to revert to Safe Dry-Run -> update & persist immediately
      const updatedConfig = { ...config, dryRun: true };
      setConfig(updatedConfig);
      linkedInConfigStore.updateConfig({ dryRun: true });
    }
  };

  const confirmLiveMode = async () => {
    const updatedConfig = { ...config, dryRun: false };
    setConfig(updatedConfig);
    await linkedInConfigStore.updateConfig({ dryRun: false });
    setShowLiveConfirmModal(false);
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

      {/* Safety Mode Banner */}
      <div
        className={`p-4 rounded-xl border flex items-center justify-between ${
          config.dryRun
            ? 'bg-emerald-50/80 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800'
            : 'bg-amber-50/80 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700'
        }`}>
        <div className="flex items-center gap-3">
          <div
            className={`p-2 rounded-lg ${
              config.dryRun
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-300'
            }`}>
            {config.dryRun ? <FiShield className="w-5 h-5" /> : <FiAlertTriangle className="w-5 h-5" />}
          </div>
          <div>
            <h4 className="text-sm font-bold text-gray-900 dark:text-white">
              Current Mode: {config.dryRun ? '🛡️ Safe Dry-Run (Simulation)' : '🚀 Live Application Mode'}
            </h4>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              {config.dryRun
                ? 'Automator navigates forms, fills screening answers, and tests fit score, but stops at the review screen without submitting.'
                : 'Automator will submit actual real applications to LinkedIn on your behalf with your approved profile.'}
            </p>
          </div>
        </div>

        {/* Interactive Toggle Switch */}
        <div className="flex items-center gap-2.5 shrink-0 cursor-pointer" onClick={handleLiveModeToggle}>
          <button
            type="button"
            role="switch"
            aria-checked={!config.dryRun}
            onClick={e => {
              e.stopPropagation();
              handleLiveModeToggle();
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-sky-500 ${
              !config.dryRun ? 'bg-amber-500' : 'bg-slate-400 dark:bg-slate-600'
            }`}>
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform ${
                !config.dryRun ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 select-none">
            {config.dryRun ? 'Dry-Run' : 'Live Mode'}
          </span>
        </div>
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

      {/* Section 2: Core Skills List */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } p-6 shadow-sm space-y-4`}>
        <div className="flex items-center gap-2.5 pb-2 border-b border-gray-100 dark:border-gray-700">
          <FiCode className="w-5 h-5 text-indigo-500" />
          <h3 className="text-base font-bold text-gray-900 dark:text-white">Core Skills & Tech Stack</h3>
        </div>

        <p className="text-xs text-gray-500 dark:text-gray-400">
          Add skills that you are proficient in. These are evaluated during RAG Fit-Scoring and used to answer
          years-of-experience screening questions.
        </p>

        {/* Add Skill Input */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newSkill}
            onChange={e => setNewSkill(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddSkill();
              }
            }}
            placeholder="Type skill (e.g. React, Node.js, Python, AWS) and press Enter"
            className={`flex-1 rounded-md border ${
              isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
            } px-3 py-2 text-sm`}
          />
          <Button variant="secondary" onClick={handleAddSkill} className="flex items-center gap-1.5 px-3 py-2 text-sm">
            <FiPlus className="w-4 h-4" />
            Add
          </Button>
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
                className="hover:text-red-500 rounded-full focus:outline-none">
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

      {/* Confirmation Modal for Live Mode */}
      {showLiveConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div
            className={`max-w-md w-full rounded-2xl p-6 shadow-2xl border ${
              isDarkMode ? 'bg-slate-800 border-amber-500/40 text-gray-100' : 'bg-white border-amber-400 text-gray-900'
            } space-y-4`}>
            <div className="flex items-center gap-3 text-amber-600 dark:text-amber-400">
              <div className="p-3 bg-amber-100 dark:bg-amber-950/60 rounded-xl">
                <FiAlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold">Enable Live Application Mode?</h3>
            </div>

            <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
              In <strong>Live Mode</strong>, NanoBrowser will click the final <em>Submit application</em> button on
              LinkedIn on your behalf.
            </p>

            <ul className="text-xs text-gray-500 dark:text-gray-400 list-disc list-inside space-y-1">
              <li>Ensure your candidate narrative and contact details are accurate.</li>
              <li>Daily safe application limit ({config.dailyApplicationLimit}/day) will be strictly respected.</li>
              <li>You can switch back to Dry-Run mode anytime.</li>
            </ul>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button variant="secondary" onClick={() => setShowLiveConfirmModal(false)} className="text-xs px-3 py-2">
                Cancel (Keep Dry-Run)
              </Button>
              <Button
                variant="primary"
                onClick={confirmLiveMode}
                className="bg-amber-600 hover:bg-amber-700 text-white text-xs px-3 py-2">
                I Understand, Enable Live Mode
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CareerBrainSettings;
