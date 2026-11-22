export interface QBittorrentErrorOptions {
  status?: number;
  statusText?: string;
  body?: string;
  url?: string;
  cause?: unknown;
}

/** An HTTP or protocol-level error returned by qBittorrent. */
export class QBittorrentError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;
  readonly url: string;

  constructor(message: string, options: QBittorrentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QBittorrentError";
    this.status = options.status ?? 0;
    this.statusText = options.statusText ?? "";
    this.body = options.body ?? "";
    this.url = options.url ?? "";
  }
}

/** Authentication failed, or credentials required for the operation are missing. */
export class QBittorrentAuthError extends QBittorrentError {
  constructor(message: string, options: QBittorrentErrorOptions = {}) {
    super(message, options);
    this.name = "QBittorrentAuthError";
  }
}
