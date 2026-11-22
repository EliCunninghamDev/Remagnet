/**
 * Types for the DTCG token module in `tokens.js`.
 *
 * Keep this file next to the JavaScript module: TypeScript uses it to check
 * imports from scripts and the component gallery without treating the token
 * data as untyped.
 */

export interface DesignToken<T = unknown> {
  $value: T;
  $type?: string;
  $description?: string;
}

export interface TokenGroup<T = unknown> {
  $type?: string;
  $description?: string;
  [name: string]: DesignToken<T> | TokenGroup<T> | string | undefined;
}

export interface ColorValue {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha?: number;
  hex: string;
}

export interface DimensionValue {
  value: number;
  unit: "px" | "rem";
}

export interface DurationValue {
  value: number;
  unit: "ms" | "s";
}

export interface Tokens {
  $schema: string;
  color: {
    $type: "color";
    $description?: string;
    light: TokenGroup<ColorValue>;
    dark: TokenGroup<ColorValue>;
    popup: TokenGroup<ColorValue>;
  };
  typography: {
    $description?: string;
    family: TokenGroup<string[]>;
    weight: TokenGroup<number>;
    size: TokenGroup<DimensionValue>;
    lineHeight: TokenGroup<number>;
    letterSpacing: TokenGroup<number>;
  };
  space: TokenGroup<DimensionValue>;
  radius: TokenGroup<DimensionValue>;
  border: TokenGroup<DimensionValue>;
  stroke: TokenGroup<DimensionValue>;
  motion: {
    $description?: string;
    duration: TokenGroup<DurationValue>;
    easing: TokenGroup<number[]>;
  };
  layout: TokenGroup<DimensionValue>;
}

export const tokens: Tokens;
export default tokens;
