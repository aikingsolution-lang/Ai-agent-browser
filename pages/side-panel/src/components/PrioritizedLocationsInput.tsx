import React from 'react';
import { LocationAutocompleteInput } from './LocationAutocompleteInput';
import { FiPlus, FiTrash2, FiArrowUp, FiArrowDown } from 'react-icons/fi';

export interface PrioritizedLocationsInputProps {
  locations: string[];
  onChange: (locations: string[]) => void;
  isDarkMode?: boolean;
  maxLocations?: number;
}

const PRIORITY_LABELS = [
  {
    rank: '1',
    title: 'Priority 1 (Highest / Primary)',
    color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  },
  { rank: '2', title: 'Priority 2 (Secondary)', color: 'text-sky-400 bg-sky-500/10 border-sky-500/30' },
  { rank: '3', title: 'Priority 3 (Tertiary)', color: 'text-purple-400 bg-purple-500/10 border-purple-500/30' },
];

/**
 * Multi-Location Input with strict 3-tier Priority Hierarchy.
 * Priority 1 is prioritized first for job search and form resolution,
 * followed by Priority 2 and Priority 3.
 */
export function PrioritizedLocationsInput({
  locations = [],
  onChange,
  isDarkMode = false,
  maxLocations = 3,
}: PrioritizedLocationsInputProps) {
  // Ensure at least one slot exists
  const activeLocations = locations.length > 0 ? locations.slice(0, maxLocations) : [''];

  const handleUpdate = (index: number, value: string) => {
    const updated = [...activeLocations];
    updated[index] = value;
    onChange(updated);
  };

  const handleAdd = () => {
    if (activeLocations.length >= maxLocations) return;
    const updated = [...activeLocations, ''];
    onChange(updated);
  };

  const handleRemove = (index: number) => {
    if (activeLocations.length <= 1) {
      onChange(['']);
      return;
    }
    const updated = activeLocations.filter((_, i) => i !== index);
    onChange(updated);
  };

  const handleMoveUp = (index: number) => {
    if (index <= 0) return;
    const updated = [...activeLocations];
    const temp = updated[index - 1];
    updated[index - 1] = updated[index];
    updated[index] = temp;
    onChange(updated);
  };

  const handleMoveDown = (index: number) => {
    if (index >= activeLocations.length - 1) return;
    const updated = [...activeLocations];
    const temp = updated[index + 1];
    updated[index + 1] = updated[index];
    updated[index] = temp;
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      {activeLocations.map((loc, index) => {
        const meta = PRIORITY_LABELS[index] || {
          rank: String(index + 1),
          title: `Priority ${index + 1}`,
          color: 'text-gray-400 bg-gray-500/10 border-gray-500/30',
        };

        return (
          <div
            key={index}
            className={`p-2 rounded-lg border transition-all ${
              index === 0
                ? isDarkMode
                  ? 'border-emerald-900/60 bg-emerald-950/20'
                  : 'border-emerald-200 bg-emerald-50/40'
                : isDarkMode
                  ? 'border-sky-900/60 bg-slate-900/50'
                  : 'border-sky-100 bg-white/60'
            }`}>
            <div className="flex items-center justify-between mb-1">
              <span
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${meta.color}`}>
                <span>{index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉'}</span>
                <span>{meta.title}</span>
              </span>

              {/* Priority Reordering & Actions */}
              <div className="flex items-center space-x-1">
                {index > 0 && (
                  <button
                    type="button"
                    onClick={() => handleMoveUp(index)}
                    title="Promote Priority (Move Up)"
                    className="p-1 rounded text-gray-400 hover:text-sky-400 transition-colors cursor-pointer">
                    <FiArrowUp className="size-3" />
                  </button>
                )}
                {index < activeLocations.length - 1 && (
                  <button
                    type="button"
                    onClick={() => handleMoveDown(index)}
                    title="Demote Priority (Move Down)"
                    className="p-1 rounded text-gray-400 hover:text-sky-400 transition-colors cursor-pointer">
                    <FiArrowDown className="size-3" />
                  </button>
                )}
                {activeLocations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemove(index)}
                    title="Remove this location"
                    className="p-1 rounded text-gray-400 hover:text-red-400 transition-colors cursor-pointer">
                    <FiTrash2 className="size-3" />
                  </button>
                )}
              </div>
            </div>

            <LocationAutocompleteInput
              value={loc}
              onChange={val => handleUpdate(index, val)}
              isDarkMode={isDarkMode}
              isPreferred={true}
              showQuickPills={index === 0}
              placeholder={
                index === 0
                  ? 'e.g. Bengaluru, Karnataka, India (Primary Target)'
                  : index === 1
                    ? 'e.g. Hyderabad, Telangana, India (Secondary Target)'
                    : 'e.g. Remote (Tertiary Target)'
              }
            />
          </div>
        );
      })}

      {activeLocations.length < maxLocations && (
        <button
          type="button"
          onClick={handleAdd}
          className={`w-full py-1.5 px-3 rounded-lg border border-dashed flex items-center justify-center space-x-1.5 text-xs font-semibold transition-colors cursor-pointer ${
            isDarkMode
              ? 'border-sky-800 text-sky-400 hover:bg-sky-950/40 hover:border-sky-600'
              : 'border-sky-300 text-sky-600 hover:bg-sky-50 hover:border-sky-400'
          }`}>
          <FiPlus className="size-3.5" />
          <span>Add Priority {activeLocations.length + 1} Preferred Location (Max 3)</span>
        </button>
      )}
    </div>
  );
}
