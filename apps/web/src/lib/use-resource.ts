import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { AsyncResource } from "./async-resource";
import { readSessionCache, writeSessionCache } from "./session-cache";

export function useResource<T>(
  ownerId: string | null,
  load: () => Promise<T>,
  cache?: { key: string; maxAge: number },
) {
  const resource = useMemo(() => new AsyncResource<T>(ownerId), [ownerId]);
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const key = cache?.key;
  const maxAge = cache?.maxAge;
  const refresh = useCallback(() => {
    if (!resource.ownerId) return Promise.resolve(false);
    const id = resource.ownerId;
    const cached = key && maxAge ? readSessionCache<T>(id, key, maxAge) : null;
    return resource.refresh(load, cached, (data) => {
      if (key) writeSessionCache(id, key, data);
    });
  }, [resource, load, key, maxAge]);
  useEffect(() => {
    resource.activate();
    void refresh();
    return resource.cancel;
  }, [refresh, resource]);
  return { state, refresh };
}
