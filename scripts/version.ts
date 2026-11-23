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
const semver = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/;
const expectedTag = /^v\d+\.\d+\.\d+$/;

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

async function readCargoVersion(): Promise<Versioned> {
  const source = await Bun.file(cargoPath).text();
  const match = source.match(/\[package\][\s\S]*?\nversion = "([^"]+)"/);
  if (!match) throw new Error(`Could not find the package version in ${cargoPath}`);
  return { label: "remagnet-proxy (Cargo.toml)", version: match[1] };
}

function readAnchor(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find ${label}`);
  return match[1];
}

async function readVersions(): Promise<Versioned[]> {
  const versions: Versioned[] = [];
  for (const path of packagePaths) {
    versions.push(await readJsonVersion(path));
  }
  versions.push(await readCargoVersion());

  const android = await Bun.file(androidPath).text();
  versions.push({
    label: "remagnet (Android default)",
    version: readAnchor(
      android,
      /versionName = releaseVersionName \?: "([^"]+)"/,
      "the Android default version",
    ),
  });

  const cargoLock = await Bun.file(cargoLockPath).text();
  versions.push({
    label: "remagnet-proxy (Cargo.lock)",
    version: readAnchor(
      cargoLock,
      /\[\[package\]\]\nname = "remagnet-proxy"\nversion = "([^"]+)"/,
      "the proxy version in Cargo.lock",
    ),
  });

  // Bun does not record a version for the root workspace, so skip it.
  const bunLock = await Bun.file(bunLockPath).text();
  for (const path of packagePaths.slice(1)) {
    const { label } = await readJsonVersion(path);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const version = readAnchor(
      bunLock,
      new RegExp(`"name": "${escaped}",\\s*"version": "([^"]+)"`),
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
  if (tag && !expectedTag.test(tag)) {
    fail(`release tag ${tag} must look like vMAJOR.MINOR.PATCH`);
  }

  const versions = await readVersions();
  const expected = versions[0].version;
  if (!semver.test(expected)) {
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

async function setVersion(version: string): Promise<void> {
  if (!semver.test(version)) {
    fail(`version ${version} must look like MAJOR.MINOR.PATCH`);
  }

  for (const path of packagePaths) {
    const data = await Bun.file(path).json();
    data.version = version;
    await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  const cargo = await Bun.file(cargoPath).text();
  await Bun.write(
    cargoPath,
    cargo.replace(/(\[package\][\s\S]*?\nversion = ")[^"]+(")/, `$1${version}$2`),
  );

  const cargoLock = await Bun.file(cargoLockPath).text();
  await Bun.write(
    cargoLockPath,
    cargoLock.replace(
      /(\[\[package\]\]\nname = "remagnet-proxy"\nversion = ")[^"]+(")/,
      `$1${version}$2`,
    ),
  );

  const android = await Bun.file(androidPath).text();
  await Bun.write(
    androidPath,
    android.replace(/(versionName = releaseVersionName \?: ")[^"]+(")/, `$1${version}$2`),
  );

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
