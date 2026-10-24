export const LOCALES = ['id', 'en', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_STORAGE_KEY = 'etna.locale';
// The same choice for the server, which renders pages in it (src/app/layout.tsx).
export const LOCALE_COOKIE = 'etna_locale';
const COOKIE_ATTRS = 'Path=/; Max-Age=31536000; SameSite=Lax';

/** The language a page is rendered in on the server, from the request's cookie. */
export function localeFromCookie(value: string | undefined | null): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

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
    if (typeof document !== 'undefined')
      document.cookie = `${LOCALE_COOKIE}=${locale}; ${COOKIE_ATTRS}`;
    if (!storage) return false;
    storage.setItem(LOCALE_STORAGE_KEY, locale);
    return true;
  } catch {
    return false;
  }
}

// Before the page shows: the language saved in this browser. The server
// rendered the page in the cookie's language (<html lang>); when the saved one
// differs (a browser that chose before the cookie existed), the cookie is set
// for the next page and this one stays hidden until the provider switches it.
export const LOCALE_BOOT_SCRIPT = `(function(){try{var l=localStorage.getItem('${LOCALE_STORAGE_KEY}');var ok=${JSON.stringify(
  LOCALES
)};var h=document.documentElement;if(l&&ok.indexOf(l)>-1&&l!==h.lang){document.cookie='${LOCALE_COOKIE}='+l+'; ${COOKIE_ATTRS}';h.lang=l;h.setAttribute('data-locale-pending','');setTimeout(function(){h.removeAttribute('data-locale-pending');},2500);}}catch(e){}})();`;
