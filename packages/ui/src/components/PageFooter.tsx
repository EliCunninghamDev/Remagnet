export interface PageFooterProps {
  /** Product version appended to the label when present. */
  version?: string;
  /** Product name shown before the version. */
  label?: string;
  /** Optional extra class; defaults to the shared `page-footer` styling. */
  class?: string;
  /** Open the issue-report dialog; the link is omitted when absent. */
  onReport?: () => void;
}

/** Product links and the shared issue-report trigger for every page state. */
export default function PageFooter(props: PageFooterProps) {
  const label = () => props.label ?? "Remagnet Proxy";
  const text = () => (props.version ? `${label()} ${props.version}` : label());

  return (
    <footer class={props.class ?? "page-footer"}>
      <span>{text()}</span>
      <span class="sep" aria-hidden="true">
        ·
      </span>
      <a href="https://remagnet.app" target="_blank" rel="noreferrer">
        Website
      </a>
      <span class="sep" aria-hidden="true">
        ·
      </span>
      <a href="https://github.com/EliCunninghamDev/Remagnet" target="_blank" rel="noreferrer">
        GitHub
      </a>
      {props.onReport && (
        <>
          <span class="sep" aria-hidden="true">
            ·
          </span>
          <button class="linkish" type="button" onClick={() => props.onReport?.()}>
            Report an issue
          </button>
        </>
      )}
      <span class="sep" aria-hidden="true">
        ·
      </span>
      <a href="https://remagnet.app/privacy.html" target="_blank" rel="noreferrer">
        Privacy
      </a>
      <span class="sep" aria-hidden="true">
        ·
      </span>
      <a href="https://ko-fi.com/elijahcunninghamdev" target="_blank" rel="noreferrer">
        Support on Ko-fi
      </a>
    </footer>
  );
}
