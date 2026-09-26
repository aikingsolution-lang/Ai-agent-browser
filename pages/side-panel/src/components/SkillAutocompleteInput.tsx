import React, { useState, useEffect, useRef, useMemo } from 'react';
import { COMMON_SKILLS } from '../data/commonSkills';

export interface SkillAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (skill: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  className?: string;
  containerClassName?: string;
  isDarkMode?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  maxSuggestions?: number;
  id?: string;
}

/**
 * Autocomplete / typeahead input component for tech skills.
 * Filters a comprehensive list of ~250+ tech skills with prefix & substring matching,
 * arrow-key navigation, Enter/Tab selection, and Escape to dismiss.
 */
export function SkillAutocompleteInput({
  value,
  onChange,
  onSelect,
  onKeyDown,
  placeholder = 'e.g. Spring Boot, Node.js',
  className = '',
  containerClassName = 'relative flex-1',
  isDarkMode = false,
  disabled = false,
  autoFocus = false,
  maxSuggestions = 8,
  id,
}: SkillAutocompleteInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Filter skills based on user input
  const suggestions = useMemo(() => {
    const q = (value || '').trim().toLowerCase();
    if (!q) return [];

    const prefixMatches: string[] = [];
    const substringMatches: string[] = [];

    for (const skill of COMMON_SKILLS) {
      const lower = skill.toLowerCase();
      if (lower.startsWith(q)) {
        prefixMatches.push(skill);
      } else if (lower.includes(q)) {
        substringMatches.push(skill);
      }
      if (prefixMatches.length + substringMatches.length >= maxSuggestions * 2) {
        break;
      }
    }

    return [...prefixMatches, ...substringMatches].slice(0, maxSuggestions);
  }, [value, maxSuggestions]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(-1);
  }, [value]);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Scroll active item into view
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const item = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (item) {
        item.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex]);

  const handleSelect = (skill: string) => {
    onChange(skill);
    if (onSelect) {
      onSelect(skill);
    }
    setIsOpen(false);
    setSelectedIndex(-1);
  };

  const handleKeyDownInternal = (e: React.KeyboardEvent<HTMLInputElement>) => {
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

    // Call external handler if provided
    if (onKeyDown) {
      onKeyDown(e);
    }
  };

  /**
   * Highlights the matched portion of the skill name
   */
  const renderHighlightedSkill = (skill: string) => {
    const q = (value || '').trim().toLowerCase();
    if (!q) return skill;

    const lower = skill.toLowerCase();
    const matchIdx = lower.indexOf(q);
    if (matchIdx === -1) return skill;

    const before = skill.slice(0, matchIdx);
    const matched = skill.slice(matchIdx, matchIdx + q.length);
    const after = skill.slice(matchIdx + q.length);

    return (
      <span>
        {before}
        <strong className={isDarkMode ? 'text-sky-300 font-bold underline' : 'text-sky-600 font-bold underline'}>
          {matched}
        </strong>
        {after}
      </span>
    );
  };

  const showDropdown = isOpen && suggestions.length > 0;

  return (
    <div ref={containerRef} className={containerClassName}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={e => {
          onChange(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          if (suggestions.length > 0) {
            setIsOpen(true);
          }
        }}
        onKeyDown={handleKeyDownInternal}
        className={className}
        autoComplete="off"
        spellCheck="false"
      />

      {showDropdown && (
        <ul
          ref={listRef}
          role="listbox"
          className={`absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-lg border shadow-xl transition-all ${
            isDarkMode
              ? 'border-sky-800/80 bg-slate-900 text-gray-200 divide-y divide-slate-800/60'
              : 'border-sky-200 bg-white text-gray-800 divide-y divide-gray-100'
          }`}>
          {suggestions.map((skill, index) => {
            const isSelected = index === selectedIndex;
            return (
              <li
                key={skill}
                role="option"
                aria-selected={isSelected}
                onMouseDown={e => {
                  e.preventDefault(); // Prevent input blur
                  handleSelect(skill);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`flex cursor-pointer items-center justify-between px-3 py-1.5 text-xs select-none transition-colors ${
                  isSelected
                    ? isDarkMode
                      ? 'bg-sky-950/90 text-sky-200 font-medium'
                      : 'bg-sky-100/90 text-sky-900 font-medium'
                    : isDarkMode
                      ? 'hover:bg-slate-800/80 hover:text-white'
                      : 'hover:bg-sky-50 hover:text-sky-900'
                }`}>
                <span className="truncate">{renderHighlightedSkill(skill)}</span>
                <span className={`text-[10px] ml-2 shrink-0 ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                  Skill
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
