import { describe, expect, test } from "bun:test";
import { buildIssueReport, redactSensitiveText } from "./issue-report";

const HASH40 = "0123456789abcdef0123456789abcdef01234567";
const HASH64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("redactSensitiveText", () => {
  test("replaces magnets", () => {
    expect(
      redactSensitiveText(
        `Added magnet:?xt=urn:btih:${HASH40}&dn=Some.Release&tr=udp%3A%2F%2Ftracker.example`,
      ),
    ).toBe("Added [redacted-magnet]");
  });

  test("replaces URLs, including query strings that carry tokens", () => {
    expect(redactSensitiveText("GET https://proxy.example.com/api?token=rmg_abc123 failed")).toBe(
      "GET [redacted-url] failed",
    );
    expect(redactSensitiveText("see http://127.0.0.1:8080/api/torrents for details")).toBe(
      "see [redacted-url] for details",
    );
  });

  test("replaces device tokens and qBittorrent API keys", () => {
    expect(redactSensitiveText("token rmg_abcDEF-123_xyz was rejected")).toBe(
      "token [redacted-token] was rejected",
    );
    expect(redactSensitiveText("qbt_abcdef1234567890 expired")).toBe("[redacted-key] expired");
  });

  test("replaces Bearer headers regardless of case", () => {
    expect(redactSensitiveText("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSensitiveText("authorization: bearer xyz")).toBe(
      "authorization: Bearer [redacted]",
    );
  });

  test("replaces 40- and 64-character hashes", () => {
    expect(redactSensitiveText(`hash ${HASH40} done`)).toBe("hash [redacted-hash] done");
    expect(redactSensitiveText(`hash ${HASH64} done`)).toBe("hash [redacted-hash] done");
    expect(redactSensitiveText(`hash ${HASH40.toUpperCase()} done`)).toBe(
      "hash [redacted-hash] done",
    );
  });

  test("replaces IPv4 addresses and optional ports", () => {
    expect(redactSensitiveText("proxy at 192.168.1.20 refused")).toBe(
      "proxy at [redacted-ip] refused",
    );
    expect(redactSensitiveText("proxy at 10.0.0.5:8080 refused")).toBe(
      "proxy at [redacted-ip] refused",
    );
  });

  test("leaves ordinary text untouched", () => {
    const text = "The popup stayed empty after adding a torrent.";
    expect(redactSensitiveText(text)).toBe(text);
  });

  test("redacts several kinds of sensitive data in one message", () => {
    const input = [
      `Torrent magnet:?xt=urn:btih:${HASH40}`,
      "at https://proxy.example.com/add?token=rmg_secret",
      `with key qbt_secret and hash ${HASH64}`,
      "from 172.16.0.9:8443",
      "using Authorization: Bearer abc123",
    ].join(" ");

    expect(redactSensitiveText(input)).toBe(
      [
        "Torrent [redacted-magnet]",
        "at [redacted-url]",
        "with key [redacted-key] and hash [redacted-hash]",
        "from [redacted-ip]",
        "using Authorization: Bearer [redacted]",
      ].join(" "),
    );
  });
});

describe("buildIssueReport", () => {
  test("builds the minimal diagnostics block and links", () => {
    const report = buildIssueReport({ component: "Firefox extension", version: "1.2.3" });

    expect(report.component).toBe("Firefox extension");
    expect(report.version).toBe("1.2.3");
    expect(report.diagnostics).toBe("Component: Firefox extension\nVersion: 1.2.3");

    const github = new URL(report.githubUrl);
    expect(github.origin + github.pathname).toBe(
      "https://github.com/EliCunninghamDev/Remagnet/issues/new",
    );
    expect(github.searchParams.get("template")).toBe("bug_report.yml");
    expect(github.searchParams.get("component")).toBe("Firefox extension");
    expect(github.searchParams.get("version")).toBe("1.2.3");
    expect(github.searchParams.get("diagnostics")).toBe(report.diagnostics);

    expect(report.mailtoUrl.startsWith("mailto:contact@elijahcunningham.dev?")).toBe(true);
    const query = new URLSearchParams(report.mailtoUrl.split("?")[1]);
    expect(query.get("subject")).toBe("Remagnet bug report (Firefox extension 1.2.3)");
    expect(query.get("body")).toContain("Please describe what happened");
    expect(query.get("body")).toContain(report.diagnostics);
  });

  test("includes and redacts the optional context", () => {
    const report = buildIssueReport({
      component: "Chrome extension",
      version: "0.2.0",
      platform: "Linux x86_64",
      context: {
        action: "torrents:add",
        status: 502,
        code: "proxy_unreachable",
        backend: "https://admin:qbt_secret@qbt.example.com:8080",
        message: `Could not reach https://proxy.example.com using Bearer rmg_secret for ${HASH40} at 10.1.2.3`,
      },
    });

    expect(report.diagnostics).toBe(
      [
        "Component: Chrome extension",
        "Version: 0.2.0",
        "Platform: Linux x86_64",
        "Backend: [redacted-url]",
        "Action: torrents:add",
        "HTTP status: 502",
        "Error code: proxy_unreachable",
        "Error message: Could not reach [redacted-url] using Bearer [redacted] for [redacted-hash] at [redacted-ip]",
      ].join("\n"),
    );

    const github = new URL(report.githubUrl);
    expect(github.searchParams.get("diagnostics")).toBe(report.diagnostics);

    const query = new URLSearchParams(report.mailtoUrl.split("?")[1]);
    expect(query.get("subject")).toBe("Remagnet bug report (Chrome extension 0.2.0)");
    expect(query.get("body")).toContain(report.diagnostics);
  });

  test("omits blank optional values", () => {
    const report = buildIssueReport({
      component: "Firefox extension",
      version: "1.0.0",
      platform: "   ",
      context: { action: "  ", message: "  ", code: "  ", backend: "  " },
    });

    expect(report.diagnostics).toBe("Component: Firefox extension\nVersion: 1.0.0");
  });

  test("keeps the GitHub URL under 2000 characters", () => {
    const report = buildIssueReport({
      component: "Firefox extension",
      version: "1.0.0",
      context: { message: "x".repeat(5000) },
    });

    expect(report.githubUrl.length).toBeLessThan(2000);
    const github = new URL(report.githubUrl);
    expect(github.searchParams.get("diagnostics")).toEndWith("(truncated)");
    // The payload keeps the full redacted block for copy/paste and mail.
    expect(report.diagnostics.length).toBeGreaterThan(5000);
    expect(report.diagnostics).toContain("x".repeat(5000));
  });
});
