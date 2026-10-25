import { createHash } from "node:crypto";
import type { R2Bucket } from "@cloudflare/workers-types";

export const MAX_D1_PAYLOAD_BYTES = 1_500_000;
export type PayloadKind = "run-inputs" | "checkpoints" | "snapshots" | "reports" | "responses";
export interface StoredPayload {
  hash: string;
  inline: string | null;
  blobUri: string | null;
}
export type StoredProjection<T> = T | { r2Payload: { uri: string; hash: string } };

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const sha256 = (value: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const hashJson = (value: unknown) => sha256(canonicalJson(value));

export class D1PayloadError extends Error {}

export class D1PayloadStore {
  constructor(private readonly bucket?: Pick<R2Bucket, "get" | "put">) {}

  async encodeProjection<T>(value: T): Promise<string> {
    const json = canonicalJson(value);
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const payload = await this.encodeJson(
      json,
      "reports",
      bytes(JSON.stringify(json)) - bytes(json),
    );
    return (
      payload.inline ?? JSON.stringify({ r2Payload: { uri: payload.blobUri, hash: payload.hash } })
    );
  }

  async readProjection<T>(value: StoredProjection<T>): Promise<T> {
    if (value && typeof value === "object" && "r2Payload" in value) {
      const pointer = value.r2Payload;
      return (await this.read({ inline: null, blobUri: pointer.uri, hash: pointer.hash })) as T;
    }
    return value;
  }

  async encode(
    value: unknown,
    kind: PayloadKind,
    extraBytes = 0,
    forceBlob = false,
  ): Promise<StoredPayload> {
    return this.encodeJson(canonicalJson(value), kind, extraBytes, forceBlob);
  }

  private async encodeJson(
    inline: string,
    kind: PayloadKind,
    extraBytes = 0,
    forceBlob = false,
  ): Promise<StoredPayload> {
    const bytes = new TextEncoder().encode(inline);
    const hash = sha256(bytes);
    if (!forceBlob && bytes.byteLength + extraBytes <= MAX_D1_PAYLOAD_BYTES)
      return { inline, hash, blobUri: null };
    if (!this.bucket) throw new D1PayloadError("Large payload storage requires the R2 binding.");
    const key = `payloads/${kind}/${hash.slice("sha256:".length)}`;
    await this.bucket.put(key, bytes);
    return { inline: null, hash, blobUri: `r2://${key}` };
  }

  async read(pointer: {
    inline: string | null;
    blobUri: string | null;
    hash?: string;
  }): Promise<unknown> {
    let text = pointer.inline;
    if (text === null) {
      const uri = pointer.blobUri;
      if (
        !uri ||
        uri.trim() !== uri ||
        !/^r2:\/\/payloads\/(run-inputs|checkpoints|snapshots|reports|responses)\/[a-f0-9]{64}$/.test(
          uri,
        )
      )
        throw new D1PayloadError("Invalid stored payload pointer.");
      if (!this.bucket) throw new D1PayloadError("Stored payload requires the R2 binding.");
      const object = await this.bucket.get(uri.slice("r2://".length));
      if (!object) throw new D1PayloadError("Stored payload is unavailable.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      const expectedHash = `sha256:${uri.split("/").at(-1)!}`;
      if (sha256(bytes) !== expectedHash || (pointer.hash && pointer.hash !== expectedHash))
        throw new D1PayloadError("Stored payload hash mismatch.");
      text = new TextDecoder().decode(bytes);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new D1PayloadError("Stored payload is not valid JSON.");
    }
    if (pointer.hash && hashJson(value) !== pointer.hash)
      throw new D1PayloadError("Stored payload hash mismatch.");
    return value;
  }
}
