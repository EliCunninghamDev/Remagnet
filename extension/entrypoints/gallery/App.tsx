import Wordmark from "../../components/Wordmark";
import AddFlow from "../../gallery/AddFlow";
import Controls from "../../gallery/Controls";
import Foundations from "../../gallery/Foundations";
import Popover from "../../gallery/Popover";
import { Section } from "../../gallery/Section";
import Torrents from "../../gallery/Torrents";

const NAV = [
  { href: "#foundations", label: "Foundations" },
  { href: "#type", label: "Typography" },
  { href: "#space", label: "Space & motion" },
  { href: "#controls", label: "Controls" },
  { href: "#torrents", label: "Torrent rows" },
  { href: "#popover", label: "Popover" },
  { href: "#add", label: "Add flow" },
  { href: "#pages", label: "Live pages" },
] as const;

export default function App() {
  return (
    <div class="gallery-shell">
      <aside class="gallery-nav">
        <Wordmark as="p" surface="Components" />
        <nav aria-label="Gallery sections">
          <span class="nav-group">Tokens</span>
          {NAV.slice(0, 3).map((item) => (
            <a href={item.href}>{item.label}</a>
          ))}
          <span class="nav-group">Components</span>
          {NAV.slice(3).map((item) => (
            <a href={item.href}>{item.label}</a>
          ))}
        </nav>
        <p class="nav-note">
          Dev-only. Built from the same components and CSS as the extension, so this page is the
          visual reference when changing the design.
        </p>
      </aside>

      <main class="gallery-main">
        <header class="gallery-intro">
          <p class="eyebrow">Design oracle</p>
          <h1>Component gallery</h1>
          <p>
            The real Solid components and <code>app.css</code> rendered in a browser. Use this page
            to review every state, compare light and dark tokens, and capture screenshots without
            configuring a torrent client.
          </p>
          <div class="gallery-meta">
            <a href="/options.html">Options page</a>
            <a href="/add.html">Add page</a>
            <a href="/popup.html">Popover page</a>
          </div>
        </header>

        <Foundations />
        <Controls />
        <Torrents />
        <Popover />
        <AddFlow />

        <Section
          id="pages"
          title="Live pages"
          description="The packaged surfaces, opened directly. They read real settings and talk to the background worker, so they are useful for end-to-end checks rather than fixed states."
        >
          <div class="page-links">
            <a class="page-link" href="/popup.html">
              <strong>Popover</strong>
              <span>The normal torrent list and add flow at 440px.</span>
            </a>
            <a class="page-link" href="/add.html">
              <strong>Add page</strong>
              <span>Protocol-handler fallback, including the paste form.</span>
            </a>
            <a class="page-link" href="/options.html">
              <strong>Options</strong>
              <span>Client settings, archive bridge and permission prompts.</span>
            </a>
          </div>
        </Section>
      </main>
    </div>
  );
}
