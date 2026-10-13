import { z } from "zod";

const keyringSchema = z.object({
  activeVersion: z.number().int().positive(),
  keys: z.record(z.string(), z.string()),
});
const credentialsSchema = z.object({
  apiKey: z.string().min(1).max(4096),
  embeddingApiKey: z.string().min(1).max(4096).optional(),
});
export type ProviderKeyCredentials = z.infer<typeof credentialsSchema>;
export type EncryptedProviderKey = { ciphertext: string; iv: string; encryptionVersion: number };

export class ProviderKeyEncryptionError extends Error {
  constructor() {
    super("Provider key encryption is unavailable. Please contact the site owner.");
    this.name = "ProviderKeyEncryptionError";
  }
}

function decode(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encode(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}

async function encryptionKey(secret: string | undefined, version?: number) {
  try {
    const ring = keyringSchema.parse(JSON.parse(secret ?? ""));
    const selectedVersion = version ?? ring.activeVersion;
    const bytes = decode(ring.keys[String(selectedVersion)] ?? "");
    if (bytes.byteLength !== 32) throw new ProviderKeyEncryptionError();
    const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return { key, version: selectedVersion };
  } catch {
    throw new ProviderKeyEncryptionError();
  }
}

export async function validateProviderKeyEncryption(secret: string | undefined) {
  await encryptionKey(secret);
}

function additionalData(userId: string, provider: string, version: number) {
  return new TextEncoder().encode(
    JSON.stringify(["tracera-provider-key", userId, provider, version]),
  );
}

export async function encryptProviderKey(input: {
  secret: string | undefined;
  userId: string;
  provider: string;
  credentials: ProviderKeyCredentials;
}): Promise<EncryptedProviderKey> {
  try {
    const { key, version } = await encryptionKey(input.secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: additionalData(input.userId, input.provider, version),
      },
      key,
      new TextEncoder().encode(JSON.stringify(credentialsSchema.parse(input.credentials))),
    );
    return {
      ciphertext: encode(new Uint8Array(ciphertext)),
      iv: encode(iv),
      encryptionVersion: version,
    };
  } catch {
    throw new ProviderKeyEncryptionError();
  }
}

export async function decryptProviderKey(input: {
  secret: string | undefined;
  userId: string;
  provider: string;
  encrypted: EncryptedProviderKey;
}): Promise<ProviderKeyCredentials> {
  try {
    const { key, version } = await encryptionKey(input.secret, input.encrypted.encryptionVersion);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(input.encrypted.iv),
        additionalData: additionalData(input.userId, input.provider, version),
      },
      key,
      decode(input.encrypted.ciphertext),
    );
    return credentialsSchema.parse(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new ProviderKeyEncryptionError();
  }
}
