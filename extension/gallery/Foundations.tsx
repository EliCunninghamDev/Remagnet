import { For } from "solid-js";
import Wordmark from "../components/Wordmark";
import { Section, Specimen } from "./Section";
import { colorCss, dimensionCss, flattenTokens, tokenEntries, tokens } from "./token-utils";

const COLOR_MODES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "popup", label: "Popover" },
] as const;

/** The DTCG token source rendered as swatches and samples. */
export default function Foundations() {
  return (
    <>
      <Section
        id="foundations"
        title="Foundations"
        description="Rendered from tokens.js (DTCG 2025.10). If a swatch or type sample looks wrong here, the token or its CSS mirror is wrong."
      >
        <div class="token-modes">
          <For each={COLOR_MODES}>
            {(mode) => (
              <div class="token-mode">
                <h3>{mode.label}</h3>
                <div class="swatch-grid">
                  <For each={tokenEntries(tokens.color[mode.id])}>
                    {([name, token]) => (
                      <div class="token-swatch">
                        <span class="token-chip" style={{ background: colorCss(token.$value) }} />
                        <span class="token-name">{name}</span>
                        <code class="token-value">
                          {token.$value.hex}
                          {token.$value.alpha === undefined ? "" : ` · ${token.$value.alpha}`}
                        </code>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </Section>

      <Section
        id="type"
        title="Typography"
        description="Font stacks, weights and the pixel type scale used by the popover and pages."
      >
        <div class="foundation-grid">
          <Specimen label="Families">
            <dl class="token-list">
              <For each={tokenEntries(tokens.typography.family)}>
                {([name, token]) => (
                  <>
                    <dt>{name}</dt>
                    <dd style={{ "font-family": token.$value.join(", ") }}>Remagnet 0123</dd>
                  </>
                )}
              </For>
            </dl>
          </Specimen>

          <Specimen label="Weights">
            <dl class="token-list">
              <For each={tokenEntries(tokens.typography.weight)}>
                {([name, token]) => (
                  <>
                    <dt>{name}</dt>
                    <dd style={{ "font-weight": String(token.$value) }}>Remagnet</dd>
                  </>
                )}
              </For>
            </dl>
          </Specimen>
        </div>

        <Specimen
          label="Wordmark"
          note="One mark on every surface. Only the optional surface label changes."
        >
          <div class="wordmark-samples">
            <Wordmark as="p" surface="Components" />
            <Wordmark as="p" size="lg" surface="Settings" />
            <div class="theme-popup">
              <Wordmark as="p" surface="Bridge" />
            </div>
          </div>
        </Specimen>

        <Specimen label="Size scale">
          <div class="type-scale">
            <For each={tokenEntries(tokens.typography.size)}>
              {([name, token]) => (
                <div class="type-row">
                  <code>
                    {name} · {dimensionCss(token.$value)}
                  </code>
                  <span style={{ "font-size": dimensionCss(token.$value) }}>Remagnet</span>
                </div>
              )}
            </For>
          </div>
        </Specimen>
      </Section>

      <Section
        id="space"
        title="Space & motion"
        description="Spacing, the square-corner radius policy, icon strokes and the durations used by the progress bars."
      >
        <Specimen label="Spacing scale">
          <div class="space-scale">
            <For each={tokenEntries(tokens.space)}>
              {([name, token]) => (
                <div class="space-row">
                  <code>{name}</code>
                  <span
                    class="space-bar"
                    style={{ width: dimensionCss(token.$value) }}
                    aria-hidden="true"
                  />
                  <span class="muted">{dimensionCss(token.$value)}</span>
                </div>
              )}
            </For>
          </div>
        </Specimen>

        <div class="foundation-grid">
          <Specimen label="Durations">
            <dl class="token-list">
              <For each={tokenEntries(tokens.motion.duration)}>
                {([name, token]) => (
                  <>
                    <dt>{name}</dt>
                    <dd class="mono">
                      {token.$value.value}
                      {token.$value.unit}
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </Specimen>

          <Specimen label="Layout & strokes">
            <dl class="token-list">
              <For each={flattenTokens(tokens.layout)}>
                {([name, token]) => (
                  <>
                    <dt>{name}</dt>
                    <dd class="mono">{dimensionCss(token.$value)}</dd>
                  </>
                )}
              </For>
              <For each={flattenTokens(tokens.stroke)}>
                {([name, token]) => (
                  <>
                    <dt>stroke.{name}</dt>
                    <dd class="mono">{dimensionCss(token.$value)}</dd>
                  </>
                )}
              </For>
            </dl>
          </Specimen>
        </div>
      </Section>
    </>
  );
}
