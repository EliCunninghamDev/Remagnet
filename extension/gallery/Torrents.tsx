import { createSignal, For } from "solid-js";
import TorrentCard from "../components/TorrentCard";
import { torrentCases } from "./fixtures";
import { Section, Specimen } from "./Section";

/** Every row state, rendered with the real TorrentCard in the popover theme. */
export default function Torrents() {
  const [confirming, setConfirming] = createSignal<string>();

  return (
    <Section
      id="torrents"
      title="Torrent rows"
      description="One specimen per state. Remove is interactive: open a confirmation, then cancel or close it."
    >
      <div class="torrent-grid">
        <For each={torrentCases}>
          {(item) => (
            <Specimen label={item.label} note={item.description}>
              <div class="theme-popup specimen-popup">
                <ul class="torrent-list">
                  <TorrentCard
                    torrent={item.torrent}
                    zipping={Boolean(item.zipping)}
                    removing={Boolean(item.removing)}
                    confirming={Boolean(item.confirming) || confirming() === item.torrent.hash}
                    onZip={() => undefined}
                    onTogglePause={() => undefined}
                    onRemoveToggle={() =>
                      setConfirming(
                        confirming() === item.torrent.hash ? undefined : item.torrent.hash,
                      )
                    }
                    onRemove={() => setConfirming(undefined)}
                    onCancelRemove={() => setConfirming(undefined)}
                  />
                </ul>
              </div>
            </Specimen>
          )}
        </For>
      </div>
    </Section>
  );
}
