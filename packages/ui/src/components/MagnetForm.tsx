import { createSignal, onMount, Show } from "solid-js";
import type { FlowStatus } from "./flow-status";

export interface MagnetFormProps {
  draft: string;
  status?: FlowStatus;
  /** Offer Cancel when a previously parsed magnet or torrent file can be restored. */
  canCancel: boolean;
  /**
   * The toolbar popover. A native file picker would close the popup, so the
   * chooser hands off to `add.html?source=file` instead.
   */
  embedded?: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: (event: SubmitEvent) => void;
  onCancel: () => void;
  /** Receives a `.torrent` file from the chooser or a drop. */
  onFileSelect?: (file: File) => void;
  /** Open the full add page for choosing a file, instead of a native picker. */
  onOpenFilePickerSurface?: () => void;
  /** Focus the file chooser when `add.html?source=file` opens. */
  autoFocusFile?: boolean;
}

/** Paste-a-magnet form used before a link or torrent file has been parsed. */
export default function MagnetForm(props: MagnetFormProps) {
  const [dragging, setDragging] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  let chooseButton: HTMLButtonElement | undefined;

  onMount(() => {
    if (props.autoFocusFile) chooseButton?.focus();
  });

  function chooseFile() {
    if (props.embedded && props.onOpenFilePickerSurface) {
      props.onOpenFilePickerSurface();
      return;
    }
    fileInput?.click();
  }

  function dropFile(event: DragEvent) {
    event.preventDefault();
    setDragging(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) props.onFileSelect?.(file);
  }

  return (
    <form class="stack" onSubmit={props.onSubmit}>
      <label class="field">
        <span>Magnet link</span>
        <textarea
          rows={3}
          spellcheck={false}
          placeholder="magnet:?xt=urn:btih:…"
          value={props.draft}
          onInput={(event) => props.onDraftChange(event.currentTarget.value)}
        />
        <small>
          Click a magnet link in Firefox and it opens here, or paste one above. Drop or choose a
          .torrent file below.
        </small>
      </label>
      {/* Drag and drop is pointer-only; the choose button is the keyboard path. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target mirrors the choose button. */}
      <div
        class="dropzone"
        classList={{ "dropzone-active": dragging() }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={dropFile}
      >
        <span class="dropzone-hint">Drop a .torrent file here, or</span>
        <button ref={chooseButton} class="ghost" type="button" onClick={chooseFile}>
          Choose .torrent file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".torrent,application/x-bittorrent"
          hidden
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            if (file) props.onFileSelect?.(file);
            // Reset so choosing the same file again still fires a change event.
            input.value = "";
          }}
        />
      </div>
      <div class="actions">
        <button type="submit" disabled={!props.draft.trim()}>
          Continue
        </button>
        <Show when={props.canCancel}>
          <button class="ghost" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </Show>
      </div>
      <Show when={props.status}>
        {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
      </Show>
    </form>
  );
}
