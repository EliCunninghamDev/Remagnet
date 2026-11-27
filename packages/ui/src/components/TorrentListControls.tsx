import { For, Show } from "solid-js";
import type { TorrentFilter, TorrentSort } from "../lib/torrents";

export interface TorrentListControlsProps {
  query: string;
  filter: TorrentFilter;
  sort: TorrentSort;
  counts: Record<TorrentFilter, number>;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: TorrentFilter) => void;
  onSortChange: (sort: TorrentSort) => void;
}

const FILTERS: ReadonlyArray<{ id: TorrentFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "ready", label: "Ready" },
  { id: "paused", label: "Paused" },
];

const SORTS: ReadonlyArray<{ id: TorrentSort; label: string }> = [
  { id: "added", label: "Newest" },
  { id: "name", label: "Name" },
  { id: "progress", label: "Progress" },
  { id: "size", label: "Size" },
  { id: "speed", label: "Speed" },
];

/** Search, sort and filter controls shared by every torrent list surface. */
export default function TorrentListControls(props: TorrentListControlsProps) {
  return (
    <div class="list-controls">
      <div class="list-controls-row">
        <input
          class="list-search"
          type="search"
          spellcheck={false}
          placeholder="Search torrents…"
          aria-label="Search torrents"
          value={props.query}
          onInput={(event) => props.onQueryChange(event.currentTarget.value)}
        />
        <select
          class="list-sort"
          aria-label="Sort torrents"
          value={props.sort}
          onChange={(event) => props.onSortChange(event.currentTarget.value as TorrentSort)}
        >
          <For each={SORTS}>{(item) => <option value={item.id}>{item.label}</option>}</For>
        </select>
      </div>

      <div class="filter-tabs" role="tablist" aria-label="Filter torrents">
        <For each={FILTERS}>
          {(item) => (
            <button
              class="filter-tab"
              classList={{ "is-active": props.filter === item.id }}
              type="button"
              role="tab"
              aria-selected={props.filter === item.id}
              onClick={() => props.onFilterChange(item.id)}
            >
              {item.label}
              <Show when={props.counts[item.id] > 0}>
                <span class="filter-count">{props.counts[item.id]}</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
