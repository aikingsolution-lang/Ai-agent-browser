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
  /** Class for the current theme (light colors must stay readable on the light panel). */
  const tone = (dark: string, light: string) => (isDarkMode ? dark : light);

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copiedLabel = (
    <>
      <FiCheck className={`size-3 ${tone('text-emerald-300', 'text-emerald-700')}`} />
      <span className={tone('text-emerald-300', 'text-emerald-700')}>Copied</span>
    </>
  );

  return (
    <div className="mt-2.5 space-y-2.5 text-xs">
      {/* ─── 1. Profile Updated Card ─── */}
      {card?.type === 'profile_updated' && (
        <div
          className={`rounded-xl border p-3 shadow-sm transition-all ${tone(
            'border-emerald-500/40 bg-gradient-to-br from-emerald-950/40 via-slate-900 to-slate-900 text-emerald-200',
            'border-emerald-200 bg-white text-slate-800',
          )}`}>
          <div
            className={`flex items-center justify-between pb-2 border-b ${tone('border-emerald-500/20', 'border-slate-100')}`}>
            <div className="flex items-center space-x-1.5 font-bold">
              <FiCheckCircle className={`size-4 ${tone('text-emerald-400', 'text-emerald-600')}`} />
              <span>Profile updated</span>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone(
                'bg-emerald-500/20 text-emerald-300',
                'bg-emerald-50 text-emerald-700 border border-emerald-200',
              )}`}>
              Saved
            </span>
          </div>

          {/* Updated Fields List */}
          {Array.isArray(card.data?.updatedFields) && card.data.updatedFields.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {card.data.updatedFields.map((f: any, idx: number) => (
                <div
                  key={idx}
                  className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ${tone(
                    'bg-emerald-900/20 border border-emerald-800/40',
                    'bg-slate-50 border border-slate-200',
                  )}`}>
                  <span className={`font-medium ${tone('text-emerald-300', 'text-slate-600')}`}>
                    {f.label || f.field}
                  </span>
                  <span className="font-semibold text-right">{String(f.value)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Profile Completeness Bar */}
          {typeof card.data?.profileCompleteness === 'number' && (
            <div className={`mt-2.5 pt-2 border-t ${tone('border-emerald-500/20', 'border-slate-100')}`}>
              <div className="flex justify-between text-[10px] font-semibold mb-1">
                <span>Profile readiness</span>
                <span className={tone('text-emerald-300', 'text-emerald-700')}>{card.data.profileCompleteness}%</span>
              </div>
              <div className={`h-1.5 w-full rounded-full overflow-hidden ${tone('bg-slate-700/40', 'bg-slate-200')}`}>
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-700"
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
          className={`rounded-xl border p-3.5 shadow-sm transition-all ${tone(
            'border-indigo-500/40 bg-gradient-to-br from-indigo-950/40 via-slate-900 to-slate-900 text-indigo-100',
            'border-slate-200 bg-white text-slate-800',
          )}`}>
          <div
            className={`flex items-center justify-between pb-2 border-b ${tone('border-indigo-500/20', 'border-slate-100')}`}>
            <div className="flex items-center space-x-1.5 font-bold">
              <FiAward className={`size-4 ${tone('text-indigo-400', 'text-indigo-600')}`} />
              <span>Job match</span>
            </div>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold border ${
                card.data.fitReport.matchScore >= 75
                  ? tone(
                      'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
                      'bg-emerald-50 text-emerald-700 border-emerald-200',
                    )
                  : card.data.fitReport.matchScore >= 50
                    ? tone(
                        'bg-amber-500/20 text-amber-300 border-amber-500/40',
                        'bg-amber-50 text-amber-700 border-amber-200',
                      )
                    : tone(
                        'bg-rose-500/20 text-rose-300 border-rose-500/40',
                        'bg-rose-50 text-rose-700 border-rose-200',
                      )
              }`}>
              {card.data.fitReport.matchScore}% match
            </span>
          </div>

          {/* Matching Skills */}
          {card.data.fitReport.matchingSkills?.length > 0 && (
            <div className="mt-2.5">
              <span className={`text-[11px] font-semibold ${tone('text-slate-300', 'text-slate-600')}`}>
                Matching skills
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {card.data.fitReport.matchingSkills.map((s: string, idx: number) => (
                  <span
                    key={idx}
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${tone(
                      'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
                      'bg-emerald-50 border-emerald-200 text-emerald-800',
                    )}`}>
                    <FiCheck className={`mr-1 size-2.5 ${tone('text-emerald-400', 'text-emerald-600')}`} />
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Missing Keywords / Gaps */}
          {card.data.fitReport.missingSkills?.length > 0 && (
            <div className="mt-2.5">
              <span className={`text-[11px] font-semibold ${tone('text-slate-300', 'text-slate-600')}`}>
                Missing skills
              </span>
              <div className="mt-1 flex flex-wrap gap-1">
                {card.data.fitReport.missingSkills.map((s: string, idx: number) => (
                  <span
                    key={idx}
                    className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-medium ${tone(
                      'bg-rose-500/15 border-rose-500/30 text-rose-300',
                      'bg-rose-50 border-rose-200 text-rose-800',
                    )}`}>
                    <FiAlertCircle className={`mr-1 size-2.5 ${tone('text-rose-400', 'text-rose-600')}`} />
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actionable Tip */}
          {card.data.fitReport.actionableTip && (
            <div
              className={`mt-3 rounded-lg p-2.5 text-[11px] leading-relaxed flex items-start space-x-2 ${tone(
                'bg-indigo-900/30 border border-indigo-700/40',
                'bg-slate-50 border border-slate-200',
              )}`}>
              <FiZap className={`size-3.5 shrink-0 mt-0.5 ${tone('text-amber-400', 'text-amber-600')}`} />
              <div>
                <span className={`font-bold ${tone('text-indigo-300', 'text-slate-900')}`}>Tip: </span>
                <span>{card.data.fitReport.actionableTip}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── 3. Dynamic Cover Letter Card ─── */}
      {card?.type === 'cover_letter' && card.data?.coverLetter && (
        <div
          className={`rounded-xl border p-3.5 shadow-sm transition-all ${tone(
            'border-purple-500/40 bg-gradient-to-br from-purple-950/40 via-slate-900 to-slate-900 text-purple-100',
            'border-slate-200 bg-white text-slate-800',
          )}`}>
          <div
            className={`flex items-center justify-between pb-2 border-b ${tone('border-purple-500/20', 'border-slate-100')}`}>
            <div className="flex items-center space-x-1.5 font-bold">
              <FiFileText className={`size-4 ${tone('text-purple-400', 'text-violet-600')}`} />
              <span>Cover letter</span>
            </div>
            <button
              onClick={() => handleCopy(card.data.coverLetter)}
              className={`flex items-center space-x-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${tone(
                'bg-purple-500/20 hover:bg-purple-500/30 border-purple-500/40 text-purple-200',
                'bg-white hover:bg-slate-50 border-slate-300 text-slate-700',
              )}`}>
              {copied ? (
                copiedLabel
              ) : (
                <>
                  <FiCopy className="size-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          <div
            className={`mt-2.5 max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg p-3 text-[11px] leading-relaxed font-sans ${tone(
              'bg-purple-950/20 border border-purple-800/30 text-slate-200',
              'bg-slate-50 border border-slate-200 text-slate-800',
            )}`}>
            {card.data.coverLetter}
          </div>
        </div>
      )}

      {/* ─── 4. Tailored Application Pitch Card ─── */}
      {card?.type === 'pitch' && card.data?.pitch && (
        <div
          className={`rounded-xl border p-3.5 shadow-sm transition-all ${tone(
            'border-pink-500/40 bg-gradient-to-br from-pink-950/40 via-slate-900 to-slate-900 text-pink-100',
            'border-slate-200 bg-white text-slate-800',
          )}`}>
          <div
            className={`flex items-center justify-between pb-2 border-b ${tone('border-pink-500/20', 'border-slate-100')}`}>
            <div className="flex items-center space-x-1.5 font-bold">
              <FiZap className={`size-4 ${tone('text-pink-400', 'text-violet-600')}`} />
              <span>Recruiter note</span>
            </div>
            <button
              onClick={() => handleCopy(card.data.pitch)}
              className={`flex items-center space-x-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors cursor-pointer ${tone(
                'bg-pink-500/20 hover:bg-pink-500/30 border-pink-500/40 text-pink-200',
                'bg-white hover:bg-slate-50 border-slate-300 text-slate-700',
              )}`}>
              {copied ? (
                copiedLabel
              ) : (
                <>
                  <FiCopy className="size-3" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>

          <div
            className={`mt-2.5 rounded-lg p-3 text-[11px] leading-relaxed font-sans ${tone(
              'bg-pink-900/20 border border-pink-800/40',
              'bg-slate-50 border border-slate-200 text-slate-800',
            )}`}>
            {card.data.pitch}
          </div>
        </div>
      )}

      {/* ─── 5. Quick Options / Interactive Pill Buttons ─── */}
      {quickOptions && quickOptions.length > 0 && onSelectOption && (
        <div className="pt-1">
          <div
            className={`flex items-center space-x-1 mb-1.5 text-[10px] font-semibold ${tone('text-slate-400', 'text-slate-500')}`}>
            <FiArrowRight className="size-2.5" />
            <span>Suggested replies</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickOptions.map((opt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelectOption(opt)}
                className={`cursor-pointer rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors ${tone(
                  'border-sky-500/40 bg-slate-800/90 text-sky-300 hover:bg-sky-600 hover:text-white',
                  'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-600 hover:text-white',
                )}`}>
                {opt}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
