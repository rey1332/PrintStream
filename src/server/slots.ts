export class SlotsFullError extends Error {
  constructor() {
    super('Too many requests at once');
  }
}

export interface Slots {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly load: { active: number; waiting: number };
}

export function createSlots(size: number, maxWaiting: number): Slots {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= size) {
        if (waiting.length >= maxWaiting) throw new SlotsFullError();
        // The slot is handed over by the one finishing (active stays the same).
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }
      try {
        return await fn();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
    get load() {
      return { active, waiting: waiting.length };
    },
  };
}

export function keyedSlots(size: number, maxWaiting: number) {
  const byKey = new Map<string, Slots>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      let slots = byKey.get(key);
      if (!slots) byKey.set(key, (slots = createSlots(size, maxWaiting)));
      try {
        return await slots.run(fn);
      } finally {
        const { active, waiting } = slots.load;
        if (active === 0 && waiting === 0) byKey.delete(key);
      }
    },
    get size() {
      return byKey.size;
    },
  };
}
