import { execFileSync } from "node:child_process";
import { buildDailyChangelog } from "./daily-changelog.js";
import { getReleaseVersion } from "./version.js";

const productionMarker = "<!-- tracera-production-release -->";
const dateTag = /^v\d{2}\.\d{2}\.\d{2}$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function prepareProductionRelease({ github, context, cwd }) {
  // Delayed and retried runs use the UTC date when release planning executes.
  const date = new Date();
  const tag = getReleaseVersion(date);
  const version = tag.slice(1);
  const sha = git(cwd, "rev-parse", "HEAD");
  if (sha !== context.sha) {
    throw new Error("Release checkout must match the workflow's main commit");
  }

  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const tagExists = git(cwd, "tag", "--list", tag) !== "";
  const tagSha = tagExists ? git(cwd, "rev-parse", `${tag}^{commit}`) : undefined;
  if (tagSha !== undefined && tagSha !== sha)
    throw new Error(`Tag ${tag} points to a different commit`);

  const existing = releases.find((release) => release.tag_name === tag);
  if (existing !== undefined) {
    if (existing.draft || existing.prerelease || !existing.body?.includes(productionMarker)) {
      throw new Error(`Release ${tag} already exists outside the production deployment`);
    }
    if (tagSha === undefined) throw new Error(`Completed release ${tag} has no local tag`);
    return {
      version,
      tag,
      sha,
      shouldDeploy: false,
      skipReason: "already-released",
    };
  }

  const productionReleases = releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        dateTag.test(release.tag_name) &&
        release.body?.includes(productionMarker),
    )
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name));
  const previous = productionReleases[0];
  if (previous !== undefined && previous.tag_name > tag) {
    throw new Error("A newer production release exists; dispatch a new run from main");
  }

  let base;
  if (previous !== undefined) {
    base = previous.tag_name;
    // Fail on rewritten history rather than silently publishing misleading notes.
    git(cwd, "merge-base", "--is-ancestor", base, sha);
  } else {
    // The first midnight release covers the preceding day, without dumping the
    // fork's entire inherited history. Later releases also catch up missed days.
    const dayStart = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - (context.eventName === "schedule" ? 1 : 0),
    );
    base = git(
      cwd,
      "rev-list",
      "--first-parent",
      "-1",
      `--before=${new Date(dayStart - 1000).toISOString()}`,
      sha,
    );
  }

  const repoUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}`;
  // Revision ranges include old-authored branch commits merged today. Filtering
  // commit author dates would lose those changes, and rebase/squash merges.
  const commits = git(
    cwd,
    "log",
    "--reverse",
    "--no-merges",
    "--format=%H%x00%s",
    base ? `${base}..${sha}` : sha,
  );
  if (previous !== undefined && git(cwd, "rev-parse", `${base}^{commit}`) === sha) {
    return {
      version,
      tag,
      sha,
      shouldDeploy: false,
      skipReason: "no-new-commits",
    };
  }
  const changelog = buildDailyChangelog(
    commits
      ? commits.split("\n").map((line) => {
          const [hash, subject] = line.split("\0");
          return { hash, subject };
        })
      : [],
    repoUrl,
  );
  const changes =
    changelog || "No new changes merged to main since the previous production release.";
  const comparison = base
    ? `\n\n**Full changelog:** [${base}...${sha.slice(0, 7)}](${repoUrl}/compare/${base}...${sha})`
    : "";
  const body = `${changes}${comparison}\n\nDeployed to [production](https://tracera.voltcrash.com) from [${sha.slice(0, 7)}](${repoUrl}/commit/${sha}).\n\n${productionMarker}\n`;
  return { version, tag, sha, body, shouldDeploy: true };
}

export async function publishProductionRelease({ github, context, version, tag, sha, body }) {
  return github.rest.repos.createRelease({
    ...context.repo,
    tag_name: tag,
    target_commitish: sha,
    name: version,
    body,
    draft: false,
    prerelease: false,
    make_latest: "true",
  });
}
