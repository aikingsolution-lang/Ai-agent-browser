import React, { useState } from 'react';
import {
  FiCheckCircle,
  FiCopy,
  FiCheck,
  FiAward,
  FiAlertCircle,
  FiArrowRight,
  FiZap,
  FiFileText,
} from 'react-icons/fi';
import type { CopilotActionCard } from '@extension/storage';

interface CopilotCardProps {
  card?: CopilotActionCard;
  quickOptions?: string[];
  onSelectOption?: (option: string) => void;
  isDarkMode?: boolean;
}

export const CopilotCard: React.FC<CopilotCardProps> = ({ card, quickOptions, onSelectOption, isDarkMode = false }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-2.5 space-y-2.5 text-xs">
      {/* ─── 1. Profile Updated Card ─── */}
      {card?.type === 'profile_updated' && (
        <div
          className={`rounded-xl border p-3 shadow-md transition-all ${
            isDarkMode
              ? 'border-emerald-500/40 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-900 text-emerald-200'
              : 'border-emerald-300 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/30 text-emerald-900'
          }`}>
          <div className="flex items-center justify-between pb-2 border-b border-emerald-500/20">
            <div className="flex items-center space-x-1.5 font-bold">
              <FiCheckCircle className="size-4 text-emerald-400" />
              <span>Career Brain Auto-Updated</span>
            </div>
            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              Saved
            </span>
          </div>

          {/* Updated Fields List */}
          {Array.isArray(card.data?.updatedFields) && card.data.updatedFields.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {card.data.updatedFields.map((f: any, idx: number) => (
                <div
                  key={idx}
                  className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 font-mono text-[11px] ${
                    isDarkMode ? 'bg-emerald-900/20 border border-emerald-800/40' : 'bg-white border border-emerald-200'
                  }`}>
                  <span className="font-sans font-medium text-emerald-400">{f.label || f.field}:</span>
                  <span className="font-semibold">{String(f.value)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Profile Completeness Bar */}
          {typeof card.data?.profileCompleteness === 'number' && (
            <div className="mt-2.5 pt-2 border-t border-emerald-500/20">
              <div className="flex justify-between text-[10px] font-semibold mb-1">
                <span>Profile Readiness</span>
                <span className="text-emerald-400">{card.data.profileCompleteness}% Complete</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-700/40 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-700"
                  style={{ width: `${card.data.profileCompleteness}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── 2. Job Fit Report Card ─── */}
      {card?.type === 'job_fit' && card.data?.fitReport && (
        <div
          className={`rounded-xl border p-3.5 shadow-lg transition-all ${
            isDarkMode
              ? 'border-indigo-500/40 bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-900 text-indigo-100'
              : 'border-indigo-200 bg-gradient-to-br from-indigo-50/80 via-white to-sky-50 text-indigo-950'
          }`}>
          <div className="flex items-center justify-between pb-2 border-b border-indigo-500/20">
            <div className="flex items-center space-x-1.5 font-bold">
              <FiAward className="size-4 text-indigo-400" />
              <span>Job Match Analysis</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider ${
                  card.data.fitReport.matchScore >= 75
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : card.data.fitReport.matchScore >= 50
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                      : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                }`}>
                {card.data.fitReport.matchScore}% Match
              </span>
            </div>
          </div>

          {/* Matching Skills */}
          {card.data.fitReport.matchingSkills?.length > 0 && (
            <div className="mt-2.5">
              <span className="text-[10px] uppercase font-bold tracking-wider opacity-75">Verified Strengths:</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {card.data.fitReport.matchingSkills.map((s: string, idx: number) => (
                  <span
                    key={idx}
                    className="inline-flex items-center rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                    <FiCheck className="mr-1 size-2.5 text-emerald-400" />
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Missing Keywords / Gaps */}
          {card.data.fitReport.missingSkills?.length > 0 && (
            <div className="mt-2.5">
              <span className="text-[10px] uppercase font-bold tracking-wider opacity-75">
                Missing Keywords / Gaps:
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {card.data.fitReport.missingSkills.map((s: string, idx: number) => (
                  <span
                    key={idx}
                    className="inline-flex items-center rounded-md bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[10px] font-medium text-rose-300">
                    <FiAlertCircle className="mr-1 size-2.5 text-rose-400" />
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actionable Tip */}
          {card.data.fitReport.actionableTip && (
            <div
              className={`mt-3 rounded-lg p-2.5 text-[11px] leading-relaxed flex items-start space-x-2 ${
                isDarkMode
                  ? 'bg-indigo-900/30 border border-indigo-700/40'
                  : 'bg-indigo-100/60 border border-indigo-200'
              }`}>
              <FiZap className="size-3.5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-indigo-300">Hiring Strategy: </span>
                <span>{card.data.fitReport.actionableTip}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── 3. Dynamic Cover Letter Card ─── */}
      {card?.type === 'cover_letter' && card.data?.coverLetter && (
        <div
          className={`rounded-xl border p-3.5 shadow-lg transition-all ${
            isDarkMode
              ? 'border-purple-500/40 bg-gradient-to-br from-purple-950/40 via-slate-900 to-slate-900 text-purple-100'
              : 'border-purple-200 bg-gradient-to-br from-purple-50 via-white to-pink-50 text-purple-950'
          }`}>
          <div className="flex items-center justify-between pb-2 border-b border-purple-500/20">
            <div className="flex items-center space-x-1.5 font-bold">
              <FiFileText className="size-4 text-purple-400" />
              <span>Tailored Cover Letter</span>
            </div>
            <button
              onClick={() => handleCopy(card.data.coverLetter)}
              className="flex items-center space-x-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 border border-purple-500/40 px-2.5 py-1 text-[11px] font-semibold text-purple-300 transition-all cursor-pointer">
              {copied ? (
                <>
                  <FiCheck className="size-3 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <FiCopy className="size-3" />
                  <span>Copy Letter</span>
                </>
              )}
            </button>
          </div>

          <div
            className={`mt-2.5 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 text-[11px] leading-relaxed font-sans ${
              isDarkMode
                ? 'bg-purple-950/20 border border-purple-800/30 text-slate-200'
                : 'bg-white border border-purple-100 text-slate-800 shadow-inner'
            }`}>
            {card.data.coverLetter}
          </div>
        </div>
      )}

      {/* ─── 4. Tailored Application Pitch Card ─── */}
      {card?.type === 'pitch' && card.data?.pitch && (
        <div
          className={`rounded-xl border p-3.5 shadow-lg transition-all ${
            isDarkMode
              ? 'border-pink-500/40 bg-gradient-to-br from-pink-950/40 via-slate-900 to-slate-900 text-pink-100'
              : 'border-pink-200 bg-gradient-to-br from-pink-50/80 via-white to-purple-50 text-pink-950'
          }`}>
          <div className="flex items-center justify-between pb-2 border-b border-pink-500/20">
            <div className="flex items-center space-x-1.5 font-bold">
              <FiZap className="size-4 text-pink-400" />
              <span>Tailored Recruiter Application Pitch</span>
            </div>
            <button
              onClick={() => handleCopy(card.data.pitch)}
              className="flex items-center space-x-1 rounded-md bg-pink-500/20 hover:bg-pink-500/30 border border-pink-500/40 px-2 py-1 text-[10px] font-semibold text-pink-300 transition-all cursor-pointer">
              {copied ? (
                <>
                  <FiCheck className="size-3 text-emerald-400" />
                  <span className="text-emerald-400">Copied!</span>
                </>
              ) : (
                <>
                  <FiCopy className="size-3" />
                  <span>Copy Note</span>
                </>
              )}
            </button>
          </div>

          <div
            className={`mt-2.5 rounded-lg p-3 text-[11px] leading-relaxed font-sans italic ${
              isDarkMode ? 'bg-pink-900/20 border border-pink-800/40' : 'bg-white border border-pink-200'
            }`}>
            "{card.data.pitch}"
          </div>
        </div>
      )}

      {/* ─── 5. Quick Options / Interactive Pill Buttons ─── */}
      {quickOptions && quickOptions.length > 0 && onSelectOption && (
        <div className="pt-1">
          <div className="flex items-center space-x-1 mb-1.5 text-[10px] font-semibold opacity-70">
            <FiArrowRight className="size-2.5" />
            <span>Suggested replies & actions:</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickOptions.map((opt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelectOption(opt)}
                className={`cursor-pointer rounded-full px-3 py-1 text-[11px] font-semibold transition-all hover:scale-105 active:scale-95 shadow-sm ${
                  isDarkMode
                    ? 'border border-sky-500/40 bg-slate-800/90 text-sky-300 hover:bg-sky-600 hover:text-white'
                    : 'border border-sky-300 bg-sky-50 text-sky-700 hover:bg-sky-600 hover:text-white'
                }`}>
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
