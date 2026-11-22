import { For } from "solid-js";
import { Section, Specimen } from "./Section";

const STATE_TONES = [
  { tone: "active", label: "Downloading" },
  { tone: "good", label: "Ready" },
  { tone: "warn", label: "Stalled" },
  { tone: "bad", label: "Error" },
  { tone: "idle", label: "Paused" },
] as const;

/** Buttons, status messages, badges and form controls. */
export default function Controls() {
  return (
    <Section
      id="controls"
      title="Controls"
      description="The shared primitives from app.css. These are the pieces the popover, add page and settings page compose."
    >
      <div class="foundation-grid">
        <Specimen label="Buttons">
          <div class="actions">
            <button type="button">Send to qBittorrent</button>
            <button type="button" class="ghost">
              Cancel
            </button>
            <button type="button" class="ghost danger">
              Delete files
            </button>
            <button type="button" disabled>
              Disabled
            </button>
            <button type="button" class="linkish">
              Dismiss
            </button>
            <button type="button" class="client-link">
              Open qBittorrent
            </button>
          </div>
        </Specimen>

        <Specimen label="Status messages">
          <div class="stack-tight">
            <p class="status ok">Sent “debian-13.8.0-amd64-netinst.iso” to qBittorrent.</p>
            <p class="status warn">
              Already in qBittorrent: <strong>debian-13.8.0-amd64-netinst.iso</strong>.
            </p>
            <p class="status error">qBittorrent rejected the request (403 Forbidden).</p>
          </div>
        </Specimen>
      </div>

      <div class="foundation-grid">
        <Specimen label="State labels">
          <div class="actions">
            <For each={STATE_TONES}>
              {(state) => <span class={`state ${state.tone}`}>{state.label}</span>}
            </For>
            <span class="count-badge mono">3</span>
            <span class="badge">recommended</span>
          </div>
        </Specimen>

        <Specimen label="Fields" class="wide">
          <div class="stack-tight">
            <label class="field">
              <span>Web UI URL</span>
              <input type="url" placeholder="https://qbt.example.com" value="" />
              <small>Include the scheme and port. A reverse-proxy path works too.</small>
            </label>
            <div class="field-row">
              <label class="field">
                <span>Category</span>
                <input type="text" placeholder="remagnet" value="" />
              </label>
              <label class="field">
                <span>Tags</span>
                <input type="text" placeholder="remagnet, linux" value="" />
              </label>
            </div>
          </div>
        </Specimen>
      </div>

      <div class="foundation-grid">
        <Specimen label="Radio row">
          <fieldset class="field">
            <legend>Authentication</legend>
            <div class="radio-row">
              <label class="radio">
                <input type="radio" name="gallery-auth" checked />
                <span>
                  API key <span class="badge">recommended</span>
                </span>
              </label>
              <label class="radio">
                <input type="radio" name="gallery-auth" />
                <span>Username &amp; password</span>
              </label>
            </div>
          </fieldset>
        </Specimen>

        <Specimen label="Checkboxes">
          <div class="actions">
            <label class="check">
              <input type="checkbox" checked />
              <span>Remember this choice</span>
            </label>
            <label class="check compact">
              <input type="checkbox" />
              <span>Add paused</span>
            </label>
          </div>
        </Specimen>
      </div>

      <Specimen label="Textarea">
        <label class="field">
          <span>Magnet link</span>
          <textarea rows={3} placeholder="magnet:?xt=urn:btih:…" />
          <small>Click a magnet link in Firefox and it opens here, or paste one above.</small>
        </label>
      </Specimen>
    </Section>
  );
}
