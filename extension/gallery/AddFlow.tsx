import { createSignal } from "solid-js";
import AddedSummary from "../components/AddedSummary";
import type { FlowStatus } from "../components/flow-status";
import MagnetForm from "../components/MagnetForm";
import MagnetReview from "../components/MagnetReview";
import { existingTorrent, galleryMagnet, galleryMagnetUri } from "./fixtures";
import { Section, Specimen } from "./Section";

const invalid: FlowStatus = {
  tone: "error",
  message: "That magnet link has no usable BitTorrent info hash.",
};

const failed: FlowStatus = {
  tone: "error",
  message: "The Remagnet Proxy could not reach qBittorrent.",
};

function InteractiveMagnetForm(props: {
  draft?: string;
  status?: FlowStatus;
  canCancel?: boolean;
}) {
  const [draft, setDraft] = createSignal(props.draft ?? "");
  return (
    <MagnetForm
      draft={draft()}
      status={props.status}
      canCancel={Boolean(props.canCancel)}
      onDraftChange={setDraft}
      onSubmit={(event) => event.preventDefault()}
      onCancel={() => setDraft("")}
    />
  );
}

function InteractiveMagnetReview(props: {
  existing?: boolean;
  busy?: boolean;
  status?: FlowStatus;
}) {
  const [paused, setPaused] = createSignal(false);
  return (
    <MagnetReview
      link={galleryMagnet}
      existing={props.existing ? existingTorrent : undefined}
      paused={paused()}
      busy={Boolean(props.busy)}
      status={props.status}
      onEdit={() => undefined}
      onSubmit={(event) => event.preventDefault()}
      onPausedChange={setPaused}
    />
  );
}

function PopupSpecimen(props: { children: import("solid-js").JSX.Element }) {
  return (
    <div class="theme-popup">
      <main class="popup">
        <section class="add-flow stack">{props.children}</section>
      </main>
    </div>
  );
}

/** The four visual states of the add flow. */
export default function AddFlow() {
  return (
    <Section
      id="add"
      title="Add flow"
      description="The same presentational components AddTorrent composes. The live flow adds lookup and submit behavior on top."
    >
      <div class="popover-gallery">
        <Specimen label="Paste" note="Empty input; Continue stays disabled.">
          <PopupSpecimen>
            <InteractiveMagnetForm />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Invalid magnet" note="The error sits under the form, not in a toast.">
          <PopupSpecimen>
            <InteractiveMagnetForm draft="magnet:?dn=no-hash" status={invalid} canCancel />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Review" note="Parsed name, hash, size, trackers and web seeds.">
          <PopupSpecimen>
            <InteractiveMagnetReview />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Already added" note="Send is disabled and the existing row is named.">
          <PopupSpecimen>
            <InteractiveMagnetReview existing />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Sending" note="The primary button reports progress.">
          <PopupSpecimen>
            <InteractiveMagnetReview busy />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Submit error" note="The proxy's rejection message is shown in place.">
          <PopupSpecimen>
            <InteractiveMagnetReview status={failed} />
          </PopupSpecimen>
        </Specimen>

        <Specimen
          label="Added (popover)"
          note="The popover returns to the list, but the full page keeps this summary."
        >
          <PopupSpecimen>
            <AddedSummary
              name={galleryMagnet.displayName ?? galleryMagnetUri}
              category="remagnet"
              tags={["remagnet", "linux"]}
              embedded
              onAddAnother={() => undefined}
              onClose={() => undefined}
            />
          </PopupSpecimen>
        </Specimen>

        <Specimen label="Added (page)" note="The fallback add page uses the full-page labels.">
          <PopupSpecimen>
            <AddedSummary
              name={galleryMagnet.displayName ?? galleryMagnetUri}
              category="remagnet"
              tags={["remagnet", "linux"]}
              embedded={false}
              onAddAnother={() => undefined}
              onClose={() => undefined}
            />
          </PopupSpecimen>
        </Specimen>
      </div>
    </Section>
  );
}
