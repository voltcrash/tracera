const PREFIX = "tracera-cache:";

type CachedValue<T> = {
  storedAt: number;
  value: T;
};

export function readSessionCache<T>(userId: string, key: string, maxAge: number): T | null {
  try {
    const raw = window.sessionStorage.getItem(cacheKey(userId, key));
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedValue<T>;
    if (!cached || Date.now() - cached.storedAt > maxAge) return null;
    return cached.value;
  } catch {
    return null;
  }
}

export function writeSessionCache<T>(userId: string, key: string, value: T) {
  try {
    window.sessionStorage.setItem(
      cacheKey(userId, key),
      JSON.stringify({ storedAt: Date.now(), value } satisfies CachedValue<T>),
    );
  } catch {
    // The live response remains usable when browser storage is unavailable.
  }
}

export function clearSessionCache() {
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Signing out must continue when browser storage is unavailable.
  }
}

function cacheKey(userId: string, key: string) {
  return `${PREFIX}${userId}:${key}`;
}
