/**
 * Local torrent-client development stack for Remagnet.
 *
 * Usage:
 *   bun run scripts/dev-stack.ts up [--client transmission|qbittorrent|deluge|rtorrent] [--seed] [--ephemeral]
 *   bun run scripts/dev-stack.ts proxy [--client transmission|qbittorrent|deluge|rtorrent]
 *   bun run scripts/dev-stack.ts seed [--client transmission|qbittorrent|deluge|rtorrent]
 *   bun run scripts/dev-stack.ts down
 *   bun run scripts/dev-stack.ts clean
 *
 * Run from the repository root. All runtime data lives under `.dev/dev-stack/`
 * (gitignored) or in the named Docker volumes declared in compose.dev.yml.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CLIENTS,
  type ClientKind,
  ensureQbitConfig,
  isClientKind,
} from "../tests/integration/clients";
import { buildTorrentFixture, type TorrentFixture } from "../tests/integration/fixture";

type Command = "up" | "proxy" | "seed" | "down" | "clean";

const ALL_COMPOSE_PROFILES = ["qbit", "deluge", "rtorrent", "proxy"];
const DEFAULT_UID_GID = 1000;

interface Args {
  command: Command | "help";
  client: ClientKind;
  ephemeral: boolean;
  seed: boolean;
}

interface ClientPaths {
  clientRoot: string;
  downloadsDir: string;
  configDir: string;
}

interface SeedResult {
  fixture: TorrentFixture;
  torrentPath: string;
  payloadPath: string | null;
}

const root = resolve(import.meta.dir, "..");
const composeFile = join(root, "compose.dev.yml");
const devRoot = join(root, ".dev/dev-stack");
const fixturesDir = join(devRoot, "fixtures");
const proxyDataDir = join(devRoot, "proxy-data");
const qbitConfigSource = join(root, "tests/integration/qbittorrent-config/qBittorrent.conf");

const USAGE = `Usage: bun run scripts/dev-stack.ts <command> [options]

Commands:
  up [--client transmission|qbittorrent|deluge|rtorrent] [--seed] [--ephemeral]
      Start the dev stack (Transmission by default) in the background.
      --ephemeral runs it in the foreground and cleans up on exit.
  proxy [--client transmission|qbittorrent|deluge|rtorrent]
      Run the Rust proxy locally with cargo against the dev client.
  seed [--client transmission|qbittorrent|deluge|rtorrent]
      Write deterministic .torrent fixtures into .dev/dev-stack/fixtures.
  down
      Stop containers, keeping volumes and .dev/dev-stack.
  clean
      Stop containers and delete volumes plus .dev/dev-stack.

Options:
  --client <kind>   Torrent client: transmission, qbittorrent, deluge, or
                    rtorrent (default: transmission)
  --seed            Seed fixtures and pre-place the completed payload
  --ephemeral       Run in the foreground and auto-clean on exit
  --help            Show this help`;

try {
  const args = parseArgs(Bun.argv.slice(2));
  await main(args);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main(args: Args): Promise<void> {
  switch (args.command) {
    case "help":
      console.log(USAGE);
      return;
    case "up":
      if (args.ephemeral) {
        await upEphemeral(args.client, args.seed);
      } else {
        await upPersistent(args.client, args.seed);
      }
      return;
    case "proxy":
      await runProxy(args.client);
      return;
    case "seed":
      printSeedResults(await seedFixtures(args.client));
      console.log(`\nFixtures directory: ${fixturesDir}`);
      return;
    case "down":
      await runCompose(ALL_COMPOSE_PROFILES, ["down", "--remove-orphans"]);
      console.log("Stopped the dev stack (volumes and .dev/dev-stack kept).");
      return;
    case "clean":
      await cleanStack();
      console.log("Stopped the dev stack and removed volumes plus .dev/dev-stack.");
      return;
  }
}

async function upPersistent(client: ClientKind, seed: boolean): Promise<void> {
  await ensureClientDirs(client);
  const seeded = seed ? await seedFixtures(client) : [];
  const profiles = clientProfiles(client);

  await runCompose(profiles, ["up", "-d", client]);
  printNextSteps(client, seeded);
}

async function upEphemeral(client: ClientKind, seed: boolean): Promise<void> {
  await ensureClientDirs(client);
  const seeded = seed ? await seedFixtures(client) : [];
  if (seeded.length > 0) printSeedResults(seeded);

  const profiles = clientProfiles(client);
  console.log(`Starting an ephemeral ${CLIENTS[client].label} stack.`);
  console.log("Press Ctrl+C to stop it and remove containers, volumes, and .dev/dev-stack.\n");

  let proc: Bun.Subprocess | undefined;
  let interrupted = false;

  const stop = (signal: "SIGINT" | "SIGTERM") => {
    interrupted = true;
    proc?.kill(signal);
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");

  try {
    proc = Bun.spawn(composeCommand(profiles, ["up", client]), {
      cwd: root,
      env: { ...process.env, ...composeEnvironment() },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const code = await proc.exited;
    if (!interrupted && code !== 0) {
      throw new Error(`docker compose up exited with code ${code}.`);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    console.log("\nCleaning up the ephemeral dev stack...");
    await cleanStack();
  }
}

async function runProxy(client: ClientKind): Promise<void> {
  const { downloadsDir } = clientPaths(client);
  await mkdir(proxyDataDir, { recursive: true });
  await mkdir(downloadsDir, { recursive: true });
  if (client === "transmission" || client === "rtorrent") {
    await mkdir(join(downloadsDir, "complete"), { recursive: true });
  }

  const clientInfo = CLIENTS[client];
  const env: Record<string, string | undefined> = {
    ...process.env,
    DATA_DIR: process.env.DATA_DIR ?? proxyDataDir,
    BIND_ADDR: process.env.BIND_ADDR ?? "127.0.0.1:8080",
    CLIENT_KIND: process.env.CLIENT_KIND ?? client,
    CLIENT_BASE_URL: process.env.CLIENT_BASE_URL ?? clientInfo.hostBaseUrl,
    DOWNLOADS_DIR: process.env.DOWNLOADS_DIR ?? downloadsDir,
    CLIENT_DOWNLOADS_DIR: process.env.CLIENT_DOWNLOADS_DIR ?? "/downloads",
    REMAGNET_CATEGORY: process.env.REMAGNET_CATEGORY ?? clientInfo.defaultCategory,
    REMAGNET_TAGS: process.env.REMAGNET_TAGS ?? clientInfo.defaultTags.join(","),
  };

  if (client === "qbittorrent") {
    env.QBIT_USERNAME = process.env.QBIT_USERNAME ?? "admin";
    env.QBIT_PASSWORD = process.env.QBIT_PASSWORD ?? "adminadmin";
  }

  if (client === "deluge") {
    env.DELUGE_PASSWORD = process.env.DELUGE_PASSWORD ?? "deluge";
  }

  const code = await run(["cargo", "run", "--manifest-path", join(root, "proxy/Cargo.toml")], {
    env,
  });
  process.exitCode = code;
}

async function seedFixtures(client: ClientKind): Promise<SeedResult[]> {
  const { downloadsDir } = clientPaths(client);
  const payloadDir =
    client === "transmission" || client === "rtorrent"
      ? join(downloadsDir, "complete")
      : downloadsDir;
  await mkdir(fixturesDir, { recursive: true });
  await mkdir(payloadDir, { recursive: true });

  const complete = await buildTorrentFixture("remagnet-dev-complete.bin", "remagnet-dev-complete");
  const sample = await buildTorrentFixture("remagnet-dev-sample.bin", "remagnet-dev-sample");

  return [
    await writeSeed("remagnet-dev-complete", complete, payloadDir),
    await writeSeed("remagnet-dev-sample", sample, null),
  ];
}

async function writeSeed(
  baseName: string,
  fixture: TorrentFixture,
  payloadDir: string | null,
): Promise<SeedResult> {
  const torrentPath = join(fixturesDir, `${baseName}.torrent`);
  await writeFile(torrentPath, fixture.torrentBytes);

  let payloadPath: string | null = null;
  if (payloadDir !== null) {
    payloadPath = join(payloadDir, fixture.name);
    await writeFile(payloadPath, fixture.payloadBytes);
  }

  return { fixture, torrentPath, payloadPath };
}

async function ensureClientDirs(client: ClientKind): Promise<void> {
  const { downloadsDir, configDir } = clientPaths(client);
  await mkdir(downloadsDir, { recursive: true });

  if (client === "transmission") {
    await mkdir(join(downloadsDir, "complete"), { recursive: true });
    return;
  }

  if (client === "rtorrent") {
    await mkdir(join(downloadsDir, "complete"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    return;
  }

  if (client === "deluge") {
    await mkdir(configDir, { recursive: true });
    return;
  }

  await ensureQbitConfig(configDir, qbitConfigSource);
}

async function cleanStack(): Promise<void> {
  try {
    await runCompose(ALL_COMPOSE_PROFILES, ["down", "-v", "--remove-orphans"], {
      allowFailure: true,
    });
  } catch (error) {
    console.warn(
      `docker compose down failed (${error instanceof Error ? error.message : String(error)});`,
      "removing local dev data anyway.",
    );
  } finally {
    await rm(devRoot, { recursive: true, force: true });
  }
}

function composeCommand(profiles: string[], action: string[]): string[] {
  const profileArgs = profiles.flatMap((profile) => ["--profile", profile]);
  return ["docker", "compose", "-f", composeFile, ...profileArgs, ...action];
}

async function runCompose(
  profiles: string[],
  action: string[],
  options: { allowFailure?: boolean } = {},
): Promise<number> {
  return run(composeCommand(profiles, action), {
    ...options,
    env: composeEnvironment(),
  });
}

async function run(
  command: string[],
  options: { allowFailure?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const proc = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0 && options.allowFailure !== true) {
    throw new Error(`Command failed with exit code ${code}: ${command.join(" ")}`);
  }
  return code;
}

function composeEnvironment(): Record<string, string> {
  return {
    PUID: String(process.getuid?.() ?? DEFAULT_UID_GID),
    PGID: String(process.getgid?.() ?? DEFAULT_UID_GID),
  };
}

function clientPaths(client: ClientKind): ClientPaths {
  const clientRoot = join(devRoot, client);
  return {
    clientRoot,
    downloadsDir: join(clientRoot, "downloads"),
    configDir: join(clientRoot, "config"),
  };
}

function clientProfiles(client: ClientKind): string[] {
  const profile = CLIENTS[client].composeProfile;
  return profile === null ? [] : [profile];
}

function printSeedResults(results: SeedResult[]): void {
  console.log("Seeded fixtures:");
  for (const result of results) {
    console.log(`  ${result.torrentPath}`);
    console.log(`    info hash: ${result.fixture.infoHash}`);
    if (result.payloadPath !== null) {
      console.log(`    complete payload: ${result.payloadPath}`);
    }
  }
}

function printNextSteps(client: ClientKind, seeded: SeedResult[]): void {
  const { downloadsDir } = clientPaths(client);

  console.log(`\nRemagnet dev stack is running (${CLIENTS[client].label}).`);
  switch (client) {
    case "qbittorrent":
      console.log("  Web UI:    http://127.0.0.1:18080 (admin / adminadmin)");
      break;
    case "deluge":
      console.log("  Web UI:    http://127.0.0.1:18112 (password: deluge)");
      break;
    case "rtorrent":
      console.log(
        "  Web UI:    http://127.0.0.1:18082 (ruTorrent, no authentication on localhost)",
      );
      console.log("  XML-RPC:   http://127.0.0.1:18000");
      break;
    case "transmission":
      console.log("  Web UI:    http://127.0.0.1:19091 (no authentication on localhost)");
      break;
  }
  console.log(`  Downloads: ${downloadsDir}`);

  if (seeded.length > 0) {
    console.log("\nSeeded fixtures:");
    for (const result of seeded) {
      const hint = result.payloadPath === null ? "no payload pre-placed" : "100% complete";
      console.log(`  ${result.torrentPath} (${hint})`);
    }
  }

  console.log("\nNext steps:");
  if (client === "transmission") {
    console.log("  bun run dev:proxy");
  } else {
    console.log(`  bun run dev:proxy -- --client ${client}`);
  }
  console.log("  bun run dev:down      # stop containers, keep volumes and downloads");
  console.log("  bun run dev:clean     # stop containers and delete volumes + .dev/dev-stack");
}

function parseArgs(argv: string[]): Args {
  let command: Args["command"] | undefined;
  let client: ClientKind = "transmission";
  let ephemeral = false;
  let seed = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--ephemeral") {
      ephemeral = true;
      continue;
    }
    if (arg === "--seed") {
      seed = true;
      continue;
    }
    if (arg === "--client") {
      const value = argv[index + 1];
      if (!isClientKind(value)) {
        throw new Error(
          `--client must be "transmission", "qbittorrent", "deluge", or "rtorrent".\n\n${USAGE}`,
        );
      }
      client = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--client=")) {
      const value = arg.slice("--client=".length);
      if (!isClientKind(value)) {
        throw new Error(
          `--client must be "transmission", "qbittorrent", "deluge", or "rtorrent".\n\n${USAGE}`,
        );
      }
      client = value;
      continue;
    }
    if (command === undefined && isCommand(arg)) {
      command = arg;
      continue;
    }
    if (command === undefined && arg === "help") {
      command = "help";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }

  if (help || command === undefined) {
    return { command: "help", client, ephemeral, seed };
  }

  return { command, client, ephemeral, seed };
}

function isCommand(value: string): value is Command {
  return (
    value === "up" || value === "proxy" || value === "seed" || value === "down" || value === "clean"
  );
}
