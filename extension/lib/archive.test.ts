import { describe, expect, test } from "bun:test";
import { archiveFilename } from "./archive";

describe("archiveFilename", () => {
  test("keeps readable names and strips unsafe characters", () => {
    expect(archiveFilename("Trailer Park Boys")).toBe("Trailer Park Boys.zip");
    expect(archiveFilename("Show/Season: 1")).toBe("Show_Season_ 1.zip");
    expect(archiveFilename("../../")).toBe("torrent.zip");
    expect(archiveFilename("")).toBe("torrent.zip");
  });

  test("limits very long names", () => {
    expect(archiveFilename("x".repeat(300))).toBe(`${"x".repeat(140)}.zip`);
  });
});
