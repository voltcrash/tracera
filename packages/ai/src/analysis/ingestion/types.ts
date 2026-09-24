import type { DocumentSnapshot, StageResult } from "@repo/contracts/analysis";
import type { DocumentAcquisitionPort } from "../types";

export interface OcrRegion {
  text: string;
  boundingBox: NonNullable<DocumentSnapshot["locators"][number]["boundingBox"]>;
  transcriptionUncertain: boolean;
}

export interface OcrPort {
  readonly provider: string;
  readonly modelId: string;
  recognize(request: {
    bytes: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<{ regions: OcrRegion[] }>;
}

export interface ReverseImageRetrievalPort {
  readonly connector: string;
  search(request: {
    bytes: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<{ status: "performed" | "unavailable"; matchedUrls: string[] }>;
}

export interface ContentCredentialsPort {
  readonly verifier: string;
  inspect(request: {
    bytes: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<{ status: "verified" | "unverified" | "absent" | "unavailable" }>;
}

export interface ReaderFallbackPort {
  readonly provider: string;
  readonly version: string;
  readonly limitations: string[];
  extract(request: {
    html: string;
    url: string;
    signal: AbortSignal;
  }): Promise<{ text: string } | null>;
}

export interface ImageAcquisitionRequest {
  data: string;
  mimeType: string;
  caption: string | null;
  role: DocumentSnapshot["role"];
  maxBytes: number;
  signal: AbortSignal;
}

export interface IngestionDocumentAcquisitionPort extends DocumentAcquisitionPort {
  acquireImage(
    request: ImageAcquisitionRequest,
  ): Promise<StageResult<{ snapshot: DocumentSnapshot }>>;
}

export function supportsImageAcquisition(
  port: DocumentAcquisitionPort,
): port is IngestionDocumentAcquisitionPort {
  return "acquireImage" in port && typeof port.acquireImage === "function";
}
