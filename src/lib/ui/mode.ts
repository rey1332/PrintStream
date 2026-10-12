export const UI_VERSIONS = ['refined', 'legacy'] as const;
export type UiVersion = (typeof UI_VERSIONS)[number];

export const DEFAULT_UI: UiVersion = 'refined';

export const DESKTOP_MIN_WIDTH = 1024;
export const DESKTOP_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;

const KEY_PREFIX = 'etna.ui:';
export const LAST_UI_KEY = 'etna.ui.last';

export function isUiVersion(value: unknown): value is UiVersion {
  return typeof value === 'string' && (UI_VERSIONS as readonly string[]).includes(value);
}

export function uiStorageKey(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function effectiveUi(preference: UiVersion, isDesktop: boolean): UiVersion {
  return isDesktop && preference === 'legacy' ? 'legacy' : 'refined';
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readUiPreference(
  userId: string | null,
  storage: StorageLike | null = defaultStorage()
): UiVersion | null {
  try {
    const value = storage?.getItem(userId ? uiStorageKey(userId) : LAST_UI_KEY);
    return isUiVersion(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeUiPreference(
  userId: string,
  value: UiVersion,
  storage: StorageLike | null = defaultStorage()
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(uiStorageKey(userId), value);
    storage.setItem(LAST_UI_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function rememberLastUi(
  value: UiVersion,
  storage: StorageLike | null = defaultStorage()
): void {
  try {
    storage?.setItem(LAST_UI_KEY, value);
  } catch {
    // Storage blocked: the next load may briefly show the default version.
  }
}

export const UI_BOOT_SCRIPT = `(function(){var h=document.documentElement;try{var v=localStorage.getItem('${LAST_UI_KEY}');var legacy=v==='legacy'&&window.matchMedia('${DESKTOP_QUERY}').matches;h.setAttribute('data-ui',legacy?'legacy':'refined');if(legacy){h.setAttribute('data-ui-pending','');setTimeout(function(){h.removeAttribute('data-ui-pending');},2500);}}catch(e){h.setAttribute('data-ui','${DEFAULT_UI}');}})();`;
