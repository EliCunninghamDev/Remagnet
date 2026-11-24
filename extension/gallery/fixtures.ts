import { type MagnetLink, parseMagnet } from "../lib/magnet";
import type { ParsedTorrentFile } from "../lib/torrent-file";
import type { TorrentSummary } from "../lib/torrents";

/** Deterministic placeholder hashes keep gallery snapshots stable. */
function hash(seed: string): string {
  return seed.padEnd(40, "0").slice(0, 40);
}

const CATEGORY = "remagnet";

function torrent(
  seed: string,
  name: string,
  overrides: Partial<TorrentSummary> = {},
): TorrentSummary {
  return {
    hash: hash(seed),
    name,
    state: "downloading",
    progress: 0.42,
    size: 6_512_230_400,
    downloadSpeed: 8_912_896,
    uploadSpeed: 0,
    eta: 743,
    ratio: 0,
    category: CATEGORY,
    tags: [CATEGORY],
    seeds: 42,
    peers: 7,
    ...overrides,
  };
}

export interface TorrentCase {
  id: string;
  label: string;
  /** Why this state matters, shown under the specimen in the gallery. */
  description: string;
  torrent: TorrentSummary;
  zipping?: boolean;
  removing?: boolean;
  confirming?: boolean;
}

/**
 * Every visual state a row can have. Component tests use the same fixtures, so
 * the gallery and the assertions cannot drift apart.
 */
export const torrentCases: TorrentCase[] = [
  {
    id: "downloading",
    label: "Downloading",
    description: "Live speed, ETA and progress.",
    torrent: torrent("a1", "debian-13.8.0-amd64-netinst.iso", {
      progress: 0.42,
      downloadSpeed: 8_912_896,
      eta: 743,
      peers: 7,
      seeds: 42,
    }),
  },
  {
    id: "stalled",
    label: "Stalled",
    description: "No traffic; the bar turns amber and the ETA is dropped.",
    torrent: torrent("b2", "Fedora-Workstation-Live-44-x86_64.iso", {
      state: "stalled",
      progress: 0.18,
      downloadSpeed: 0,
      eta: 8_640_000,
      peers: 0,
      seeds: 3,
    }),
  },
  {
    id: "paused",
    label: "Paused",
    description: "Stopped torrents read as Paused, not Stopped.",
    torrent: torrent("c3", "archlinux-2026.11.01-x86_64.iso", {
      state: "stopped",
      progress: 0.08,
      downloadSpeed: 0,
      eta: 0,
      peers: 0,
      seeds: 0,
    }),
  },
  {
    id: "complete",
    label: "Complete + Download",
    description: "A finished torrent always offers the archive action.",
    torrent: torrent("d4", "ubuntu-26.04-desktop-amd64.iso", {
      state: "seeding",
      progress: 1,
      downloadSpeed: 0,
      uploadSpeed: 1_468_006,
      eta: 0,
      ratio: 0.35,
      peers: 12,
      seeds: 58,
    }),
  },
  {
    id: "zipping",
    label: "Zipping",
    description: "The Remagnet Proxy is preparing the archive; the bar sweeps.",
    torrent: torrent("e5", "linuxmint-22.3-cinnamon-64bit.iso", {
      state: "seeding",
      progress: 1,
      downloadSpeed: 0,
      eta: 0,
      peers: 2,
      seeds: 18,
    }),
    zipping: true,
  },
  {
    id: "error",
    label: "Error",
    description: "A client-side failure keeps the torrent visible.",
    torrent: torrent("f6", "kali-linux-2026.3-installer-amd64.iso", {
      state: "error",
      progress: 0.31,
      downloadSpeed: 0,
      eta: 0,
      peers: 1,
      seeds: 0,
    }),
  },
  {
    id: "long-name",
    label: "Long name",
    description: "Long names keep their start and extension; the middle is clipped.",
    torrent: torrent(
      "a7",
      "Some.Distributor.Linux.2026.11.Desktop.2160p.HDR.x86_64.GNOME.Wayland.MultiLanguage.Including.Live.Session.REPACK-GROUP.iso",
      {
        progress: 0.67,
        downloadSpeed: 24_117_248,
        eta: 2_408,
      },
    ),
  },
  {
    id: "confirm",
    label: "Remove confirmation",
    description: "Keep files, delete files, or cancel — the confirmation takes the stats line.",
    torrent: torrent("b8", "opensuse-tumbleweed-dvd-x86_64.iso", {
      state: "seeding",
      progress: 1,
      downloadSpeed: 0,
      eta: 0,
      seeds: 11,
      peers: 3,
    }),
    confirming: true,
  },
];

/** A representative list for the full popover specimen. */
export const popoverTorrents: TorrentSummary[] = ["downloading", "stalled", "complete"].flatMap(
  (id) => torrentCases.filter((entry) => entry.id === id).map((entry) => entry.torrent),
);

/** Look up a fixture by id; throws instead of returning undefined in tests. */
export function torrentCase(id: string): TorrentCase {
  const found = torrentCases.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown torrent fixture: ${id}`);
  return found;
}

export const galleryMagnetUri = [
  "magnet:?xt=urn:btih:e75a1a6b922815d64cfa9b8904208d3a85143495",
  "&dn=debian-13.8.0-amd64-netinst.iso",
  "&xl=665845760",
  "&tr=https%3A%2F%2Ftracker.example.org%3A443%2Fannounce",
  "&tr=udp%3A%2F%2Ftracker.example.net%3A1337%2Fannounce",
  "&ws=https%3A%2F%2Fmirror.example.org%2Fdebian.iso",
].join("");

export const galleryMagnet: MagnetLink = (() => {
  const link = parseMagnet(galleryMagnetUri);
  if (!link) throw new Error("Gallery magnet fixture is not a valid magnet URI");
  return link;
})();

/**
 * A parsed `.torrent` file with the metadata a magnet cannot carry: a file
 * list and a private flag. Bytes are a placeholder; nothing uploads a fixture.
 */
export const galleryTorrentFile: ParsedTorrentFile = {
  filename: "ubuntu-26.04-live-server-amd64.torrent",
  dataBase64: "ZHVtbXk=",
  infoHash: hash("f9"),
  displayName: "ubuntu-26.04-live-server-amd64",
  size: 2_147_483_648,
  fileCount: 12,
  trackers: ["https://tracker.example.org:443/announce", "udp://tracker.example.net:1337/announce"],
  webSeeds: ["https://mirror.example.org/ubuntu/"],
  isPrivate: true,
};

/** The same magnet as a torrent already known to the client. */
export const existingTorrent = torrent("e75", "debian-13.8.0-amd64-netinst.iso", {
  state: "downloading",
  progress: 0.64,
  downloadSpeed: 4_194_304,
  eta: 96,
  seeds: 27,
  peers: 5,
});

export const proxyBaseUrl = "https://remagnet.example.com";
