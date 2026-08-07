export type InputType = "text" | "link" | "image";
export type ClaimType = "factual_assertion" | "opinion" | "framing";
export type Checkability = "checkable" | "needs_context" | "not_checkable";
export type Verdict = "supported" | "contradicted" | "misleading" | "mixed" | "unverified";
export interface NormalizedNewsInput { inputType: InputType; text: string; rawInput: string; sourceUrl?: string; sourceDomain?: string; publishedAt?: string; }
export interface TracePoint { id: string; createdAt: string; score: number; }
export interface AlertPreference { checkId: string; email: string; active: boolean; }
