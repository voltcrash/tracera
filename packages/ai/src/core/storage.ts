import { createHash } from "node:crypto";
import {
  documentSnapshotSchema,
  runReportSchema,
  type DocumentSnapshot,
  type RunContext,
} from "@repo/contracts/core-v2";
import { CoreStorageRepository, type CoreAccessScope } from "@repo/db/core";
import type { RunStorePort, SnapshotStorePort } from "./types.js";

export interface RawBlobStore {
  put(request: {
    snapshotId: string;
    bytes: Uint8Array;
    signal: AbortSignal;
  }): Promise<{ status: "stored"; uri: string } | { status: "unavailable"; uri: null }>;
  read(uri: string, signal: AbortSignal): Promise<Uint8Array | null>;
}

export interface SnapshotBounds {
  maxNormalizedBytes: number;
  maxNormalizedCharacters: number;
}

const DEFAULT_SNAPSHOT_BOUNDS: SnapshotBounds = {
  maxNormalizedBytes: 5_000_000,
  maxNormalizedCharacters: 200_000,
};

const sha256 = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
};

function accessScope(context: RunContext): CoreAccessScope {
  return {
    tenantId: context.tenantId,
    ownerUserId: context.ownerUserId,
    visibility: context.visibility,
  };
}

async function validateSnapshotBytes(
  snapshot: DocumentSnapshot,
  blobStore: RawBlobStore | null,
  bounds: SnapshotBounds,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  const encoded = new TextEncoder().encode(snapshot.normalizedText);
  if (encoded.byteLength > bounds.maxNormalizedBytes) {
    throw new Error(`Normalized snapshot exceeds the ${bounds.maxNormalizedBytes}-byte bound.`);
  }
  if (snapshot.normalizedText.length > bounds.maxNormalizedCharacters) {
    throw new Error(
      `Normalized snapshot exceeds the ${bounds.maxNormalizedCharacters}-character bound.`,
    );
  }
  if (
    snapshot.limits.bytesRetained !== encoded.byteLength ||
    snapshot.limits.charactersRetained !== snapshot.normalizedText.length
  ) {
    throw new Error("Snapshot retained-length metadata does not match its normalized text.");
  }
  if (snapshot.contentHash !== sha256(encoded)) {
    throw new Error("Snapshot contentHash does not match its normalized UTF-8 bytes.");
  }
  if (snapshot.blobLocator.status === "stored") {
    if (!snapshot.blobLocator.uri) throw new Error("A stored blob requires a locator URI.");
    if (!snapshot.rawContentHash) throw new Error("A stored blob requires a rawContentHash.");
    if (!blobStore) throw new Error("A stored blob cannot be verified without a RawBlobStore.");
    const rawBytes = await blobStore.read(snapshot.blobLocator.uri, signal);
    throwIfAborted(signal);
    if (!rawBytes) throw new Error("The blob locator did not resolve to stored bytes.");
    if (snapshot.rawContentHash !== sha256(rawBytes)) {
      throw new Error("Snapshot rawContentHash does not match the stored blob bytes.");
    }
  } else if (snapshot.blobLocator.uri !== null) {
    throw new Error("An unavailable blob cannot carry a locator URI.");
  }
}

export function createSnapshotStore(input: {
  repository: CoreStorageRepository;
  context: RunContext;
  blobStore?: RawBlobStore;
  bounds?: SnapshotBounds;
}): SnapshotStorePort {
  const scope = accessScope(input.context);
  const bounds = input.bounds ?? DEFAULT_SNAPSHOT_BOUNDS;
  return {
    async put(snapshot, signal) {
      throwIfAborted(signal);
      const parsed = documentSnapshotSchema.parse(snapshot);
      await validateSnapshotBytes(parsed, input.blobStore ?? null, bounds, signal);
      await input.repository.putSnapshot({
        scope,
        snapshot: parsed,
      });
    },
    async get(id, signal) {
      throwIfAborted(signal);
      const snapshot = await input.repository.getSnapshot({ scope, snapshotId: id });
      throwIfAborted(signal);
      return snapshot ? documentSnapshotSchema.parse(snapshot) : null;
    },
    async getMany(ids, signal) {
      throwIfAborted(signal);
      const snapshots = await input.repository.getSnapshots({ scope, snapshotIds: ids });
      throwIfAborted(signal);
      return snapshots.map((snapshot) => documentSnapshotSchema.parse(snapshot));
    },
  };
}

export function createRunStore(input: {
  repository: CoreStorageRepository;
  context: RunContext;
}): RunStorePort {
  const scope = accessScope(input.context);
  return {
    async checkpoint(request) {
      throwIfAborted(request.signal);
      await input.repository.checkpoint({ scope, ...request });
      throwIfAborted(request.signal);
    },
    async readCheckpoint(request) {
      throwIfAborted(request.signal);
      const checkpoint = await input.repository.readCheckpoint({ scope, ...request });
      throwIfAborted(request.signal);
      return checkpoint;
    },
    async finalize(request) {
      throwIfAborted(request.signal);
      const report = runReportSchema.parse(request.report);
      if (request.runId !== input.context.runId || report.runId !== input.context.runId) {
        throw new Error("Finalized report run identity does not match the storage context.");
      }
      if (report.visibility !== input.context.visibility) {
        throw new Error("Finalized report visibility does not match the storage context.");
      }
      await input.repository.finalize({
        scope,
        runId: request.runId,
        fencingToken: request.fencingToken,
        reportHash: sha256(JSON.stringify(report)),
        report,
      });
      throwIfAborted(request.signal);
    },
  };
}

export { DEFAULT_SNAPSHOT_BOUNDS };
