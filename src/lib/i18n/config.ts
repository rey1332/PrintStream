export const LOCALES = ['id', 'en', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'etna.locale';

export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
  'zh-CN': '简体中文',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredLocale(storage: StorageLike | null = defaultStorage()): Locale {
  try {
    const value = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function writeStoredLocale(
  locale: Locale,
  storage: StorageLike | null = defaultStorage()
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

export const LOCALE_BOOT_SCRIPT = `(function(){try{var l=localStorage.getItem('${LOCALE_STORAGE_KEY}');var ok=${JSON.stringify(
  LOCALES
)};if(l&&l!=='${DEFAULT_LOCALE}'&&ok.indexOf(l)>-1){var h=document.documentElement;h.lang=l;h.setAttribute('data-locale-pending','');setTimeout(function(){h.removeAttribute('data-locale-pending');},2500);}}catch(e){}})();`;
