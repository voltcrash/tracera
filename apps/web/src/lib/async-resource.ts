export type ResourceState<T> =
  | { status: "loading" | "error"; data: T | null }
  | { status: "ready"; data: T };

export class AsyncResource<T> {
  private state: ResourceState<T> = { status: "loading", data: null };
  private version = 0;
  private active = true;
  private listeners = new Set<() => void>();

  constructor(readonly ownerId: string | null) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(load: () => Promise<T>, cached: T | null = null, commit?: (data: T) => void) {
    if (!this.active) return false;
    const version = ++this.version;
    this.update({ status: "loading", data: this.state.data ?? cached });
    try {
      const data = await load();
      if (version !== this.version) return false;
      commit?.(data);
      this.update({ status: "ready", data });
      return true;
    } catch {
      if (version === this.version) this.update({ status: "error", data: this.state.data });
      return false;
    }
  }

  cancel = () => {
    this.active = false;
    this.version += 1;
  };

  activate = () => {
    this.active = true;
  };

  private update(state: ResourceState<T>) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}
