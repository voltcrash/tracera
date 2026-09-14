export {
  createCandidateSearchAdapter,
  createExistingDiscoveryAdapters,
  createPrimarySourceResolverAdapter,
  type CandidateDiscoveryClient,
  type CandidateDiscoveryResult,
  type ExistingDiscoveryClients,
} from "./discovery-adapters.js";
export { selectPassageCandidates } from "./passages.js";
export { buildPropositionKey, buildRetrievalQuestions } from "./questions.js";
export { createRetrieveEvidenceV2, retrieveEvidenceV2 } from "./retrieve-evidence.js";
export type {
  AcquiredEvidence,
  CorpusEvidenceMatch,
  CorpusEvidencePort,
  PassageCandidate,
  PassageRerankerPort,
  PrimarySourceResolverPort,
  QueryTransformation,
  RetrievalOptions,
  RetrievalQuestion,
  RetrievalReplayCase,
} from "./types.js";
