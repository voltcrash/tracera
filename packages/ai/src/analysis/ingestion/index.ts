export {
  createDocumentAcquisitionPort,
  DEFAULT_CHARACTER_LIMIT,
  DEFAULT_TEXT_BYTE_LIMIT,
  SUPPORTED_IMAGES,
  type DocumentAcquisitionOptions,
} from "./acquisition";
export { extractStructuredHtml, type StructuredHtmlResult } from "./html";
export { createR2RawBlobStore } from "./raw-blob-store";
export { normalizeInput } from "./normalize-input";
export {
  supportsImageAcquisition,
  type ContentCredentialsPort,
  type ImageAcquisitionRequest,
  type IngestionDocumentAcquisitionPort,
  type OcrPort,
  type OcrRegion,
  type ReaderFallbackPort,
  type ReverseImageRetrievalPort,
} from "./types";
