import { render, screen } from "@solidjs/testing-library";
import { describe, expect, test } from "vitest";
import Wordmark from "./Wordmark";

describe("Wordmark", () => {
  test("renders the canonical mark at the default size", () => {
    const { container } = render(() => <Wordmark />);
    const mark = container.querySelector(".wordmark");
    const icon = container.querySelector(".wordmark-icon");

    expect(mark?.tagName).toBe("SPAN");
    expect(mark?.className).toContain("wordmark-md");
    expect(container.querySelector(".wordmark-surface")).toBeNull();
    expect(screen.getByText("Remagnet")).toBeTruthy();
    expect(icon?.tagName).toBe("IMG");
    expect(icon?.getAttribute("src")).toBe("/icon/remagnet-small.svg");
    expect(icon?.getAttribute("alt")).toBe("");
    expect(mark?.firstElementChild?.firstElementChild).toBe(icon);
  });

  test("renders as the page heading with a surface label", () => {
    render(() => <Wordmark as="h1" size="lg" surface="Proxy" />);

    const heading = screen.getByRole("heading", { name: "Remagnet Proxy" });
    expect(heading.tagName).toBe("H1");
    expect(heading.className).toContain("wordmark-lg");
    expect(screen.getByText("Proxy").className).toContain("wordmark-surface");
  });

  test("keeps an optional title for client and server context", () => {
    const { container } = render(() => <Wordmark title="qBittorrent · https://qbt.example.com" />);

    expect(container.querySelector(".wordmark")?.getAttribute("title")).toBe(
      "qBittorrent · https://qbt.example.com",
    );
  });
});
