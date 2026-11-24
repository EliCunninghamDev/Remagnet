import { createSignal, onMount, Show } from "solid-js";
import type { FlowStatus } from "./flow-status";

export interface TorrentFileUploadProps {
  status?: FlowStatus;
  /** Offer Cancel when a previously parsed `.torrent` file can be restored. */
  canCancel?: boolean;
  /** Focus the upload drop area when the window/tab opens. */
  autoFocus?: boolean;
  onFileSelect: (file: File) => void;
  onCancel?: () => void;
}

/**
 * Focused `.torrent` upload surface used when the toolbar popover hands file
 * selection to a window or tab, where the native picker can stay open.
 */
export default function TorrentFileUpload(props: TorrentFileUploadProps) {
  const [dragging, setDragging] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let dragDepth = 0;

  onMount(() => {
    if (props.autoFocus) trigger?.focus();
  });

  function handleDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent) {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) props.onFileSelect(file);
  }

  return (
    <section class="panel stack upload-panel">
      <button
        ref={trigger}
        type="button"
        class="upload-zone"
        classList={{ "upload-zone-active": dragging() }}
        onClick={() => fileInput?.click()}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span class="upload-icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
            <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            <path d="M12 12v6" />
            <path d="m15 15-3-3-3 3" />
          </svg>
        </span>
        <span class="upload-title">
          {dragging() ? "Drop .torrent file to upload" : "Drag and drop a file to upload or click"}
        </span>
        <span class="upload-hint">.torrent files up to 10 MiB</span>
      </button>

      <input
        ref={fileInput}
        type="file"
        accept=".torrent,application/x-bittorrent"
        hidden
        onChange={(event) => {
          const input = event.currentTarget;
          const file = input.files?.[0];
          if (file) props.onFileSelect(file);
          // Reset so choosing the same file again still fires a change event.
          input.value = "";
        }}
      />

      <Show when={props.canCancel && props.onCancel}>
        <div class="actions">
          <button class="ghost" type="button" onClick={() => props.onCancel?.()}>
            Cancel
          </button>
        </div>
      </Show>

      <Show when={props.status}>
        {(current) => <p class={`status ${current().tone}`}>{current().message}</p>}
      </Show>
    </section>
  );
}
