import type { JSX } from "solid-js";

export interface SectionProps {
  id: string;
  title: string;
  description?: string;
  children: JSX.Element;
}

export function Section(props: SectionProps) {
  return (
    <section class="gallery-section" id={props.id}>
      <header class="section-heading">
        <h2>{props.title}</h2>
        {props.description ? <p class="muted">{props.description}</p> : null}
      </header>
      {props.children}
    </section>
  );
}

export interface SpecimenProps {
  label: string;
  note?: string;
  class?: string;
  children: JSX.Element;
}

/** A labelled frame around one component state. */
export function Specimen(props: SpecimenProps) {
  return (
    <figure class={`specimen ${props.class ?? ""}`}>
      <figcaption>
        <span class="specimen-label">{props.label}</span>
        {props.note ? <span class="specimen-note">{props.note}</span> : null}
      </figcaption>
      <div class="specimen-body">{props.children}</div>
    </figure>
  );
}
