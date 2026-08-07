import { OllamaProvider, extractClaims, scoreClaim, type EvidenceSource } from "../src/index.js";
const model = process.env.OLLAMA_MODEL ?? "gemma4:e2b"; const provider = new OllamaProvider({ model });
const cases = [
  ["true", "NASA states that carbon dioxide traps heat in Earth's atmosphere."],
  ["false", "The Earth is flat and every satellite image is fabricated."],
  ["misleading", "Vaccines always prevent infection, so a vaccinated person cannot transmit a virus."],
  ["mixed", "Coffee is healthy and guarantees a longer life."],
  ["framing", "Traitor scientists unleashed a shocking climate hoax on the public."],
] as const;
const evidence: EvidenceSource[] = [{ id: "source:1", type: "web_search", title: "Reference evidence", publisher: "Reference", sourceDomain: "example.org", snippet: "Available evidence supports established scientific consensus and does not support absolute or conspiratorial claims.", publishedAt: new Date().toISOString(), credibility: 0.9 }];
const report = [];
for (const [label, text] of cases) { const started = Date.now(); try { const claims = await extractClaims(provider, text); const verdicts = []; for (const claim of claims) verdicts.push(await scoreClaim(provider, claim, evidence)); report.push({ label, schemaValid: true, atomicClaims: claims.length, claims, verdicts: verdicts.map(({ verdict, confidence, reasoning }) => ({ verdict, confidence, reasoning })), durationMs: Date.now() - started }); } catch (error) { report.push({ label, schemaValid: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }); } }
console.log(JSON.stringify({ model, testedAt: new Date().toISOString(), schemaSuccessRate: report.filter((item) => item.schemaValid).length / report.length, report }, null, 2));
