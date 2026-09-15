export {
  createCandidateSearchAdapter,
  createExistingDiscoveryAdapters,
  createPrimarySourceResolverAdapter,
  type CandidateDiscoveryClient,
  type CandidateDiscoveryResult,
  type ExistingDiscoveryClients,
} from "./discovery-adapters";
export { selectPassageCandidates } from "./passages";
export { buildPropositionKey, buildRetrievalQuestions } from "./questions";
export { createRetrieveEvidenceV2, retrieveEvidenceV2 } from "./retrieve-evidence";
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
} from "./types";
