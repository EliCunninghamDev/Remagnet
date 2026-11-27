import { describe, expect, test } from "bun:test";
import { isBackgroundRequest, isTrustedExtensionSender } from "./messages";

describe("isTrustedExtensionSender", () => {
  const extensionId = "extension@remagnet.app";
  const extensionOrigin = "moz-extension://1234-5678/";

  test("accepts extension-owned pages with matching id and origin", () => {
    expect(
      isTrustedExtensionSender(
        { id: extensionId, url: `${extensionOrigin}popup.html` },
        extensionId,
        extensionOrigin,
      ),
    ).toBe(true);
    expect(
      isTrustedExtensionSender(
        { id: extensionId, url: `${extensionOrigin}options.html` },
        extensionId,
        extensionOrigin,
      ),
    ).toBe(true);
    expect(
      isTrustedExtensionSender(
        { id: extensionId, url: `${extensionOrigin}add.html#magnet%3A%3Fxt%3Durn%3Abtih%3Aabc` },
        extensionId,
        extensionOrigin,
      ),
    ).toBe(true);
  });

  test("rejects content scripts running on web pages", () => {
    expect(
      isTrustedExtensionSender(
        { id: extensionId, url: "https://example.com/torrents" },
        extensionId,
        extensionOrigin,
      ),
    ).toBe(false);
  });

  test("rejects other extensions and missing sender metadata", () => {
    expect(
      isTrustedExtensionSender(
        { id: "other@extension", url: `${extensionOrigin}popup.html` },
        extensionId,
        extensionOrigin,
      ),
    ).toBe(false);
    expect(isTrustedExtensionSender({ id: extensionId }, extensionId, extensionOrigin)).toBe(false);
    expect(isTrustedExtensionSender(undefined, extensionId, extensionOrigin)).toBe(false);
  });
});

describe("isBackgroundRequest", () => {
  test("accepts valid typed requests and rejects malformed payloads", () => {
    expect(isBackgroundRequest({ type: "torrents:list" })).toBe(true);
    expect(isBackgroundRequest({ type: "torrents:add", urls: ["magnet:?xt=urn:btih:abc"] })).toBe(
      true,
    );
    expect(isBackgroundRequest({ type: "torrents:add" })).toBe(false);
    expect(isBackgroundRequest({ type: "context:link", href: "magnet:?xt=urn:btih:abc" })).toBe(
      false,
    );
    expect(isBackgroundRequest(null)).toBe(false);
  });

  test("accepts pause requests with non-empty hashes", () => {
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: ["a".repeat(40)] })).toBe(true);
    expect(
      isBackgroundRequest({ type: "torrents:pause", hashes: ["a".repeat(40), "b".repeat(64)] }),
    ).toBe(true);
  });

  test("rejects pause requests without valid hashes", () => {
    expect(isBackgroundRequest({ type: "torrents:pause" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: [] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: "abc" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: [""] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: ["abc", 42] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:pause", hashes: [null] })).toBe(false);
  });

  test("accepts resume requests with non-empty hashes", () => {
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: ["a".repeat(40)] })).toBe(true);
    expect(
      isBackgroundRequest({ type: "torrents:resume", hashes: ["a".repeat(40), "b".repeat(64)] }),
    ).toBe(true);
  });

  test("rejects resume requests without valid hashes", () => {
    expect(isBackgroundRequest({ type: "torrents:resume" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: [] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: "abc" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: [""] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: ["abc", 42] })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:resume", hashes: [null] })).toBe(false);
  });

  test("accepts bulk pause and resume requests", () => {
    expect(isBackgroundRequest({ type: "torrents:pauseAll" })).toBe(true);
    expect(isBackgroundRequest({ type: "torrents:resumeAll" })).toBe(true);
  });

  test("accepts file listing requests with a non-empty hash", () => {
    expect(isBackgroundRequest({ type: "torrents:files", hash: "a".repeat(40) })).toBe(true);
  });

  test("rejects file listing requests without a valid hash", () => {
    expect(isBackgroundRequest({ type: "torrents:files" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:files", hash: "" })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:files", hash: 42 })).toBe(false);
    expect(isBackgroundRequest({ type: "torrents:files", hash: null })).toBe(false);
  });

  test("accepts single-file download requests with a valid index", () => {
    expect(
      isBackgroundRequest({ type: "archive:downloadFile", hash: "a".repeat(40), index: 0 }),
    ).toBe(true);
    expect(
      isBackgroundRequest({
        type: "archive:downloadFile",
        hash: "a".repeat(40),
        index: 7,
        name: "Example/Episode.mkv",
      }),
    ).toBe(true);
  });

  test("rejects single-file download requests with an invalid index or name", () => {
    expect(isBackgroundRequest({ type: "archive:downloadFile", hash: "a".repeat(40) })).toBe(false);
    expect(isBackgroundRequest({ type: "archive:downloadFile", hash: "", index: 0 })).toBe(false);
    expect(
      isBackgroundRequest({ type: "archive:downloadFile", hash: "a".repeat(40), index: -1 }),
    ).toBe(false);
    expect(
      isBackgroundRequest({ type: "archive:downloadFile", hash: "a".repeat(40), index: 1.5 }),
    ).toBe(false);
    expect(
      isBackgroundRequest({ type: "archive:downloadFile", hash: "a".repeat(40), index: "0" }),
    ).toBe(false);
    expect(
      isBackgroundRequest({
        type: "archive:downloadFile",
        hash: "a".repeat(40),
        index: 0,
        name: 42,
      }),
    ).toBe(false);
  });
});
