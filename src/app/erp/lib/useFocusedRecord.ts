'use client';

import { useEffect, useState } from 'react';

export function useQueryParam(name: string): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    try {
      setValue(new URLSearchParams(window.location.search).get(name));
    } catch {
      setValue(null);
    }
  }, [name]);
  return value;
}
