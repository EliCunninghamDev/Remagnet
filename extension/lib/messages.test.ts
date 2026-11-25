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
});
