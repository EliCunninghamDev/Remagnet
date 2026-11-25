/**
 * Keep every component version in sync and validate release tags.
 *
 * Usage:
 *   bun run version:check            # all component versions agree
 *   bun run version:check v0.2.0     # ...and match the release tag
 *   bun run version:set 0.2.0        # bump everything and refresh bun.lock
 *
 * Run from the repository root.
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const tagPattern = /^v(\d+)\.(\d+)\.(\d+)$/;

const packagePaths = [join(root, "package.json"), join(root, "extension/package.json")];

for (const entry of await readdir(join(root, "packages"), { withFileTypes: true })) {
  if (entry.isDirectory()) {
    packagePaths.push(join(root, "packages", entry.name, "package.json"));
  }
}

const cargoPath = join(root, "proxy/Cargo.toml");
const cargoLockPath = join(root, "proxy/Cargo.lock");
const bunLockPath = join(root, "bun.lock");
const androidPath = join(root, "android/app/build.gradle.kts");

type Versioned = {
  label: string;
  version: string;
};

async function readJsonVersion(path: string): Promise<Versioned> {
  const data = await Bun.file(path).json();
  if (typeof data.name !== "string" || typeof data.version !== "string") {
    throw new Error(`${path} must have string name and version fields`);
  }
  return { label: data.name, version: data.version };
}

type Anchor = {
  path: string;
  label: string;
  pattern: RegExp;
};

/**
 * Every file that stores the component version. Each pattern groups the text
 * before and after the version so `readAnchor` and `writeAnchor` extract or
 * replace exactly the same bytes.
 */
const anchors = {
  cargo: {
    path: cargoPath,
    label: "the package version in Cargo.toml",
    pattern: /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/,
  },
  cargoLock: {
    path: cargoLockPath,
    label: "the proxy version in Cargo.lock",
    pattern: /(\[\[package\]\]\nname = "remagnet-proxy"\nversion = ")([^"]+)(")/,
  },
  android: {
    path: androidPath,
    label: "the Android default version",
    pattern: /(versionName = releaseVersionName \?: ")([^"]+)(")/,
  },
} satisfies Record<string, Anchor>;

function readAnchor(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find ${label}`);
  return match[2];
}

async function writeAnchor(anchor: Anchor, version: string): Promise<void> {
  const source = await Bun.file(anchor.path).text();
  await Bun.write(
    anchor.path,
    source.replace(
      anchor.pattern,
      (_match, prefix: string, _current: string, suffix: string) => `${prefix}${version}${suffix}`,
    ),
  );
}

async function readVersions(): Promise<Versioned[]> {
  const packages: Versioned[] = [];
  for (const path of packagePaths) {
    packages.push(await readJsonVersion(path));
  }
  const versions = [...packages];

  const cargo = await Bun.file(anchors.cargo.path).text();
  versions.push({
    label: "remagnet-proxy (Cargo.toml)",
    version: readAnchor(cargo, anchors.cargo.pattern, anchors.cargo.label),
  });

  const android = await Bun.file(anchors.android.path).text();
  versions.push({
    label: "remagnet (Android default)",
    version: readAnchor(android, anchors.android.pattern, anchors.android.label),
  });

  const cargoLock = await Bun.file(anchors.cargoLock.path).text();
  versions.push({
    label: "remagnet-proxy (Cargo.lock)",
    version: readAnchor(cargoLock, anchors.cargoLock.pattern, anchors.cargoLock.label),
  });

  // Bun does not record a version for the root workspace, so skip it.
  const bunLock = await Bun.file(bunLockPath).text();
  for (const { label } of packages.slice(1)) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const version = readAnchor(
      bunLock,
      new RegExp(`("name": "${escaped}",\\s*"version": ")([^"]+)(")`),
      `${label} in bun.lock`,
    );
    versions.push({ label: `${label} (bun.lock)`, version });
  }

  return versions;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function check(tag?: string): Promise<void> {
  if (tag && !tagPattern.test(tag)) {
    fail(`release tag ${tag} must look like vMAJOR.MINOR.PATCH`);
  }

  const versions = await readVersions();
  const expected = versions[0].version;
  if (!versionPattern.test(expected)) {
    fail(`${versions[0].label} has invalid version ${expected}`);
  }

  const mismatched = versions.filter((entry) => entry.version !== expected);
  if (mismatched.length > 0) {
    console.error(`Versions must all match ${expected}:`);
    for (const entry of versions) {
      console.error(`  ${entry.version.padEnd(12)} ${entry.label}`);
    }
    process.exit(1);
  }

  if (tag && tag.slice(1) !== expected) {
    fail(`tag ${tag} does not match the component version ${expected}`);
  }

  console.log(
    tag
      ? `Version ${expected} matches ${tag} across ${versions.length} files.`
      : `Version ${expected} is consistent across ${versions.length} files.`,
  );
}

async function setVersion(input: string): Promise<void> {
  const version = input.replace(/^v/, "");
  if (!versionPattern.test(version)) {
    fail(`version ${input} must look like MAJOR.MINOR.PATCH`);
  }

  for (const path of packagePaths) {
    const data = await Bun.file(path).json();
    data.version = version;
    await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  for (const anchor of Object.values(anchors)) {
    await writeAnchor(anchor, version);
  }

  // Refresh bun.lock so `bun install --frozen-lockfile` keeps working.
  await $`bun install --silent`.cwd(root);
  await check();
}

const command = process.argv[2] ?? "check";
const argument = process.argv[3];

switch (command) {
  case "check":
    await check(argument);
    break;
  case "set":
    if (!argument) fail("usage: bun run scripts/version.ts set MAJOR.MINOR.PATCH");
    await setVersion(argument);
    break;
  default:
    fail(`unknown command ${command}; use check or set`);
}
