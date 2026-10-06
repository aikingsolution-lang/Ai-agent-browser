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
    title: 'Priority 1 (Highest Priority / Primary)',
    color:
      'text-emerald-500 bg-emerald-50 border-emerald-200 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300',
  },
  {
    rank: '2',
    title: 'Priority 2 (Secondary)',
    color: 'text-sky-600 bg-sky-50 border-sky-200 dark:bg-sky-950/40 dark:border-sky-800 dark:text-sky-300',
  },
  {
    rank: '3',
    title: 'Priority 3 (Tertiary)',
    color:
      'text-purple-600 bg-purple-50 border-purple-200 dark:bg-purple-950/40 dark:border-purple-800 dark:text-purple-300',
  },
];

/**
 * Options Page Multi-Location Input with strict 3-tier Priority Hierarchy.
 */
export function PrioritizedLocationsInput({
  locations = [],
  onChange,
  isDarkMode = false,
  maxLocations = 3,
}: PrioritizedLocationsInputProps) {
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
    <div className="space-y-3">
      {activeLocations.map((loc, index) => {
        const meta = PRIORITY_LABELS[index] || {
          rank: String(index + 1),
          title: `Priority ${index + 1}`,
          color: 'text-gray-500 bg-gray-50 border-gray-200',
        };

        return (
          <div
            key={index}
            className={`p-3 rounded-lg border transition-all ${
              index === 0
                ? isDarkMode
                  ? 'border-emerald-800/80 bg-slate-800/80'
                  : 'border-emerald-200 bg-emerald-50/20'
                : isDarkMode
                  ? 'border-slate-700 bg-slate-800/60'
                  : 'border-gray-200 bg-white'
            }`}>
            <div className="flex items-center justify-between mb-1.5">
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${meta.color}`}>
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
                    className="p-1 rounded text-gray-400 hover:text-sky-500 transition-colors cursor-pointer">
                    <FiArrowUp className="size-3.5" />
                  </button>
                )}
                {index < activeLocations.length - 1 && (
                  <button
                    type="button"
                    onClick={() => handleMoveDown(index)}
                    title="Demote Priority (Move Down)"
                    className="p-1 rounded text-gray-400 hover:text-sky-500 transition-colors cursor-pointer">
                    <FiArrowDown className="size-3.5" />
                  </button>
                )}
                {activeLocations.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemove(index)}
                    title="Remove this location"
                    className="p-1 rounded text-gray-400 hover:text-red-500 transition-colors cursor-pointer">
                    <FiTrash2 className="size-3.5" />
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
                  ? 'e.g. Bengaluru, Karnataka, India (Primary Target Location)'
                  : index === 1
                    ? 'e.g. Hyderabad, Telangana, India (Secondary Target Location)'
                    : 'e.g. Remote (Tertiary Target Location)'
              }
            />
          </div>
        );
      })}

      {activeLocations.length < maxLocations && (
        <button
          type="button"
          onClick={handleAdd}
          className={`w-full py-2 px-3 rounded-md border border-dashed flex items-center justify-center space-x-2 text-xs font-semibold transition-colors cursor-pointer ${
            isDarkMode
              ? 'border-sky-800 text-sky-400 hover:bg-sky-950/40 hover:border-sky-600'
              : 'border-sky-300 text-sky-600 hover:bg-sky-50 hover:border-sky-400'
          }`}>
          <FiPlus className="size-4" />
          <span>Add Priority {activeLocations.length + 1} Location (Max 3)</span>
        </button>
      )}
    </div>
  );
}
