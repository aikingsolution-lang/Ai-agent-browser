import React, { useState } from 'react';
import { JobTitleAutocompleteInput } from './JobTitleAutocompleteInput';
import { FiPlus, FiTrash2, FiStar, FiZap, FiCheck, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import type { ICareerBrain } from '@extension/storage';

export interface MultipleJobRolesInputProps {
  roles: string[];
  primaryRole?: string;
  onChange: (roles: string[], primaryRole: string) => void;
  isDarkMode?: boolean;
  maxRoles?: number;
  careerBrain?: ICareerBrain;
}

/**
 * Multiple Job Roles Management Component
 * Allows candidates to specify up to 5 prioritized target job titles
 * (e.g. "AWS DevOps Engineer", "DevOps Engineer", "Cloud Engineer").
 * Integrates zero-hallucination AI role suggestion grounded in resume & skills.
 */
export function MultipleJobRolesInput({
  roles = [],
  primaryRole,
  onChange,
  isDarkMode = false,
  maxRoles = 5,
  careerBrain,
}: MultipleJobRolesInputProps) {
  const [newRoleInput, setNewRoleInput] = useState('');
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [suggestedRoles, setSuggestedRoles] = useState<string[]>([]);
  const [suggestError, setSuggestError] = useState<string | null>(null);

  // Normalize roles: filter empties & duplicates
  const currentRoles = Array.from(new Set(roles.map(r => r.trim()).filter(Boolean)));
  const effectivePrimary = primaryRole && currentRoles.includes(primaryRole) ? primaryRole : currentRoles[0] || '';

  const handleAddRole = (titleToAdd?: string) => {
    const raw = (titleToAdd || newRoleInput).trim();
    if (!raw) return;

    // Check duplicate (case-insensitive)
    const exists = currentRoles.some(r => r.toLowerCase() === raw.toLowerCase());
    if (exists) {
      if (!titleToAdd) setNewRoleInput('');
      return;
    }

    if (currentRoles.length >= maxRoles) {
      return;
    }

    const updated = [...currentRoles, raw];
    const newPrimary = effectivePrimary || raw;
    onChange(updated, newPrimary);
    if (!titleToAdd) setNewRoleInput('');
  };

  const handleRemoveRole = (index: number) => {
    const roleToRemove = currentRoles[index];
    const updated = currentRoles.filter((_, i) => i !== index);
    let nextPrimary = effectivePrimary;
    if (roleToRemove === effectivePrimary) {
      nextPrimary = updated[0] || '';
    }
    onChange(updated, nextPrimary);
  };

  const handleSetPrimary = (role: string) => {
    if (!currentRoles.includes(role)) return;
    // Put primary role first in the array for convenience
    const updated = [role, ...currentRoles.filter(r => r !== role)];
    onChange(updated, role);
  };

  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    const updated = [...currentRoles];
    const temp = updated[index - 1];
    updated[index - 1] = updated[index];
    updated[index] = temp;
    onChange(updated, updated[0]);
  };

  const handleMoveDown = (index: number) => {
    if (index >= currentRoles.length - 1) return;
    const updated = [...currentRoles];
    const temp = updated[index + 1];
    updated[index + 1] = updated[index];
    updated[index] = temp;
    onChange(updated, updated[0]);
  };

  const handleAiSuggest = async () => {
    setIsSuggesting(true);
    setSuggestError(null);
    try {
      const response = await new Promise<any>((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'SUGGEST_TARGET_ROLES',
            currentTitle: effectivePrimary,
            resumeText: careerBrain?.resumeText || '',
            skills: careerBrain?.skills || [],
            yearsOfExperience: careerBrain?.yearsOfExperience || 0,
          },
          res => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(res);
            }
          },
        );
      });

      if (response && response.success && Array.isArray(response.roles)) {
        setSuggestedRoles(response.roles);
      } else {
        setSuggestError(response?.error || 'Could not suggest roles. Ensure resume text or skills are filled.');
      }
    } catch (err: any) {
      setSuggestError(err?.message || 'Failed to communicate with AI engine.');
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleAddAllSuggestions = () => {
    const availableSlots = maxRoles - currentRoles.length;
    if (availableSlots <= 0) return;

    const toAdd = suggestedRoles
      .filter(s => !currentRoles.some(r => r.toLowerCase() === s.toLowerCase()))
      .slice(0, availableSlots);

    if (toAdd.length === 0) return;

    const updated = [...currentRoles, ...toAdd];
    onChange(updated, effectivePrimary || updated[0]);
  };

  return (
    <div className="space-y-2.5">
      {/* Header with Title & AI Suggestion Button */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-[11px] font-semibold opacity-80">
            Target Job Roles{' '}
            <span className="text-[9px] font-normal text-sky-400">
              ({currentRoles.length}/{maxRoles})
            </span>
          </label>
        </div>
        <button
          type="button"
          onClick={handleAiSuggest}
          disabled={isSuggesting}
          className={`inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-0.5 text-[10px] font-semibold transition-all ${
            isSuggesting
              ? 'cursor-not-allowed bg-sky-900/30 text-sky-300 opacity-60'
              : isDarkMode
                ? 'border border-sky-500/30 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                : 'border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100'
          }`}
          title="Analyze resume and skills to suggest matching roles">
          {isSuggesting ? (
            <>
              <AiOutlineLoading3Quarters className="size-2.5 animate-spin text-sky-400" />
              <span>Analyzing...</span>
            </>
          ) : (
            <>
              <FiZap className="size-2.5 text-amber-400" />
              <span>✨ AI Suggest Roles</span>
            </>
          )}
        </button>
      </div>

      {/* AI Suggestion Pills Drawer */}
      {suggestedRoles.length > 0 && (
        <div
          className={`space-y-2 rounded-lg border p-2.5 text-xs ${
            isDarkMode ? 'border-sky-800/80 bg-sky-950/20' : 'border-sky-200 bg-sky-50/50'
          }`}>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[10px] font-bold text-sky-400">
              <span>🎯</span> AI Recommended for Your Profile:
            </span>
            {currentRoles.length < maxRoles && (
              <button
                type="button"
                onClick={handleAddAllSuggestions}
                className="cursor-pointer text-[10px] font-semibold text-emerald-400 underline hover:text-emerald-300">
                + Add All
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {suggestedRoles.map((sRole, sIdx) => {
              const isAlreadyAdded = currentRoles.some(r => r.toLowerCase() === sRole.toLowerCase());
              return (
                <button
                  key={sIdx}
                  type="button"
                  onClick={() => !isAlreadyAdded && handleAddRole(sRole)}
                  disabled={isAlreadyAdded || currentRoles.length >= maxRoles}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    isAlreadyAdded
                      ? isDarkMode
                        ? 'cursor-default border border-gray-700 bg-slate-800 text-gray-500'
                        : 'cursor-default border border-gray-200 bg-gray-100 text-gray-400'
                      : isDarkMode
                        ? 'cursor-pointer border border-sky-700/60 bg-slate-800 text-sky-200 hover:bg-sky-900/60'
                        : 'cursor-pointer border border-sky-300 bg-white text-sky-800 shadow-sm hover:bg-sky-50'
                  }`}>
                  {isAlreadyAdded ? (
                    <FiCheck className="size-3 text-emerald-400" />
                  ) : (
                    <FiPlus className="size-3 text-sky-400" />
                  )}
                  <span>{sRole}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {suggestError && (
        <div className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-400">
          ⚠️ {suggestError}
        </div>
      )}

      {/* Selected Target Roles List */}
      <div className="space-y-1.5">
        {currentRoles.length === 0 ? (
          <div
            className={`rounded-lg border border-dashed px-3 py-2 text-center text-[11px] opacity-60 ${
              isDarkMode ? 'border-gray-700' : 'border-gray-300'
            }`}>
            No target roles added yet. Add a role below or use AI suggestions.
          </div>
        ) : (
          currentRoles.map((role, index) => {
            const isPrimary = role === effectivePrimary;
            return (
              <div
                key={index}
                className={`flex items-center justify-between rounded-lg border p-2 transition-all ${
                  isPrimary
                    ? isDarkMode
                      ? 'border-emerald-700/60 bg-emerald-950/25 shadow-sm'
                      : 'border-emerald-300 bg-emerald-50/60 shadow-sm'
                    : isDarkMode
                      ? 'border-sky-900/40 bg-slate-900/50 hover:border-sky-800'
                      : 'border-sky-100 bg-white hover:border-sky-200'
                }`}>
                <div className="mr-2 flex min-w-0 flex-1 items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => handleSetPrimary(role)}
                    title={isPrimary ? 'Primary target role' : 'Click to make primary role'}
                    className={`cursor-pointer rounded p-0.5 transition-colors ${
                      isPrimary
                        ? 'text-amber-400 hover:text-amber-300'
                        : isDarkMode
                          ? 'text-gray-600 hover:text-amber-400'
                          : 'text-gray-300 hover:text-amber-500'
                    }`}>
                    <FiStar className={`size-3.5 ${isPrimary ? 'fill-amber-400 text-amber-400' : ''}`} />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-semibold" title={role}>
                        {role}
                      </span>
                      {isPrimary && (
                        <span className="py-0.2 shrink-0 rounded border border-emerald-500/30 bg-emerald-500/20 px-1.5 text-[9px] font-bold text-emerald-400">
                          Primary
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Actions: Reorder & Remove */}
                <div className="flex shrink-0 items-center space-x-1">
                  {currentRoles.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleMoveUp(index)}
                        disabled={index === 0}
                        title="Move up"
                        className={`cursor-pointer rounded p-1 transition-colors ${
                          index === 0
                            ? 'cursor-not-allowed opacity-20'
                            : isDarkMode
                              ? 'text-gray-400 hover:bg-slate-800 hover:text-white'
                              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                        }`}>
                        <FiArrowUp className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveDown(index)}
                        disabled={index === currentRoles.length - 1}
                        title="Move down"
                        className={`cursor-pointer rounded p-1 transition-colors ${
                          index === currentRoles.length - 1
                            ? 'cursor-not-allowed opacity-20'
                            : isDarkMode
                              ? 'text-gray-400 hover:bg-slate-800 hover:text-white'
                              : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                        }`}>
                        <FiArrowDown className="size-3" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveRole(index)}
                    title="Remove role"
                    className="cursor-pointer rounded p-1 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300">
                    <FiTrash2 className="size-3" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Autocomplete Input to Add Custom Role */}
      {currentRoles.length < maxRoles && (
        <div className="flex items-center space-x-1.5 pt-0.5">
          <div className="flex-1">
            <JobTitleAutocompleteInput
              value={newRoleInput}
              onChange={val => setNewRoleInput(val)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddRole();
                }
              }}
              isDarkMode={isDarkMode}
              placeholder="Type role (e.g. AWS DevOps, Backend, Cloud)..."
              className={`w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none ${
                isDarkMode
                  ? 'border-sky-800 bg-slate-900 text-white focus:border-sky-500'
                  : 'border-sky-200 bg-white text-gray-900 focus:border-sky-400'
              }`}
            />
          </div>
          <button
            type="button"
            onClick={() => handleAddRole()}
            disabled={!newRoleInput.trim()}
            className={`inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
              newRoleInput.trim()
                ? 'bg-sky-500 text-white hover:bg-sky-400'
                : 'cursor-not-allowed bg-sky-500/20 text-sky-400 opacity-40'
            }`}>
            <FiPlus className="size-3.5" />
            <span>Add</span>
          </button>
        </div>
      )}

      {/* Footer Helper Note */}
      <p className="text-[10px] leading-tight opacity-60">
        💡 Multi-role targeting enables JobForm Automator to discover and apply for jobs matching any of these roles
        across Naukri, Indeed, and LinkedIn. The primary role is starred ⭐.
      </p>
    </div>
  );
}
