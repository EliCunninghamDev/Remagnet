import { Wordmark } from "@remagnet/ui";
import { createSignal, Show } from "solid-js";
import { MAX_USERNAME_LENGTH, MIN_PASSWORD_LENGTH } from "../constants";
import StatusLine, { type StatusMessage } from "./StatusLine";

export interface SetupCredentials {
  username: string;
  password: string;
  setupCode?: string;
}

export interface SetupViewProps {
  /** Show the deployment setup-code field for this first run. */
  requiresSetupCode: boolean;
  busy: boolean;
  status?: StatusMessage;
  onSubmit: (credentials: SetupCredentials) => void;
}

/** First-run administrator setup, shown before any session exists. */
export default function SetupView(props: SetupViewProps) {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [setupCode, setSetupCode] = createSignal("");
  const [validation, setValidation] = createSignal<StatusMessage>();

  const status = () => validation() ?? props.status;

  function clearValidation() {
    if (validation()) setValidation(undefined);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const name = username().trim();

    if (!name) {
      setValidation({ tone: "error", message: "Enter a username." });
      return;
    }
    if (password().length < MIN_PASSWORD_LENGTH) {
      setValidation({
        tone: "error",
        message: `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (password() !== confirmPassword()) {
      setValidation({ tone: "error", message: "The passwords do not match." });
      return;
    }

    setValidation(undefined);
    props.onSubmit({
      username: name,
      password: password(),
      ...(props.requiresSetupCode ? { setupCode: setupCode().trim() } : {}),
    });
  }

  return (
    <main class="proxy-main">
      <div class="auth-shell">
        <header class="options-header">
          <Wordmark as="p" size="lg" surface="Proxy" iconSrc="/icon.svg" />
          <p class="lede">Set up the administrator account for this proxy.</p>
        </header>

        <form class="panel stack" onSubmit={submit}>
          <h2>Create admin account</h2>
          <p class="hint">
            This account manages the torrent client access and paired devices. Your password is
            never stored in the clear.
          </p>

          <label class="field">
            <span>Username</span>
            <input
              name="username"
              type="text"
              autocomplete="username"
              spellcheck={false}
              required
              maxlength={MAX_USERNAME_LENGTH}
              value={username()}
              onInput={(event) => {
                setUsername(event.currentTarget.value);
                clearValidation();
              }}
            />
          </label>

          <label class="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              autocomplete="new-password"
              required
              minlength={MIN_PASSWORD_LENGTH}
              value={password()}
              onInput={(event) => {
                setPassword(event.currentTarget.value);
                clearValidation();
              }}
            />
            <small>At least {MIN_PASSWORD_LENGTH} characters.</small>
          </label>

          <label class="field">
            <span>Confirm password</span>
            <input
              name="confirmPassword"
              type="password"
              autocomplete="new-password"
              required
              minlength={MIN_PASSWORD_LENGTH}
              value={confirmPassword()}
              onInput={(event) => {
                setConfirmPassword(event.currentTarget.value);
                clearValidation();
              }}
            />
          </label>

          <Show when={props.requiresSetupCode}>
            <label class="field">
              <span>Setup code</span>
              <input
                name="setupCode"
                type="text"
                autocomplete="off"
                spellcheck={false}
                required
                value={setupCode()}
                onInput={(event) => {
                  setSetupCode(event.currentTarget.value);
                  clearValidation();
                }}
              />
              <small>
                The <code>SETUP_CODE</code> value configured on this server.
              </small>
            </label>
          </Show>

          <div class="actions">
            <button type="submit" disabled={props.busy}>
              {props.busy ? "Creating account…" : "Create admin account"}
            </button>
          </div>

          <StatusLine status={status()} />
        </form>
      </div>
    </main>
  );
}
