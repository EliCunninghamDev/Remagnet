import { createSignal } from "solid-js";
import PopupList from "../components/PopupList";
import { popoverTorrents, proxyBaseUrl } from "./fixtures";
import { Section, Specimen } from "./Section";

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
        <Specimen label="Loaded" note="Three tracked torrents; completed rows can download.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={popoverTorrents}
                loading={false}
                configured
                serverLabel={proxyBaseUrl}
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
                configured
                actionError="The Remagnet Proxy could not reach qBittorrent."
                serverLabel={proxyBaseUrl}
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

        <Specimen label="Empty" note="Connected, but no Remagnet torrents yet.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                configured
                serverLabel={proxyBaseUrl}
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

        <Specimen label="Get started" note="Fresh install before a proxy is paired or configured.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                configured={false}
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
                configured
                serverLabel={proxyBaseUrl}
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

        <Specimen label="Connection error" note="The configured proxy is unreachable.">
          <div class="theme-popup">
            <main class="popup">
              <PopupList
                torrents={[]}
                loading={false}
                configured
                error="Could not reach the Remagnet Proxy at https://remagnet.example.com."
                serverLabel={proxyBaseUrl}
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
