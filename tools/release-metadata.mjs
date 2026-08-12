import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_PATTERN = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const VERSION_RE = new RegExp(`^${VERSION_PATTERN}$`);
const RAW_REPOSITORY_URL =
  "https://raw.githubusercontent.com/lyallcooper/justif";

export function parseChangelog(changelog) {
  const headings = [
    ...changelog.matchAll(/^## (Unreleased|[^\s(]+)(?: \(([^)]+)\))?\s*$/gm),
  ];
  return headings.map((heading, index) => {
    const bodyStart = heading.index + heading[0].length;
    const bodyEnd = headings[index + 1]?.index ?? changelog.length;
    return {
      name: heading[1],
      date: heading[2],
      notes: changelog.slice(bodyStart, bodyEnd).trim(),
    };
  });
}

export function getUnreleasedNotes(changelog) {
  const sections = parseChangelog(changelog);
  const unreleased = sections.filter((section) => section.name === "Unreleased");
  if (unreleased.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one "## Unreleased" section; found ${unreleased.length}`,
    );
  }
  if (!unreleased[0].notes) {
    throw new Error("CHANGELOG.md has no notes under “Unreleased”");
  }
  return unreleased[0].notes;
}

export function extractReleaseNotes(changelog, version) {
  assertVersion(version);
  const matches = parseChangelog(changelog).filter(
    (section) => section.name === version,
  );
  if (matches.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one section for ${version}; found ${matches.length}`,
    );
  }
  if (!matches[0].date) {
    throw new Error(`CHANGELOG.md section ${version} is missing its release date`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(matches[0].date)) {
    throw new Error(
      `CHANGELOG.md section ${version} has invalid date ${matches[0].date}`,
    );
  }
  if (!matches[0].notes) {
    throw new Error(`CHANGELOG.md section ${version} has no release notes`);
  }
  return matches[0].notes;
}

export function promoteUnreleased(changelog, version, date) {
  assertVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid release date: ${date}`);
  }

  const sections = parseChangelog(changelog);
  const duplicates = sections.filter((section) => section.name === version);
  if (duplicates.length > 0) {
    throw new Error(`CHANGELOG.md already contains a ${version} section`);
  }

  const notes = getUnreleasedNotes(changelog);
  const headingMatches = [
    ...changelog.matchAll(/^## Unreleased\s*$/gm),
  ];
  const heading = headingMatches[0];
  const nextHeading = changelog.indexOf("\n## ", heading.index + heading[0].length);
  const end = nextHeading === -1 ? changelog.length : nextHeading + 1;
  const replacement =
    `## Unreleased\n\n` +
    `## ${version} (${date})\n\n${notes}\n\n`;

  return changelog.slice(0, heading.index) + replacement + changelog.slice(end);
}

function rewriteReleaseImageUrls(notes, tag) {
  if (!tag.startsWith("v")) {
    throw new Error(`Invalid release tag: ${tag}`);
  }
  assertVersion(tag.slice(1));
  const assetRoot = `${RAW_REPOSITORY_URL}/${tag}/`;
  const rewritePath = (path) =>
    path.startsWith("docs/images/") ? `${assetRoot}${path}` : path;

  return notes
    .replace(
      /\b(src|srcset)=(['"])([^'"]+)\2/g,
      (_attribute, name, quote, value) => {
        const rewritten = value
          .split(",")
          .map((candidate) => {
            const match = candidate.match(/^(\s*)(\S+)(.*)$/);
            if (!match) return candidate;
            return `${match[1]}${rewritePath(match[2])}${match[3]}`;
          })
          .join(",");
        return `${name}=${quote}${rewritten}${quote}`;
      },
    )
    .replace(
      /(!\[[^\]]*\]\()(docs\/images\/[^)\s]+)(\))/g,
      (_image, opening, path, closing) =>
        `${opening}${rewritePath(path)}${closing}`,
    );
}

export function validateReleaseMetadata({
  tag,
  packageVersion,
  changelog,
  readme,
}) {
  assertVersion(packageVersion);
  const expectedTag = `v${packageVersion}`;
  if (tag !== expectedTag) {
    throw new Error(
      `Tag ${tag || "(missing)"} does not match package.json version ${packageVersion}`,
    );
  }

  const unreleased = parseChangelog(changelog).filter(
    (section) => section.name === "Unreleased",
  );
  if (unreleased.length !== 1) {
    throw new Error(
      `CHANGELOG.md must contain exactly one "## Unreleased" section; found ${unreleased.length}`,
    );
  }

  const notes = rewriteReleaseImageUrls(
    extractReleaseNotes(changelog, packageVersion),
    tag,
  );
  const pins = [
    ...readme.matchAll(
      new RegExp(`/npm/justif@(${VERSION_PATTERN})/`, "g"),
    ),
  ].map((match) => match[1]);
  if (pins.length === 0) {
    throw new Error("README.md contains no versioned jsDelivr justif URL");
  }

  const stalePins = pins.filter((version) => version !== packageVersion);
  if (stalePins.length > 0) {
    throw new Error(
      `README.md CDN pin ${stalePins[0]} does not match package.json version ${packageVersion}`,
    );
  }

  return { version: packageVersion, notes };
}

function assertVersion(version) {
  if (!VERSION_RE.test(version)) {
    throw new Error(`Invalid package version: ${version}`);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command !== "verify") {
    throw new Error(
      "Usage: node tools/release-metadata.mjs verify --tag vX.Y.Z [--notes-file path] [--github-output path]",
    );
  }

  const options = parseArgs(args);
  if (!options.tag) {
    throw new Error("--tag is required");
  }

  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  const result = validateReleaseMetadata({
    tag: options.tag,
    packageVersion: packageJson.version,
    changelog: readFileSync("CHANGELOG.md", "utf8"),
    readme: readFileSync("README.md", "utf8"),
  });

  if (options["notes-file"]) {
    writeFileSync(options["notes-file"], `${result.notes}\n`);
  }
  if (options["github-output"]) {
    writeFileSync(options["github-output"], `version=${result.version}\n`, {
      flag: "a",
    });
  }
  console.log(`Release metadata verified for justif@${result.version}`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
