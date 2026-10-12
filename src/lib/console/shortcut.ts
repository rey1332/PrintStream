type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'isComposing'
> & {
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
};

export function isConsoleShortcut(event: KeyLike): boolean {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.metaKey) return false;
  const altGraph = event.getModifierState?.('AltGraph') === true;
  if ((event.ctrlKey || event.altKey) && !altGraph) return false;
  return event.key === '`' || (event.code === 'Backquote' && !event.shiftKey);
}

type ElementLike = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

export const CONSOLE_ROOT_ATTRIBUTE = 'data-etna-console';

export function isTypingTarget(target: ElementLike | null | undefined): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return !!target.closest?.('[contenteditable]:not([contenteditable="false"])');
}

export function isInsideConsole(target: ElementLike | null | undefined): boolean {
  return !!target?.closest?.(`[${CONSOLE_ROOT_ATTRIBUTE}]`);
}

export function shouldToggleConsole(event: KeyLike & { target: EventTarget | null }): boolean {
  if (!isConsoleShortcut(event)) return false;
  const target = event.target as ElementLike | null;
  return isInsideConsole(target) || !isTypingTarget(target);
}
