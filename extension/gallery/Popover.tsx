import { createSignal } from "solid-js";
import PopupList from "../components/PopupList";
import { clientLabel, popoverTorrents } from "./fixtures";
import { Section, Specimen } from "./Section";

const SERVER = "https://qbt.example.com";

/** The complete popover list view in each data state. */
export default function Popover() {
  const [confirming, setConfirming] = createSignal<string>();

  return (
    <Section
      id="popover"
      title="Popover"
      description="The real PopupList at its production width. Every state is driven by props, not by storage or the background worker."
    >
      <div class="popover-gallery">
        <Specimen label="Loaded" note="Three tracked torrents, archive ready.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={popoverTorrents}
                loading={false}
                filterActive
                filterDescription="category 'remagnet'"
                clientLabel={clientLabel}
                serverLabel={SERVER}
                archiveReady
                confirmingHash={confirming()}
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={(torrent) =>
                  setConfirming(confirming() === torrent.hash ? undefined : torrent.hash)
                }
                onRemove={() => setConfirming(undefined)}
                onCancelRemove={() => setConfirming(undefined)}
              />
            </main>
          </div>
        </Specimen>

        <Specimen
          label="Action error"
          note="A remove or download request failed; the list stays usable."
        >
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={popoverTorrents}
                loading={false}
                actionError="The archive bridge could not reach qBittorrent."
                filterActive
                filterDescription="category 'remagnet'"
                clientLabel={clientLabel}
                serverLabel={SERVER}
                archiveReady
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={() => undefined}
                onRemove={() => undefined}
                onCancelRemove={() => undefined}
              />
            </main>
          </div>
        </Specimen>

        <Specimen label="Empty (filtered)" note="No torrents match the configured category/tags.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                filterActive
                filterDescription="category 'remagnet'"
                clientLabel={clientLabel}
                serverLabel={SERVER}
                archiveReady={false}
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={() => undefined}
                onRemove={() => undefined}
                onCancelRemove={() => undefined}
              />
            </main>
          </div>
        </Specimen>

        <Specimen
          label="Empty (unfiltered)"
          note="Filtering is off, so every client torrent counts."
        >
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                filterActive={false}
                filterDescription=""
                clientLabel={clientLabel}
                serverLabel={SERVER}
                archiveReady={false}
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={() => undefined}
                onRemove={() => undefined}
                onCancelRemove={() => undefined}
              />
            </main>
          </div>
        </Specimen>

        <Specimen label="Loading" note="The first list request is still in flight.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading
                filterActive
                filterDescription="category 'remagnet'"
                clientLabel={clientLabel}
                serverLabel="Loading…"
                archiveReady={false}
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={() => undefined}
                onRemove={() => undefined}
                onCancelRemove={() => undefined}
              />
            </main>
          </div>
        </Specimen>

        <Specimen label="Connection error" note="Unconfigured or unreachable client.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                error="Could not reach qBittorrent at https://qbt.example.com."
                filterActive
                filterDescription="category 'remagnet'"
                clientLabel={clientLabel}
                serverLabel={SERVER}
                archiveReady={false}
                onRetry={() => undefined}
                onOpenSettings={() => undefined}
                onDismissActionError={() => undefined}
                onAdd={() => undefined}
                onZip={() => undefined}
                onRemoveToggle={() => undefined}
                onRemove={() => undefined}
                onCancelRemove={() => undefined}
              />
            </main>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
