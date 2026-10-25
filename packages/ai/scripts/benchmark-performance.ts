import { completeRunReportExample } from "@repo/contracts/analysis";
import { assignSourceDependence } from "../src/analysis/evidence/dependence.js";
import { projectReport } from "../src/analysis/report-view.js";

const count = 300;
const snapshots = Array.from({ length: count }, (_, index) => ({
  ...structuredClone(completeRunReportExample.snapshots[0]!),
  id: `source-${index}`,
  contentHash: `sha256:${index.toString(16).padStart(64, "0")}`,
  canonicalUrl: `https://publisher${index}.example/article`,
}));
const assessments = snapshots.map((snapshot, index) => {
  const quote = `Unique evidence passage ${index}.`;
  return {
    ...structuredClone(completeRunReportExample.assessments[0]!),
    id: `assessment-${index}`,
    snapshotId: snapshot.id,
    excerpt: {
      ...completeRunReportExample.assessments[0]!.excerpt,
      quote,
      span: { start: 0, end: quote.length },
    },
  };
});

for (let index = 0; index < 3; index++) assignSourceDependence(assessments, snapshots);
const times = Array.from({ length: 9 }, () => {
  const start = performance.now();
  assignSourceDependence(assessments, snapshots);
  return performance.now() - start;
}).sort((left, right) => left - right);

console.log(
  JSON.stringify(
    {
      workload: "source dependence with 300 distinct evidence sources",
      warmups: 3,
      samples: times.length,
      medianMs: times[Math.floor(times.length / 2)],
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      workload: "complete report fixture transport",
      reportBytes: Buffer.byteLength(JSON.stringify(completeRunReportExample)),
      viewBytes: Buffer.byteLength(JSON.stringify(projectReport(completeRunReportExample, "/api"))),
    },
    null,
    2,
  ),
);
