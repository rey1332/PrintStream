'use client';

import React from 'react';

export type TermsLocale = 'en' | 'id' | 'zh';
export type TermsContent = { en: string; id?: string; zh?: string };

/** The language a reader sees: theirs when the version has it, else English. */
export function shownLocale(content: TermsContent, wanted: string): TermsLocale {
  return (wanted === 'id' || wanted === 'zh') && content[wanted]?.trim() ? wanted : 'en';
}

// The Terms & Conditions as written: plain text, paragraphs and line breaks
// kept, nothing interpreted as markup.
export function TermsText({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div
      className={`whitespace-pre-wrap break-words text-[0.82rem] leading-relaxed text-foreground ${className}`}
    >
      {text}
    </div>
  );
}
