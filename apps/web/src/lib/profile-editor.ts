import type { AuthUser } from "./auth-state";

export type ProfileChange =
  | { field: "name"; value: string }
  | { field: "image"; value: string | null };
export type ProfileField = "name" | "image";
export type ProfileSaveResult =
  | { status: "saved"; refreshed: boolean }
  | { status: "failed"; error: string }
  | { status: "busy" | "inactive" };
type Session = { user: AuthUser | null; error: boolean; refreshing?: boolean };
type Edit<Value> = { value: Value; status: "pending" | "confirmed" };
type ProfileEdits = { name?: Edit<string>; image?: Edit<string | null> };

export class ProfileEditor {
  private state: {
    ownerId: string | null;
    edits: ProfileEdits;
    pending: string[];
  } = { ownerId: null, edits: {}, pending: [] };
  private generation = 0;
  private pending = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly io: {
      session: () => Session;
      persist: (ownerId: string, change: ProfileChange) => Promise<void>;
      refresh: () => Promise<void>;
    },
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  receive(session: Session) {
    const ownerId = session.user?.id ?? null;
    if (this.state.ownerId !== ownerId) {
      this.generation += 1;
      this.update({ ownerId, edits: {} });
    }
    if (session.error || session.refreshing || !session.user) return;
    const edits = { ...this.state.edits };
    let changed = false;
    for (const field of ["name", "image"] as const) {
      const edit = edits[field];
      if (edit && (edit.status === "confirmed" || edit.value === session.user[field])) {
        delete edits[field];
        changed = true;
      }
    }
    if (changed) this.update({ edits });
  }

  isPending(ownerId: string, field: ProfileField) {
    return this.pending.has(`${ownerId}:${field}`);
  }

  async save(ownerId: string, change: ProfileChange): Promise<ProfileSaveResult> {
    const session = this.io.session();
    if (session.error || session.user?.id !== ownerId) return { status: "inactive" };
    const field = change.field;
    const key = `${ownerId}:${field}`;
    if (this.isPending(ownerId, field)) return { status: "busy" };
    this.receive(session);
    const generation = this.generation;
    const active = () => generation === this.generation && this.io.session().user?.id === ownerId;
    this.pending.add(key);
    const edits: ProfileEdits =
      change.field === "name"
        ? { ...this.state.edits, name: { value: change.value, status: "pending" } }
        : { ...this.state.edits, image: { value: change.value, status: "pending" } };
    this.update({ edits, pending: [...this.pending] });
    try {
      try {
        await this.io.persist(ownerId, change);
      } catch (error) {
        if (!active()) return { status: "inactive" };
        const edits = { ...this.state.edits };
        delete edits[field];
        this.update({ edits });
        return {
          status: "failed",
          error: error instanceof Error ? error.message : "Unable to save your profile.",
        };
      }
      if (!active()) return { status: "inactive" };
      const confirmed = { ...this.state.edits };
      if (field === "name" && confirmed.name)
        confirmed.name = { ...confirmed.name, status: "confirmed" };
      if (field === "image" && confirmed.image)
        confirmed.image = { ...confirmed.image, status: "confirmed" };
      this.update({ edits: confirmed });
      let refreshed = true;
      try {
        await this.io.refresh();
      } catch {
        refreshed = false;
      }
      if (!active()) return { status: "inactive" };
      const latest = this.io.session();
      if (refreshed) this.receive(latest);
      return { status: "saved", refreshed: refreshed && !latest.error && !latest.refreshing };
    } finally {
      this.pending.delete(key);
      this.update({ pending: [...this.pending] });
    }
  }

  private update(changes: Partial<typeof this.state>) {
    this.state = { ...this.state, ...changes };
    this.listeners.forEach((listener) => listener());
  }
}
