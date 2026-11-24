import { Wordmark } from "@remagnet/ui";
import { createEffect, createSignal, Show } from "solid-js";
import StatusLine, { type StatusMessage } from "./StatusLine";

export interface SignInValues {
  username: string;
  password: string;
  totpCode?: string;
}

export interface SignInViewProps {
  busy: boolean;
  /** Ask for the second factor after `401` with `code: "totp_required"`. */
  totpRequired: boolean;
  status?: StatusMessage;
  onSubmit: (values: SignInValues) => void;
}

/** Returning administrator sign-in. */
export default function SignInView(props: SignInViewProps) {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [totpCode, setTotpCode] = createSignal("");
  const [validation, setValidation] = createSignal<StatusMessage>();
  let totpInput: HTMLInputElement | undefined;

  const status = () => validation() ?? props.status;

  createEffect(() => {
    if (props.totpRequired) totpInput?.focus();
  });

  function clearValidation() {
    if (validation()) setValidation(undefined);
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const name = username().trim();

    if (!name) {
      setValidation({ tone: "error", message: "Enter your username." });
      return;
    }
    if (!password()) {
      setValidation({ tone: "error", message: "Enter your password." });
      return;
    }
    if (props.totpRequired && !totpCode().trim()) {
      setValidation({
        tone: "error",
        message: "Enter the 6-digit code from your authenticator, or a saved recovery code.",
      });
      return;
    }

    setValidation(undefined);
    props.onSubmit({
      username: name,
      password: password(),
      ...(props.totpRequired ? { totpCode: totpCode().trim() } : {}),
    });
  }

  return (
    <main class="proxy-main">
      <div class="auth-shell">
        <header class="options-header">
          <Wordmark as="p" size="lg" surface="Proxy" iconSrc="/icon.svg" />
          <p class="lede">Sign in to manage the proxy, paired devices, and account security.</p>
        </header>

        <form class="panel stack" onSubmit={submit}>
          <h2>Sign in</h2>

          <label class="field">
            <span>Username</span>
            <input
              name="username"
              type="text"
              autocomplete="username"
              spellcheck={false}
              required
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
              autocomplete="current-password"
              required
              value={password()}
              onInput={(event) => {
                setPassword(event.currentTarget.value);
                clearValidation();
              }}
            />
          </label>

          <Show when={props.totpRequired}>
            <label class="field">
              <span>Two-factor code</span>
              <input
                ref={totpInput}
                name="totp"
                type="text"
                autocomplete="one-time-code"
                spellcheck={false}
                autocapitalize="off"
                placeholder="6-digit code or recovery code"
                value={totpCode()}
                onInput={(event) => {
                  setTotpCode(event.currentTarget.value);
                  clearValidation();
                }}
              />
              <small>Use the code from your authenticator app, or a saved recovery code.</small>
            </label>
          </Show>

          <div class="actions">
            <button type="submit" disabled={props.busy}>
              {props.busy ? "Signing in…" : "Sign in"}
            </button>
          </div>

          <StatusLine status={status()} />
        </form>
      </div>
    </main>
  );
}
