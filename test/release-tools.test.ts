import { describe, expect, it } from "vitest";
// @ts-ignore Release helpers are executable JavaScript tools.
import * as releaseMetadata from "../tools/release-metadata.mjs";
const {
  extractReleaseNotes,
  getUnreleasedNotes,
  promoteUnreleased,
  validateReleaseMetadata,
} = releaseMetadata;
// @ts-ignore Release helpers are executable JavaScript tools.
import * as readmeSynchronization from "../tools/sync-version.mjs";
const { synchronizeReadme } = readmeSynchronization;
// @ts-ignore Release helpers are executable JavaScript tools.
import * as packageChecking from "../tools/check-package.mjs";
const {
  collectPublishedTargets,
  validatePackResult,
} = packageChecking;
// @ts-ignore Release helpers are executable JavaScript tools.
import * as releasePublishing from "../tools/publish-release.mjs";
const { comparePublishedIntegrity } = releasePublishing;
// @ts-ignore Release helpers are executable JavaScript tools.
import * as ciWaiting from "../tools/wait-for-ci.mjs";
const { selectCiRun } = ciWaiting;

const changelog = `# Changelog

## Unreleased

- Fixed a release problem.

## 1.2.3 (2026-07-20)

- Previous work.
`;

describe("release changelog metadata", () => {
  it("promotes Unreleased and recreates an empty section", () => {
    const promoted = promoteUnreleased(changelog, "1.2.4", "2026-07-25");

    expect(promoted).toContain(
      "## Unreleased\n\n## 1.2.4 (2026-07-25)\n\n- Fixed a release problem.",
    );
    expect(extractReleaseNotes(promoted, "1.2.4")).toBe(
      "- Fixed a release problem.",
    );
    expect(() => getUnreleasedNotes(promoted)).toThrow(
      "no notes under “Unreleased”",
    );
  });

  it("rejects missing notes and duplicate release versions", () => {
    expect(() =>
      getUnreleasedNotes("# Changelog\n\n## Unreleased\n\n## 1.0.0 (2026-01-01)\n"),
    ).toThrow("no notes");
    expect(() => promoteUnreleased(changelog, "1.2.3", "2026-07-25")).toThrow(
      "already contains",
    );
  });

  it("requires the tag, package, changelog, and README pin to agree", () => {
    const readme =
      '<script src="https://cdn.jsdelivr.net/npm/justif@1.2.3/dist/auto.js"></script>';
    expect(
      validateReleaseMetadata({
        tag: "v1.2.3",
        packageVersion: "1.2.3",
        changelog,
        readme,
      }).notes,
    ).toBe("- Previous work.");
    expect(() =>
      validateReleaseMetadata({
        tag: "v1.2.4",
        packageVersion: "1.2.3",
        changelog,
        readme,
      }),
    ).toThrow("does not match");
    expect(() =>
      validateReleaseMetadata({
        tag: "v1.2.3",
        packageVersion: "1.2.3",
        changelog,
        readme: readme.replace("@1.2.3", "@1.2.2"),
      }),
    ).toThrow("README.md CDN pin");
  });

  it("pins repository images to the release tag", () => {
    const notes = `<picture>
  <source type="image/avif" srcset="docs/images/example.avif">
  <img src="docs/images/example.png" alt="Example">
</picture>

![Another example](docs/images/another.png)`;
    const releaseChangelog = changelog.replace("- Previous work.", notes);
    const rewritten = validateReleaseMetadata({
      tag: "v1.2.3",
      packageVersion: "1.2.3",
      changelog: releaseChangelog,
      readme:
        '<script src="https://cdn.jsdelivr.net/npm/justif@1.2.3/dist/auto.js"></script>',
    }).notes;
    const assetRoot =
      "https://raw.githubusercontent.com/lyallcooper/justif/v1.2.3/docs/images/";

    expect(rewritten).toContain(`srcset="${assetRoot}example.avif"`);
    expect(rewritten).toContain(`src="${assetRoot}example.png"`);
    expect(rewritten).toContain(`](${assetRoot}another.png)`);
    expect(releaseChangelog).toContain('src="docs/images/example.png"');
  });
});

describe("README release synchronization", () => {
  it("updates the version, crossorigin, and SRI deterministically", () => {
    const asset = new TextEncoder().encode("built artifact");
    const original = `<script
  src="https://cdn.jsdelivr.net/npm/justif@1.2.3/dist/auto.js"
  integrity="sha384-stale"
></script>`;

    const first = synchronizeReadme(original, "1.2.4", () => asset);
    expect(first.scriptCount).toBe(1);
    expect(first.updated).toContain("justif@1.2.4");
    expect(first.updated).toMatch(/integrity="sha384-[A-Za-z0-9+/]+=*"/);
    expect(first.updated).toContain('crossorigin="anonymous"');
    expect(
      synchronizeReadme(first.updated, "1.2.4", () => asset).updated,
    ).toBe(first.updated);
  });
});

describe("npm artifact validation", () => {
  const packageJson = {
    name: "justif",
    version: "1.2.3",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    unpkg: "./dist/auto.js",
    jsdelivr: "./dist/auto.js",
  };
  const packResult = {
    name: "justif",
    version: "1.2.3",
    filename: "justif-1.2.3.tgz",
    integrity: "sha512-example",
    files: [
      { path: "package.json" },
      { path: "README.md" },
      { path: "LICENSE" },
      { path: "dist/index.d.ts" },
      { path: "dist/index.js" },
      { path: "dist/auto.js" },
    ],
  };

  it("covers every export and CDN entry point", () => {
    expect([...collectPublishedTargets(packageJson)]).toEqual([
      "dist/index.d.ts",
      "dist/index.js",
      "dist/auto.js",
    ]);
    expect(validatePackResult(packResult, packageJson).fileCount).toBe(6);
  });

  it("rejects missing exports and leaked private source", () => {
    expect(() =>
      validatePackResult(
        {
          ...packResult,
          files: packResult.files.filter(
            (file) => file.path !== "dist/index.js",
          ),
        },
        packageJson,
      ),
    ).toThrow("missing published target");
    expect(() =>
      validatePackResult(
        { ...packResult, files: [...packResult.files, { path: "tools/release.mjs" }] },
        packageJson,
      ),
    ).toThrow("private source");
  });

  it("makes publish retries idempotent by integrity", () => {
    expect(comparePublishedIntegrity(null, "sha512-a")).toBe("missing");
    expect(comparePublishedIntegrity("sha512-a", "sha512-a")).toBe("matching");
    expect(comparePublishedIntegrity("sha512-b", "sha512-a")).toBe("conflict");
  });
});

describe("CI release gate", () => {
  it("accepts only the newest push run on main", () => {
    expect(
      selectCiRun([
        {
          databaseId: 1,
          event: "pull_request",
          headBranch: "main",
          createdAt: "2026-07-25T01:00:00Z",
        },
        {
          databaseId: 2,
          event: "push",
          headBranch: "feature",
          createdAt: "2026-07-25T02:00:00Z",
        },
        {
          databaseId: 3,
          event: "push",
          headBranch: "main",
          createdAt: "2026-07-25T03:00:00Z",
        },
        {
          databaseId: 4,
          event: "push",
          headBranch: "main",
          createdAt: "2026-07-25T04:00:00Z",
        },
      ]).databaseId,
    ).toBe(4);
  });
});
