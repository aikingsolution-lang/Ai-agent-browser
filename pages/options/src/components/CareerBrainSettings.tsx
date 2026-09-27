import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@extension/ui';
import {
  careerBrainStore,
  linkedInConfigStore,
  saveCareerBrainData,
  getCareerBrainData,
  type ICareerBrain,
  type IGoldenAnswer,
  type ILinkedInAutomationConfig,
  DEFAULT_CAREER_BRAIN,
  DEFAULT_GOLDEN_ANSWERS,
  DEFAULT_LINKEDIN_CONFIG,
  GOLDEN_ANSWER_CATEGORIES,
  sortGoldenAnswersByPriority,
  isSocialMediaOrUrlQuestion,
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
  FiTrash2,
  FiAlertCircle,
  FiHelpCircle,
  FiSearch,
  FiRotateCcw,
  FiFilter,
  FiTag,
  FiLayers,
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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [showSafetyModal, setShowSafetyModal] = useState<boolean>(false);

  // Golden Answers Category Tab & Search Filter state
  const [selectedCategoryTab, setSelectedCategoryTab] = useState<string>('All');
  const [goldenSearchQuery, setGoldenSearchQuery] = useState<string>('');

  // Autocomplete dropdown state
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const skillInputContainerRef = useRef<HTMLDivElement>(null);
  const skillInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([getCareerBrainData(), linkedInConfigStore.getConfig()]).then(([brainData, configData]) => {
      // Ensure goldenAnswers exists even if user previously had old storage format
      if (!brainData.goldenAnswers || brainData.goldenAnswers.length === 0) {
        brainData.goldenAnswers = DEFAULT_GOLDEN_ANSWERS;
      }
      brainData.goldenAnswers = sortGoldenAnswersByPriority(
        brainData.goldenAnswers.filter(ga => !isSocialMediaOrUrlQuestion(ga.question)),
      );
      if (!brainData.resumeText) {
        brainData.resumeText = DEFAULT_CAREER_BRAIN.resumeText;
      }
      setCareerBrain(brainData);
      // Auto-persist cleaned & sorted golden answers so storage is immediately purged of Facebook/X
      saveCareerBrainData(brainData).catch(() => {});
      // Live-Mode is temporarily hardcode-disabled / locked for safety verification
      setConfig({ ...configData, dryRun: true });
    });

    // Real-time bidirectional synchronization with Side Panel and background storage
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
      if (areaName === 'local' && changes['linkedin_career_brain']?.newValue) {
        const newData = changes['linkedin_career_brain'].newValue as ICareerBrain;
        if (newData.goldenAnswers) {
          newData.goldenAnswers = sortGoldenAnswersByPriority(
            newData.goldenAnswers.filter(ga => !isSocialMediaOrUrlQuestion(ga.question)),
          );
        }
        setCareerBrain(newData);
      }
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    };
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
    setSaveError(null);
    setValidationErrors({});

    // Read latest from storage to preserve non-visible background fields
    const current = await getCareerBrainData();
    const toSave: ICareerBrain = {
      ...current,
      ...careerBrain,
      expectedCTC: careerBrain.expectedCTC || careerBrain.salaryExpectation || '',
      salaryExpectation: careerBrain.salaryExpectation || careerBrain.expectedCTC || '',
      updatedAt: Date.now(),
    };

    // 1. Strict Zod Validation & Safe Storage
    const result = await saveCareerBrainData(toSave);

    if (!result.success) {
      setSaveError(result.error || 'Validation failed. Please correct the highlighted fields.');
      setValidationErrors(result.validationErrors || {});
      return;
    }

    if (result.data) {
      setCareerBrain(result.data);
    }

    // 2. Keep dryRun strictly locked to true for safety
    const safeConfig: ILinkedInAutomationConfig = { ...config, dryRun: true };
    await linkedInConfigStore.updateConfig(safeConfig);

    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3500);
  };

  const handleUpdateGoldenAnswer = (id: string, field: 'question' | 'answer', value: string) => {
    setCareerBrain(prev => ({
      ...prev,
      goldenAnswers: prev.goldenAnswers.map(ga => (ga.id === id ? { ...ga, [field]: value } : ga)),
    }));
    // Clear validation error on type
    const errorKey = `goldenAnswers.${careerBrain.goldenAnswers.findIndex(ga => ga.id === id)}.${field}`;
    if (validationErrors[errorKey]) {
      setValidationErrors(prev => {
        const next = { ...prev };
        delete next[errorKey];
        return next;
      });
    }
  };

  const handleAddGoldenAnswerForCategory = (categoryToUse?: string) => {
    const newId = `custom_${Date.now()}`;
    const targetCategory =
      categoryToUse && categoryToUse !== 'All'
        ? categoryToUse
        : selectedCategoryTab !== 'All'
          ? selectedCategoryTab
          : 'Eligibility / Legal';
    const newItem: IGoldenAnswer = {
      id: newId,
      question: '',
      answer: '',
      category: targetCategory,
      isDefault: false,
    };
    setCareerBrain(prev => ({
      ...prev,
      goldenAnswers: [newItem, ...prev.goldenAnswers],
    }));
  };

  const handleRestoreStandardSuite = () => {
    if (
      window.confirm(
        'Restore the standard 33 Golden Answers covering all 7 categories? Custom rules not in the defaults will be preserved.',
      )
    ) {
      setCareerBrain(prev => {
        const existingCustom = prev.goldenAnswers.filter(ga => !ga.isDefault);
        const merged = [
          ...DEFAULT_GOLDEN_ANSWERS,
          ...existingCustom.filter(
            c => !DEFAULT_GOLDEN_ANSWERS.some(d => d.question.toLowerCase() === c.question.toLowerCase()),
          ),
        ];
        const cleanMerged = sortGoldenAnswersByPriority(merged.filter(ga => !isSocialMediaOrUrlQuestion(ga.question)));
        return {
          ...prev,
          goldenAnswers: cleanMerged,
        };
      });
    }
  };

  const handleRemoveGoldenAnswer = (id: string) => {
    setCareerBrain(prev => ({
      ...prev,
      goldenAnswers: prev.goldenAnswers.filter(ga => ga.id !== id),
    }));
  };

  const getCategoryCount = (category: string) => {
    const valid = careerBrain.goldenAnswers.filter(ga => !isSocialMediaOrUrlQuestion(ga.question));
    if (category === 'All') return valid.length;
    return valid.filter(ga => (ga.category || '').toLowerCase().trim() === category.toLowerCase().trim()).length;
  };

  const getCategoryBadgeClass = (category?: string) => {
    const cat = (category || '').toLowerCase();
    if (cat.includes('eligibility') || cat.includes('legal')) {
      return 'border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300';
    }
    if (cat.includes('location') || cat.includes('relocation')) {
      return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300';
    }
    if (cat.includes('compensation') || cat.includes('salary') || cat.includes('ctc')) {
      return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300';
    }
    if (cat.includes('experience') || cat.includes('education')) {
      return 'border-purple-300 bg-purple-50 text-purple-800 dark:border-purple-800 dark:bg-purple-950/60 dark:text-purple-300';
    }
    if (cat.includes('availability') || cat.includes('shift')) {
      return 'border-cyan-300 bg-cyan-50 text-cyan-800 dark:border-cyan-800 dark:bg-cyan-950/60 dark:text-cyan-300';
    }
    if (cat.includes('yes/no') || cat.includes('screening')) {
      return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-300';
    }
    if (cat.includes('diversity') || cat.includes('self-identification')) {
      return 'border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 dark:border-fuchsia-800 dark:bg-fuchsia-950/60 dark:text-fuchsia-300';
    }
    return 'border-gray-300 bg-gray-50 text-gray-800 dark:border-slate-750 dark:bg-slate-800 dark:text-gray-300';
  };

  const filteredGoldenAnswers = sortGoldenAnswersByPriority(
    careerBrain.goldenAnswers.filter(item => {
      // Always exclude social media handles / URLs from screening questions
      if (isSocialMediaOrUrlQuestion(item.question)) {
        return false;
      }
      // Category filter
      if (selectedCategoryTab !== 'All') {
        const itemCat = (item.category || '').toLowerCase().trim();
        const tabCat = selectedCategoryTab.toLowerCase().trim();
        if (itemCat !== tabCat && !itemCat.includes(tabCat) && !tabCat.includes(itemCat)) {
          return false;
        }
      }
      // Search query filter
      if (goldenSearchQuery.trim()) {
        const qLower = goldenSearchQuery.toLowerCase().trim();
        const questionMatch = (item.question || '').toLowerCase().includes(qLower);
        const answerMatch = (item.answer || '').toLowerCase().includes(qLower);
        const categoryMatch = (item.category || '').toLowerCase().includes(qLower);
        if (!questionMatch && !answerMatch && !categoryMatch) {
          return false;
        }
      }
      return true;
    }),
  );

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

      {/* Floating Animated Success Toast Notification */}
      {saveSuccess && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-xl border border-emerald-300 bg-emerald-50 px-5 py-3.5 shadow-2xl transition-all duration-300 dark:border-emerald-700 dark:bg-emerald-950">
          <div className="rounded-full bg-emerald-500 p-1 text-white">
            <FiCheck className="size-4" />
          </div>
          <div>
            <h5 className="text-sm font-bold text-emerald-900 dark:text-emerald-100">Settings Saved Successfully</h5>
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              Career Brain validated & stored securely in chrome.storage.local
            </p>
          </div>
        </div>
      )}

      {/* Validation Error Banner */}
      {saveError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-800/80 dark:bg-red-950/40">
          <div className="flex items-start gap-3">
            <FiAlertCircle className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
            <div className="flex-1">
              <h5 className="text-sm font-bold text-red-900 dark:text-red-200">Validation Error (Save Blocked)</h5>
              <p className="mt-1 text-xs text-red-700 dark:text-red-300 leading-relaxed">{saveError}</p>
            </div>
            <button
              type="button"
              onClick={() => setSaveError(null)}
              className="text-red-500 hover:text-red-700 dark:hover:text-red-300">
              <FiX className="size-4" />
            </button>
          </div>
        </div>
      )}

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

      {/* Section 0: Candidate Resume (Raw Text for Bedrock AI / Form Filling) */}
      <div
        className={`rounded-xl border ${
          validationErrors.resumeText
            ? 'border-red-300 ring-2 ring-red-400/30 dark:border-red-700'
            : isDarkMode
              ? 'border-slate-700 bg-slate-800'
              : 'border-gray-200 bg-white'
        } space-y-4 p-6 shadow-sm`}>
        <div className="flex items-center justify-between border-b border-gray-100 pb-3 dark:border-gray-700">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-indigo-100 p-2 text-indigo-600 dark:bg-indigo-900/60 dark:text-indigo-300">
              <FiFileText className="size-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-gray-900 dark:text-white">Candidate Resume (Raw Text)</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Paste your full resume text here. The Bedrock AI screening engine reads this content to truthfully
                answer job screening questions.
              </p>
            </div>
          </div>
          <span
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${
              (careerBrain.resumeText || '').length >= 50
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300'
            }`}>
            {(careerBrain.resumeText || '').length} chars{' '}
            {(careerBrain.resumeText || '').length < 50 ? '(Min 50 required)' : '✓ Ready'}
          </span>
        </div>

        <div className="space-y-1.5">
          <textarea
            rows={10}
            value={careerBrain.resumeText || ''}
            onChange={e => {
              setCareerBrain(prev => ({ ...prev, resumeText: e.target.value }));
              if (validationErrors.resumeText) {
                setValidationErrors(prev => {
                  const next = { ...prev };
                  delete next.resumeText;
                  return next;
                });
              }
            }}
            placeholder="Paste plain-text resume here (Summary, Work History, Education, Skills, Projects)..."
            className={`w-full font-mono text-xs leading-relaxed rounded-lg border ${
              validationErrors.resumeText
                ? 'border-red-400 focus:ring-red-500'
                : isDarkMode
                  ? 'border-slate-600 bg-slate-700/80 text-gray-100'
                  : 'border-gray-300 bg-white text-gray-800'
            } p-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500`}
          />
          {validationErrors.resumeText && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1 mt-1">
              <FiAlertCircle className="size-3.5" />
              {validationErrors.resumeText}
            </p>
          )}
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
              Candidate Full Name
            </label>
            <input
              type="text"
              value={careerBrain.fullName || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, fullName: e.target.value }))}
              placeholder="e.g. Mubasshir Ali"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">Gender</label>
            <select
              value={careerBrain.gender || 'Male'}
              onChange={e => setCareerBrain(prev => ({ ...prev, gender: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
              <option value="Prefer not to say">Prefer not to say</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Education & Degree
            </label>
            <input
              type="text"
              value={careerBrain.education || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, education: e.target.value }))}
              placeholder="e.g. B.Tech Computer Science, MAKAUT (2020-2024), CGPA 8.57"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              College / University
            </label>
            <input
              type="text"
              value={careerBrain.college || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, college: e.target.value }))}
              placeholder="e.g. Maulana Abul Kalam Azad University"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              CGPA / Percentage
            </label>
            <input
              type="text"
              value={careerBrain.cgpa || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, cgpa: e.target.value }))}
              placeholder="e.g. 8.57 / 10"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

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
              Current Location (City)
            </label>
            <input
              type="text"
              value={careerBrain.currentLocation || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, currentLocation: e.target.value }))}
              placeholder="e.g. Bengaluru, India"
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
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">Current CTC</label>
            <input
              type="text"
              value={careerBrain.currentCTC || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, currentCTC: e.target.value }))}
              placeholder="e.g. ₹6,00,000"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Expected CTC / Target Salary
            </label>
            <input
              type="text"
              value={careerBrain.expectedCTC || careerBrain.salaryExpectation || ''}
              onChange={e => {
                const val = e.target.value;
                setCareerBrain(prev => ({ ...prev, expectedCTC: val, salaryExpectation: val }));
              }}
              placeholder="e.g. ₹6,00,000 - ₹12,00,000"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Date of Birth (Age 18+ Confirmation)
            </label>
            <input
              type="date"
              value={careerBrain.dateOfBirth || '2000-01-01'}
              onChange={e => setCareerBrain(prev => ({ ...prev, dateOfBirth: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Highest Completed Education
            </label>
            <select
              value={careerBrain.highestEducation || "Bachelor's Degree"}
              onChange={e => setCareerBrain(prev => ({ ...prev, highestEducation: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="High School">High School</option>
              <option value="Associate's Degree">Associate's Degree</option>
              <option value="Bachelor's Degree">Bachelor's Degree</option>
              <option value="Master's Degree">Master's Degree</option>
              <option value="Doctorate / PhD">Doctorate / PhD</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Willing to Relocate?
            </label>
            <select
              value={careerBrain.willingToRelocate || 'Yes'}
              onChange={e => setCareerBrain(prev => ({ ...prev, willingToRelocate: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
              <option value="Negotiable">Negotiable</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Preferred Work Shift
            </label>
            <select
              value={careerBrain.preferredShift || 'Day / Flexible'}
              onChange={e => setCareerBrain(prev => ({ ...prev, preferredShift: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="Day / Flexible">Day / Flexible</option>
              <option value="Day Shift">Day Shift</option>
              <option value="Night Shift">Night Shift</option>
              <option value="Rotational / Any">Rotational / Any</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Valid Driver's License
            </label>
            <select
              value={careerBrain.driverLicense || 'Yes'}
              onChange={e => setCareerBrain(prev => ({ ...prev, driverLicense: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Veteran Status (Self-Identification)
            </label>
            <select
              value={careerBrain.veteranStatus || 'I am not a protected veteran'}
              onChange={e => setCareerBrain(prev => ({ ...prev, veteranStatus: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="I am not a protected veteran">I am not a protected veteran</option>
              <option value="I identify as a protected veteran">I identify as a protected veteran</option>
              <option value="I choose not to self-identify">I choose not to self-identify</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Disability Status (Self-Identification)
            </label>
            <select
              value={careerBrain.disabilityStatus || 'No, I do not have a disability'}
              onChange={e => setCareerBrain(prev => ({ ...prev, disabilityStatus: e.target.value }))}
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}>
              <option value="No, I do not have a disability">No, I do not have a disability</option>
              <option value="Yes, I have a disability">Yes, I have a disability</option>
              <option value="I choose not to specify">I choose not to specify</option>
            </select>
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

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              GitHub Profile URL
            </label>
            <input
              type="url"
              value={careerBrain.githubUrl || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, githubUrl: e.target.value }))}
              placeholder="e.g. https://github.com/username"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              Portfolio / Website URL
            </label>
            <input
              type="url"
              value={careerBrain.portfolioUrl || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, portfolioUrl: e.target.value }))}
              placeholder="e.g. https://myportfolio.dev"
              className={`w-full rounded-md border ${
                isDarkMode ? 'border-slate-600 bg-slate-700 text-gray-100' : 'border-gray-300 bg-white text-gray-800'
              } px-3 py-2 text-sm`}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
              LinkedIn Profile URL
            </label>
            <input
              type="url"
              value={careerBrain.linkedinUrl || ''}
              onChange={e => setCareerBrain(prev => ({ ...prev, linkedinUrl: e.target.value }))}
              placeholder="e.g. https://linkedin.com/in/username"
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

      {/* Section 2.5: Golden Q&A Screening Answers */}
      <div
        className={`rounded-xl border ${
          isDarkMode ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white'
        } space-y-5 p-6 shadow-sm`}>
        {/* Header & Main Actions */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-100 pb-4 dark:border-gray-700">
          <div className="flex items-center gap-2.5">
            <div className="rounded-lg bg-amber-100 p-2 text-amber-600 dark:bg-amber-900/60 dark:text-amber-300">
              <FiHelpCircle className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-gray-900 dark:text-white">
                  Golden Q&A — Screening Answer Bank
                </h3>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
                  {careerBrain.goldenAnswers.length} Rules
                </span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Ground-truth screening answers categorized across Eligibility, Location, Compensation, Experience,
                Availability, Screening, and Diversity.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRestoreStandardSuite}
              title="Reset or update all standard screening rules across all 7 categories"
              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${
                isDarkMode
                  ? 'border-slate-600 bg-slate-700 text-gray-200 hover:bg-slate-650'
                  : 'border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100'
              }`}>
              <FiRotateCcw className="size-3.5 text-amber-500" />
              Restore 33 Standard Defaults
            </button>
            <button
              type="button"
              onClick={() => handleAddGoldenAnswerForCategory()}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-amber-700 cursor-pointer">
              <FiPlus className="size-3.5" />
              Add Custom Rule
            </button>
          </div>
        </div>

        {/* Category Tabs & Real-time Search Filter */}
        <div className="space-y-3">
          {/* Category Tabs */}
          <div className="flex flex-wrap gap-1.5">
            {['All', ...GOLDEN_ANSWER_CATEGORIES].map(cat => {
              const count = getCategoryCount(cat);
              const isActive = selectedCategoryTab === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategoryTab(cat)}
                  className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                    isActive
                      ? 'bg-amber-600 text-white font-semibold shadow-xs'
                      : isDarkMode
                        ? 'bg-slate-700 text-gray-300 hover:bg-slate-650'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}>
                  <span>{cat}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                      isActive
                        ? 'bg-white/20 text-white'
                        : isDarkMode
                          ? 'bg-slate-800 text-gray-400'
                          : 'bg-gray-200 text-gray-600'
                    }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search bar & quick stats */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <FiSearch className="absolute left-3 top-2.5 size-3.5 text-gray-400" />
              <input
                type="text"
                value={goldenSearchQuery}
                onChange={e => setGoldenSearchQuery(e.target.value)}
                placeholder="Search screening questions, answers, or keywords (e.g. visa, ctc, driver, relocation, shift)..."
                className={`w-full rounded-lg border pl-9 pr-8 py-1.5 text-xs outline-none ${
                  isDarkMode
                    ? 'border-slate-600 bg-slate-700 text-gray-100 placeholder:text-gray-400'
                    : 'border-gray-300 bg-gray-50 text-gray-800 placeholder:text-gray-400'
                }`}
              />
              {goldenSearchQuery && (
                <button
                  type="button"
                  onClick={() => setGoldenSearchQuery('')}
                  className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
                  <FiX className="size-3.5" />
                </button>
              )}
            </div>
            {selectedCategoryTab !== 'All' && (
              <button
                type="button"
                onClick={() => setSelectedCategoryTab('All')}
                className="text-xs text-amber-600 hover:underline dark:text-amber-400 shrink-0">
                Clear filter
              </button>
            )}
          </div>
        </div>

        {/* Cards List */}
        <div className="space-y-3">
          {filteredGoldenAnswers.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-slate-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                No screening questions match the current filter "{selectedCategoryTab}"
                {goldenSearchQuery ? ` and query "${goldenSearchQuery}"` : ''}.
              </p>
              <button
                type="button"
                onClick={() => handleAddGoldenAnswerForCategory(selectedCategoryTab)}
                className="mt-2 text-xs font-semibold text-amber-600 hover:underline dark:text-amber-400 cursor-pointer">
                + Add rule to {selectedCategoryTab}
              </button>
            </div>
          ) : (
            filteredGoldenAnswers.map((item, index) => {
              const originalIndex = careerBrain.goldenAnswers.findIndex(ga => ga.id === item.id);
              const hasQError = validationErrors[`goldenAnswers.${originalIndex}.question`];
              const hasAError = validationErrors[`goldenAnswers.${originalIndex}.answer`];

              return (
                <div
                  key={item.id}
                  className={`rounded-lg border ${
                    hasQError || hasAError
                      ? 'border-red-300 bg-red-50/40 dark:border-red-800 dark:bg-red-950/20'
                      : isDarkMode
                        ? 'border-slate-700/80 bg-slate-750'
                        : 'border-gray-200 bg-gray-50/50'
                  } p-3.5 transition-all`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-1 space-y-2.5">
                      {/* Top bar: Priority Rank & Category Pill */}
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                            Priority #{index + 1}
                          </span>
                          {item.category && (
                            <span
                              className={`rounded-md border px-2 py-0.5 text-[11px] font-medium ${getCategoryBadgeClass(
                                item.category,
                              )}`}>
                              {item.category}
                            </span>
                          )}
                        </div>
                        {item.isDefault ? (
                          <span className="rounded bg-gray-200/60 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-slate-700 dark:text-gray-300">
                            Standard Recommended
                          </span>
                        ) : (
                          <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
                            Custom Added
                          </span>
                        )}
                      </div>

                      {/* Question */}
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
                          Question / Screening Prompt
                        </label>
                        <input
                          type="text"
                          value={item.question}
                          onChange={e => handleUpdateGoldenAnswer(item.id, 'question', e.target.value)}
                          placeholder="e.g. Do you require visa sponsorship?"
                          className={`w-full rounded-md border ${
                            hasQError
                              ? 'border-red-400'
                              : isDarkMode
                                ? 'border-slate-600 bg-slate-700 text-gray-100'
                                : 'border-gray-300 bg-white text-gray-800'
                          } px-3 py-1.5 text-xs`}
                        />
                        {hasQError && <p className="mt-0.5 text-[11px] text-red-500">{hasQError}</p>}
                      </div>

                      {/* Answer */}
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-gray-700 dark:text-gray-300">
                          Exact Ground-Truth Answer
                        </label>
                        <input
                          type="text"
                          value={item.answer}
                          onChange={e => handleUpdateGoldenAnswer(item.id, 'answer', e.target.value)}
                          placeholder="e.g. Yes / No / Immediate / ₹10,00,000"
                          className={`w-full rounded-md border ${
                            hasAError
                              ? 'border-red-400'
                              : isDarkMode
                                ? 'border-slate-600 bg-slate-700 text-gray-100'
                                : 'border-gray-300 bg-white text-gray-800'
                          } px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300`}
                        />
                        {hasAError && <p className="mt-0.5 text-[11px] text-red-500">{hasAError}</p>}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveGoldenAnswer(item.id)}
                      title="Remove rule"
                      className="mt-6 text-gray-400 transition-colors hover:text-red-500 focus:outline-none cursor-pointer">
                      <FiTrash2 className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })
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
