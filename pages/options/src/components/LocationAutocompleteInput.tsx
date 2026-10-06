import React, { useState, useEffect, useRef, useMemo } from 'react';
import { StandardLocation, searchStandardLocations, POPULAR_LOCATIONS } from '@extension/storage';
import { FiMapPin, FiCheck, FiInfo } from 'react-icons/fi';

export interface LocationAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (location: string) => void;
  isPreferred?: boolean;
  placeholder?: string;
  className?: string;
  containerClassName?: string;
  isDarkMode?: boolean;
  disabled?: boolean;
  showQuickPills?: boolean;
  id?: string;
}

/**
 * Intelligent Location Autocomplete Input for Options Page.
 * Recommends standardized "City, State, Country" format expected by LinkedIn, Naukri, and Indeed.
 */
export function LocationAutocompleteInput({
  value,
  onChange,
  onSelect,
  isPreferred = false,
  placeholder,
  className = '',
  containerClassName = 'relative w-full',
  isDarkMode = false,
  disabled = false,
  showQuickPills = true,
  id,
}: LocationAutocompleteInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const defaultPlaceholder = isPreferred
    ? 'e.g. Bengaluru, Karnataka, India or Remote'
    : 'e.g. Bengaluru, Karnataka, India';

  const suggestions = useMemo(() => {
    return searchStandardLocations(value, { isPreferred, limit: 7 });
  }, [value, isPreferred]);

  useEffect(() => {
    setSelectedIndex(-1);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  const handleSelect = (loc: StandardLocation | string) => {
    const formatted = typeof loc === 'string' ? loc : loc.formatted;
    onChange(formatted);
    if (onSelect) {
      onSelect(formatted);
    }
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isOpen && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
        return;
      }
      if (e.key === 'Enter') {
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          e.preventDefault();
          handleSelect(suggestions[selectedIndex]);
          return;
        }
      }
      if (e.key === 'Tab') {
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          e.preventDefault();
          handleSelect(suggestions[selectedIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
        setSelectedIndex(-1);
        return;
      }
    }
  };

  const quickPillLocations = useMemo(() => {
    let list = POPULAR_LOCATIONS;
    if (!isPreferred) {
      list = list.filter(l => l.category !== 'remote');
    }
    return list.slice(0, 6);
  }, [isPreferred]);

  const isStandardFormat = useMemo(() => {
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    return suggestions.some(s => s.formatted.toLowerCase() === trimmed.toLowerCase());
  }, [value, suggestions]);

  return (
    <div ref={containerRef} className={containerClassName}>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={value}
          onChange={e => {
            onChange(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder || defaultPlaceholder}
          autoComplete="off"
          className={`w-full rounded-md border ${
            isDarkMode
              ? 'border-slate-600 bg-slate-700 text-gray-100 placeholder-gray-400 focus:border-sky-400'
              : 'border-gray-300 bg-white text-gray-800 placeholder-gray-400 focus:border-sky-500'
          } px-3 py-2 text-sm outline-none transition-colors pr-8 ${className}`}
        />
        <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
          {isStandardFormat ? (
            <span title="Recognized LinkedIn / Indeed / Naukri format">
              <FiCheck className="size-4 text-emerald-500" />
            </span>
          ) : (
            <span title="Format: City, State, Country">
              <FiMapPin className="size-4 text-gray-400" />
            </span>
          )}
        </div>
      </div>

      {/* Floating Recommendations Dropdown */}
      {isOpen && (
        <div
          className={`absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-md border shadow-xl ${
            isDarkMode ? 'border-slate-600 bg-slate-800 text-gray-100' : 'border-gray-200 bg-white text-gray-900'
          }`}>
          {/* Header */}
          <div
            className={`px-3 py-1.5 border-b text-[11px] flex items-center justify-between font-medium ${
              isDarkMode ? 'border-slate-700 bg-slate-900/80 text-sky-300' : 'border-gray-100 bg-sky-50 text-sky-800'
            }`}>
            <span className="flex items-center gap-1.5">
              <FiInfo className="size-3.5" />
              <span>
                Recommended: <strong>City, State, Country</strong>
              </span>
            </span>
            <span className="text-[10px] opacity-80 font-semibold">LinkedIn • Indeed • Naukri</span>
          </div>

          {/* Suggestions List */}
          <ul ref={listRef} className="py-1">
            {suggestions.length > 0 ? (
              suggestions.map((loc, idx) => {
                const isSelected = idx === selectedIndex;
                const isExact = loc.formatted.toLowerCase() === (value || '').trim().toLowerCase();
                return (
                  <li
                    key={loc.formatted}
                    onMouseDown={e => {
                      e.preventDefault();
                      handleSelect(loc);
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`cursor-pointer px-3 py-2 text-xs transition-colors flex items-center justify-between gap-2 ${
                      isSelected
                        ? isDarkMode
                          ? 'bg-sky-600/30 text-sky-200'
                          : 'bg-sky-100 text-sky-900'
                        : isDarkMode
                          ? 'hover:bg-slate-750'
                          : 'hover:bg-gray-50'
                    }`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <FiMapPin
                          className={`size-3.5 shrink-0 ${
                            loc.category === 'remote' ? 'text-purple-400' : 'text-sky-500'
                          }`}
                        />
                        <span className="font-medium truncate">{loc.formatted}</span>
                        {isExact && <FiCheck className="size-3.5 text-emerald-500 shrink-0" />}
                      </div>
                      {loc.aliases && loc.aliases.length > 0 && (
                        <div className="text-[10px] text-gray-400 pl-5 truncate">
                          alias: {loc.aliases.slice(0, 3).join(', ')}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-[10px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap shrink-0 ${
                        loc.category === 'remote'
                          ? isDarkMode
                            ? 'bg-purple-900/50 text-purple-300 border border-purple-700/50'
                            : 'bg-purple-50 text-purple-700 border border-purple-200'
                          : isDarkMode
                            ? 'bg-sky-950 text-sky-300 border border-sky-800'
                            : 'bg-sky-50 text-sky-700 border border-sky-200'
                      }`}>
                      {loc.category === 'remote' ? 'Work Mode' : 'Standard'}
                    </span>
                  </li>
                );
              })
            ) : (
              <li className="px-3 py-2 text-xs text-gray-400 text-center">
                Type city name to see LinkedIn/Indeed standard format
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Quick Pills */}
      {showQuickPills && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-400 mr-0.5">Popular:</span>
          {quickPillLocations.map(p => (
            <button
              key={p.formatted}
              type="button"
              onClick={() => handleSelect(p)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer border ${
                value.toLowerCase() === p.formatted.toLowerCase()
                  ? 'border-sky-500 bg-sky-500/20 text-sky-400 font-semibold'
                  : isDarkMode
                    ? 'border-slate-600 bg-slate-800 text-gray-300 hover:border-sky-400 hover:text-white'
                    : 'border-gray-200 bg-gray-50 text-gray-700 hover:border-sky-300 hover:text-sky-800'
              }`}>
              {p.city}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
