import { render, screen } from "@solidjs/testing-library";
import { describe, expect, test } from "vitest";
import Wordmark from "./Wordmark";

describe("Wordmark", () => {
  test("renders the canonical mark at the default size", () => {
    const { container } = render(() => <Wordmark />);
    const mark = screen.getByText("Remagnet");

    expect(mark.tagName).toBe("SPAN");
    expect(mark.className).toContain("wordmark");
    expect(mark.className).toContain("wordmark-md");
    expect(container.querySelector(".wordmark-surface")).toBeNull();
  });

  test("renders as the page heading with a surface label", () => {
    render(() => <Wordmark as="h1" size="lg" surface="Bridge" />);

    const heading = screen.getByRole("heading", { name: "Remagnet Bridge" });
    expect(heading.tagName).toBe("H1");
    expect(heading.className).toContain("wordmark-lg");
    expect(screen.getByText("Bridge").className).toContain("wordmark-surface");
  });

  test("keeps an optional title for client and server context", () => {
    render(() => <Wordmark title="qBittorrent · https://qbt.example.com" />);

    expect(screen.getByText("Remagnet").getAttribute("title")).toBe(
      "qBittorrent · https://qbt.example.com",
    );
  });
});
