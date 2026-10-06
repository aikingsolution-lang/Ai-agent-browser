import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import React, { memo } from 'react';
import { CopilotCard } from './CopilotCard';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
  onSelectOption?: (option: string) => void;
}

export default memo(function MessageList({ messages, isDarkMode = false, onSelectOption }: MessageListProps) {
  return (
    <div className="max-w-full space-y-4">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
          isDarkMode={isDarkMode}
          onSelectOption={onSelectOption}
        />
      ))}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
  isDarkMode?: boolean;
  onSelectOption?: (option: string) => void;
}

function MessageBlock({ message, isSameActor, isDarkMode = false, onSelectOption }: MessageBlockProps) {
  if (!message.actor) {
    console.error('No actor found');
    return <div />;
  }
  const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES] || ACTOR_PROFILES.system;
  const isProgress = message.content === 'Showing progress...';

  return (
    <div
      className={`flex max-w-full gap-3 ${
        !isSameActor
          ? `mt-4 border-t ${isDarkMode ? 'border-sky-800/40' : 'border-sky-200/50'} pt-4 first:mt-0 first:border-t-0 first:pt-0`
          : ''
      }`}>
      {!isSameActor && (
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-white text-xs font-bold shadow-sm"
          style={{ backgroundColor: actor.iconBackground }}>
          {message.actor === 'copilot' ? '✨' : <img src={actor.icon} alt={actor.name} className="size-5" />}
        </div>
      )}
      {isSameActor && <div className="w-8" />}

      <div className="min-w-0 flex-1">
        {!isSameActor && (
          <div className="mb-1.5 flex items-center space-x-2">
            <span className={`text-xs font-bold ${isDarkMode ? 'text-gray-200' : 'text-gray-900'}`}>{actor.name}</span>
            {message.actor === 'copilot' && (
              <span className="rounded-full bg-purple-500/20 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-purple-300 border border-purple-500/30">
                Career Copilot Pro
              </span>
            )}
          </div>
        )}

        <div className="space-y-1">
          {isProgress ? (
            <div className={`h-1.5 overflow-hidden rounded-full ${isDarkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
              <div className="h-full animate-progress bg-gradient-to-r from-sky-500 to-purple-500" />
            </div>
          ) : (
            <RichMessageContent content={message.content} isDarkMode={isDarkMode} />
          )}

          {/* Render Rich Copilot Cards & Quick Pill Buttons if available */}
          {(message.metadata?.actionCard ||
            (message.metadata?.quickOptions && message.metadata.quickOptions.length > 0)) && (
            <CopilotCard
              card={message.metadata?.actionCard}
              quickOptions={message.metadata?.quickOptions}
              onSelectOption={onSelectOption}
              isDarkMode={isDarkMode}
            />
          )}

          {!isProgress && (
            <div className={`pt-0.5 text-right text-[10px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              {formatTimestamp(message.timestamp)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders structured markdown, headers, blockquotes, bullets, and tags cleanly
 */
function RichMessageContent({ content, isDarkMode = false }: { content: string; isDarkMode?: boolean }) {
  if (!content) return null;

  const lines = content.split('\n');

  return (
    <div className="space-y-1.5 text-xs leading-relaxed">
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <div key={idx} className="h-1" />;
        }

        // Headers: ### Header
        if (trimmed.startsWith('### ')) {
          return (
            <h4
              key={idx}
              className={`text-xs font-bold uppercase tracking-wider mt-2.5 mb-1 ${
                isDarkMode ? 'text-purple-300' : 'text-purple-700'
              }`}>
              {renderInlineStyles(trimmed.replace('### ', ''), isDarkMode)}
            </h4>
          );
        }

        // Headers: ## Header or # Header
        if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
          return (
            <h3
              key={idx}
              className={`text-sm font-extrabold mt-2 mb-1 ${isDarkMode ? 'text-sky-300' : 'text-sky-700'}`}>
              {renderInlineStyles(trimmed.replace(/^#+\s*/, ''), isDarkMode)}
            </h3>
          );
        }

        // Blockquotes: > quote
        if (trimmed.startsWith('> ')) {
          return (
            <blockquote
              key={idx}
              className={`my-2 rounded-r-lg border-l-2 p-2.5 text-xs italic ${
                isDarkMode
                  ? 'border-purple-500/80 bg-purple-950/30 text-purple-200'
                  : 'border-purple-400 bg-purple-50 text-purple-900'
              }`}>
              {renderInlineStyles(trimmed.replace('> ', ''), isDarkMode)}
            </blockquote>
          );
        }

        // Action prompt: 👉
        if (trimmed.startsWith('👉 ') || trimmed.startsWith('👉')) {
          return (
            <div
              key={idx}
              className={`my-2 flex items-start gap-2 rounded-xl border p-2.5 text-xs font-semibold shadow-xs ${
                isDarkMode
                  ? 'border-amber-500/40 bg-amber-950/30 text-amber-200'
                  : 'border-amber-300 bg-amber-50 text-amber-900'
              }`}>
              <span className="text-sm shrink-0">👉</span>
              <span className="flex-1">{renderInlineStyles(trimmed.replace(/^👉\s*/, ''), isDarkMode)}</span>
            </div>
          );
        }

        // Bullet list item: - item or * item
        if (/^[-*]\s+/.test(trimmed)) {
          const itemText = trimmed.replace(/^[-*]\s+/, '');
          return (
            <div key={idx} className="flex items-start gap-1.5 text-xs pl-1">
              <span className={`text-[11px] mt-0.5 ${isDarkMode ? 'text-sky-400' : 'text-sky-600'}`}>•</span>
              <span className="flex-1">{renderInlineStyles(itemText, isDarkMode)}</span>
            </div>
          );
        }

        // Regular line
        return (
          <p key={idx} className={`text-xs ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            {renderInlineStyles(trimmed, isDarkMode)}
          </p>
        );
      })}
    </div>
  );
}

function renderInlineStyles(text: string, isDarkMode: boolean): React.ReactNode {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);

  return tokens.map((token, i) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      const boldText = token.slice(2, -2);
      return (
        <strong key={i} className={`font-bold ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
          {boldText}
        </strong>
      );
    }
    if (token.startsWith('`') && token.endsWith('`')) {
      const codeText = token.slice(1, -1);
      return (
        <code
          key={i}
          className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
            isDarkMode
              ? 'bg-slate-800 text-sky-300 border border-slate-700'
              : 'bg-gray-100 text-sky-700 border border-gray-200'
          }`}>
          {codeText}
        </code>
      );
    }
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a
          key={i}
          href={linkMatch[2]}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-sky-500 underline hover:text-sky-600">
          {linkMatch[1]}
        </a>
      );
    }
    return token;
  });
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
