const sections = [
  { title: "Features", types: ["feat"] },
  { title: "Improvements", types: ["impr", "perf"] },
  { title: "Fixes", types: ["fix"] },
];

const conventionalSubject = /^(\w+)(?:\(([^)]+)\))?!?:\s+(.+)$/;
// GitHub merge commits only repeat the branch name; their commits are listed.
const pullRequestSuffix = /\s+\(#(\d+)\)$/;
const mergeSubject = /^Merge (?:pull request|branch|remote-tracking branch) /;

function escapeMarkdown(value) {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&");
}

function parseCommit({ hash, subject }) {
  const pr = pullRequestSuffix.exec(subject)?.[1];
  const title = subject.replace(pullRequestSuffix, "");
  const match = conventionalSubject.exec(title);
  if (match === null) {
    return { hash, pr, type: undefined, scope: undefined, message: title };
  }
  const [, type, scope, message] = match;
  return { hash, pr, type: type.toLowerCase(), scope, message };
}

function formatCommit(commit, repoUrl, includeType) {
  const label = includeType
    ? `${commit.type}${commit.scope ? `(${commit.scope})` : ""}`
    : commit.scope;
  const prefix = label ? `**${escapeMarkdown(label)}:** ` : "";
  const pr = commit.pr ? ` ([#${commit.pr}](${repoUrl}/pull/${commit.pr}))` : "";
  return `- ${prefix}${escapeMarkdown(commit.message)}${pr} ([${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash}))`;
}

/**
 * Groups commits into user-facing release note sections.
 * @param {{ hash: string, subject: string }[]} commits oldest first
 * @param {string} repoUrl
 * @returns {string} Markdown, or an empty string when nothing is listed.
 */
export function buildDailyChangelog(commits, repoUrl) {
  const parsed = commits.filter((commit) => !mergeSubject.test(commit.subject)).map(parseCommit);

  const blocks = [];
  for (const section of sections) {
    const items = parsed.filter((commit) => section.types.includes(commit.type));
    if (items.length === 0) continue;
    blocks.push(
      `### ${section.title}\n\n${items.map((commit) => formatCommit(commit, repoUrl, false)).join("\n")}`,
    );
  }

  const listedTypes = new Set(sections.flatMap((section) => section.types));
  const other = parsed.filter((commit) => !listedTypes.has(commit.type));
  if (other.length > 0) {
    blocks.push(
      `### Other changes\n\n${other.map((commit) => formatCommit(commit, repoUrl, commit.type !== undefined)).join("\n")}`,
    );
  }

  return blocks.join("\n\n");
}
