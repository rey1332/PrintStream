'use client';

// The Query Tool's SQL editor (CodeMirror 6): line numbers, SQL highlighting
// with the workbench's colours, search, undo, comment toggling and the
// Query Tool's keys. The text lives in the editor, not in React state, so
// typing re-renders nothing; the parent asks for it through the handle.

import React, { useEffect, useImperativeHandle, useRef } from 'react';
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderText,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
  openSearchPanel,
} from '@codemirror/search';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

export interface SqlEditorHandle {
  getText: () => string;
  setText: (text: string) => void;
  /** The selected text and where it starts, or null when nothing is selected. */
  getSelection: () => { text: string; from: number } | null;
  getCursor: () => number;
  insert: (text: string) => void;
  focus: () => void;
  toggleComment: () => void;
  openSearch: () => void;
  /** Marks [from, to) as the error (or clears it). */
  markError: (range: { from: number; to: number } | null) => void;
}

interface Props {
  /** The editor's handle (a prop, not ref: this component is loaded with next/dynamic). */
  handle: React.MutableRefObject<SqlEditorHandle | null>;
  initialText: string;
  placeholder: string;
  ariaLabel: string;
  /** Typing (for saving the draft); called after each change, not per render. */
  onChange: (text: string) => void;
  onCursor: (pos: {
    line: number;
    col: number;
    lineBreak: 'LF' | 'CRLF';
    selected: number;
  }) => void;
  onRun: () => void;
  onExplain: () => void;
  onSave: () => void;
  /** Table and column names to complete (optional). */
  schema?: Record<string, string[]>;
}

const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorMark = Decoration.mark({ class: 'cm-sql-error' });
const errorField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setError))
        marks =
          e.value && e.value.to > e.value.from
            ? Decoration.set([errorMark.range(e.value.from, e.value.to)])
            : Decoration.none;
    // Editing clears the mark: the text it pointed at has changed.
    if (tr.docChanged) marks = Decoration.none;
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--wb-syn-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--wb-syn-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--wb-syn-number)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--wb-syn-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--wb-syn-type)' },
  { tag: [tags.name, tags.special(tags.name), tags.propertyName], color: 'var(--wb-syn-name)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--wb-syn-operator)' },
]);

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--wb-editor)',
    color: 'var(--wb-text)',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: '1.5',
  },
  '.cm-content': { caretColor: 'var(--wb-text)', padding: '4px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--wb-text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-gutters': {
    backgroundColor: 'var(--wb-gutter)',
    color: 'var(--wb-muted)',
    border: 'none',
    borderRight: '1px solid var(--wb-border)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '36px' },
  '.cm-activeLine': { backgroundColor: 'var(--wb-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--wb-hover)', color: 'var(--wb-text-2)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--wb-selection) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--wb-selection)' },
  '.cm-matchingBracket': { outline: '1px solid var(--wb-muted)', backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'var(--wb-muted)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--wb-panel)',
    border: '1px solid var(--wb-border)',
    color: 'var(--wb-text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--wb-active)',
    color: 'var(--wb-text)',
  },
  '.cm-sql-error': {
    textDecoration: 'underline wavy var(--wb-error)',
    textUnderlineOffset: '3px',
    backgroundColor: 'color-mix(in srgb, var(--wb-error) 12%, transparent)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--wb-toolbar)',
    color: 'var(--wb-text)',
    borderBottom: '1px solid var(--wb-border)',
  },
  '.cm-panels input, .cm-panels button': { fontSize: '12px' },
  '.cm-textfield': {
    backgroundColor: 'var(--wb-editor)',
    border: '1px solid var(--wb-border)',
    color: 'var(--wb-text)',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--wb-panel)',
    border: '1px solid var(--wb-border)',
    color: 'var(--wb-text)',
  },
});

function cursorInfo(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selected = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  return { line: line.number, col: head - line.from + 1, selected };
}

export default function SqlEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The newest callbacks, without rebuilding the editor.
  const latest = useRef(props);
  latest.current = props;
  const lineBreak = useRef<'LF' | 'CRLF'>(/\r\n/.test(props.initialText) ? 'CRLF' : 'LF');
  const language = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    // The Query Tool's keys come first, also while completion suggestions are open.
    const toolKeys = Prec.highest(
      keymap.of([
        { key: 'Mod-Enter', run: () => (latest.current.onRun(), true), preventDefault: true },
        { key: 'F5', run: () => (latest.current.onRun(), true), preventDefault: true },
        { key: 'F7', run: () => (latest.current.onExplain(), true), preventDefault: true },
        { key: 'Mod-s', run: () => (latest.current.onSave(), true), preventDefault: true },
      ])
    );
    const keys = keymap.of([
      { key: 'Mod-/', run: toggleComment },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
      ...defaultKeymap,
    ]);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true, icons: false }),
      search({ top: true }),
      language.current.of(sql({ dialect: PostgreSQL, schema: latest.current.schema })),
      syntaxHighlighting(highlight),
      theme,
      errorField,
      placeholderText(latest.current.placeholder),
      EditorView.contentAttributes.of({ 'aria-label': latest.current.ariaLabel }),
      toolKeys,
      keys,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) latest.current.onChange(u.state.doc.toString());
        if (u.docChanged || u.selectionSet)
          latest.current.onCursor({ ...cursorInfo(u.state), lineBreak: lineBreak.current });
      }),
    ];
    const v = new EditorView({
      state: EditorState.create({ doc: props.initialText, extensions }),
      parent: host.current,
    });
    view.current = v;
    latest.current.onCursor({ ...cursorInfo(v.state), lineBreak: lineBreak.current });
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is made once; its text is changed through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New datasets or columns: completion knows them.
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(sql({ dialect: PostgreSQL, schema: props.schema })),
    });
  }, [props.schema]);

  useImperativeHandle(props.handle, () => ({
    getText: () => view.current?.state.doc.toString() ?? '',
    setText: (text) => {
      const v = view.current;
      if (!v) return;
      lineBreak.current = /\r\n/.test(text) ? 'CRLF' : 'LF';
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
      v.focus();
    },
    getSelection: () => {
      const v = view.current;
      if (!v) return null;
      const r = v.state.selection.main;
      return r.empty ? null : { text: v.state.sliceDoc(r.from, r.to), from: r.from };
    },
    getCursor: () => view.current?.state.selection.main.head ?? 0,
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
    focus: () => view.current?.focus(),
    toggleComment: () => {
      if (view.current) toggleComment(view.current);
    },
    openSearch: () => {
      if (view.current) openSearchPanel(view.current);
    },
    markError: (range) => {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      v.dispatch({
        effects: setError.of(
          range ? { from: Math.min(range.from, len), to: Math.min(range.to, len) } : null
        ),
        ...(range
          ? { selection: { anchor: Math.min(range.from, len) }, scrollIntoView: true }
          : {}),
      });
    },
  }));

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
