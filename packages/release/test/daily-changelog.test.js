import { describe, expect, it } from "vite-plus/test";
import { buildDailyChangelog } from "../src/daily-changelog.js";

const repoUrl = "https://github.com/voltcrash/tracera";
const hash = (n) => String(n).repeat(40);

describe("buildDailyChangelog", () => {
  it("groups user facing commits into sections in a fixed order", () => {
    const notes = buildDailyChangelog(
      [
        { hash: hash(1), subject: "fix(settings): preserve OAuth state" },
        { hash: hash(2), subject: "feat: add evidence viewer" },
        { hash: hash(3), subject: "impr(reports): cite captured snapshots" },
      ],
      repoUrl,
    );
    expect(notes).toBe(
      [
        "### Features",
        "",
        `- add evidence viewer ([2222222](${repoUrl}/commit/${hash(2)}))`,
        "",
        "### Improvements",
        "",
        `- **reports:** cite captured snapshots ([3333333](${repoUrl}/commit/${hash(3)}))`,
        "",
        "### Fixes",
        "",
        `- **settings:** preserve OAuth state ([1111111](${repoUrl}/commit/${hash(1)}))`,
      ].join("\n"),
    );
  });

  it("lists other commits under other changes with their type", () => {
    const notes = buildDailyChangelog(
      [
        { hash: hash(1), subject: "refactor(utils): remove helper" },
        { hash: hash(2), subject: "chore: bump deps" },
        { hash: hash(3), subject: "tidy up" },
      ],
      repoUrl,
    );
    expect(notes).toContain("### Other changes\n\n");
    expect(notes).toContain("- **refactor(utils):** remove helper (");
    expect(notes).toContain("- **chore:** bump deps (");
    expect(notes).toContain("- tidy up (");
    expect(notes).not.toContain("### Features");
  });

  it("links squash merged pull requests", () => {
    const notes = buildDailyChangelog(
      [{ hash: hash(1), subject: "ci(production): add daily releases (#28)" }],
      repoUrl,
    );
    expect(notes).toContain(
      `- **ci(production):** add daily releases ([#28](${repoUrl}/pull/28)) ([1111111](${repoUrl}/commit/${hash(1)}))`,
    );
  });

  it("omits github merge commits", () => {
    const notes = buildDailyChangelog(
      [
        {
          hash: hash(1),
          subject: "Merge pull request #26 from voltcrash/settings",
        },
        { hash: hash(2), subject: "Merge branch 'main' into settings" },
        { hash: hash(3), subject: "feat(settings): add sidebar" },
      ],
      repoUrl,
    );
    expect(notes).not.toContain("Merge");
    expect(notes).toContain("add sidebar");
  });

  it("returns an empty string without commits", () => {
    expect(buildDailyChangelog([], repoUrl)).toBe("");
  });

  it("escapes markdown in scopes and messages", () => {
    const notes = buildDailyChangelog(
      [{ hash: hash(1), subject: "fix(a_b): handle [x](y) <img>" }],
      repoUrl,
    );
    expect(notes).toContain("**a\\_b:** handle \\[x\\](y) \\<img\\>");
  });
});
