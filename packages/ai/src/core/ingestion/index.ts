export {
  createDocumentAcquisitionPort,
  DEFAULT_CHARACTER_LIMIT,
  DEFAULT_TEXT_BYTE_LIMIT,
  SUPPORTED_IMAGES,
  type DocumentAcquisitionOptions,
} from "./acquisition";
export { extractStructuredHtml, type StructuredHtmlResult } from "./html";
export { normalizeInputV2 } from "./normalize-input";
export { createFilesystemRawBlobStore } from "./raw-blob-store";
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
