import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import tokens from "./tokens.js";

type Node = Record<string, unknown>;

interface CssRule {
  selectors: string[];
  ancestors: string[];
  declarations: Map<string, string>;
}

interface Rgba {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const COLOR_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ["bg", "--bg"],
  ["panel", "--panel"],
  ["line", "--line"],
  ["border", "--border"],
  ["text", "--text"],
  ["muted", "--muted"],
  ["accent", "--accent"],
  ["accentText", "--accent-text"],
  ["done", "--done"],
  ["warn", "--warn"],
  ["track", "--track"],
  ["tile0", "--tile-0"],
  ["tile1", "--tile-1"],
  ["tile2", "--tile-2"],
  ["okBg", "--ok-bg"],
  ["okText", "--ok-text"],
  ["errorBg", "--error-bg"],
  ["errorText", "--error-text"],
  ["warnBg", "--warn-bg"],
  ["warnText", "--warn-text"],
  ["surface", "--surface"],
  ["hover", "--hover"],
  ["sweep", "--sweep"],
];

const TYPES = new Set([
  "color",
  "dimension",
  "fontFamily",
  "fontWeight",
  "duration",
  "cubicBezier",
  "number",
]);

function isRecord(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectToken(type: string, value: unknown, path: string): void {
  if (type === "color") {
    expect(isRecord(value), path).toBe(true);
    if (!isRecord(value)) return;
    expect(value.colorSpace, path).toBe("srgb");
    expect(Array.isArray(value.components), path).toBe(true);
    expect(value.components, path).toHaveLength(3);
    for (const component of value.components as unknown[]) {
      expect(typeof component, path).toBe("number");
      expect(component as number, path).toBeGreaterThanOrEqual(0);
      expect(component as number, path).toBeLessThanOrEqual(1);
    }
    expect(value.hex, path).toMatch(/^#[0-9a-f]{6}$/i);
    if (value.alpha !== undefined) {
      expect(typeof value.alpha, path).toBe("number");
      expect(value.alpha as number, path).toBeGreaterThanOrEqual(0);
      expect(value.alpha as number, path).toBeLessThanOrEqual(1);
    }
    return;
  }

  if (type === "dimension" || type === "duration") {
    expect(isRecord(value), path).toBe(true);
    if (!isRecord(value)) return;
    expect(typeof value.value, path).toBe("number");
    expect(value.unit, path).toBe(type === "dimension" ? "px" : "ms");
    return;
  }

  if (type === "fontFamily") {
    expect(Array.isArray(value), path).toBe(true);
    expect((value as unknown[]).length, path).toBeGreaterThan(0);
    for (const family of value as unknown[]) {
      expect(typeof family, path).toBe("string");
    }
    return;
  }

  if (type === "fontWeight") {
    expect(typeof value, path).toBe("number");
    expect(value as number, path).toBeGreaterThanOrEqual(1);
    expect(value as number, path).toBeLessThanOrEqual(1000);
    return;
  }

  if (type === "cubicBezier") {
    expect(Array.isArray(value), path).toBe(true);
    expect(value, path).toHaveLength(4);
    for (const coordinate of value as unknown[]) {
      expect(typeof coordinate, path).toBe("number");
    }
    return;
  }

  if (type === "number") {
    expect(typeof value, path).toBe("number");
  }
}

function validate(node: unknown, inheritedType: string | undefined, path: string): void {
  expect(isRecord(node), path).toBe(true);
  if (!isRecord(node)) return;

  const declaredType = typeof node.$type === "string" ? node.$type : inheritedType;
  if ("$value" in node) {
    expect(declaredType, `${path} must declare or inherit a $type`).toBeString();
    expect(TYPES.has(declaredType as string), `${path} has unknown type ${declaredType}`).toBe(
      true,
    );
    expectToken(declaredType as string, node.$value, path);
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    validate(child, declaredType, `${path}.${key}`);
  }
}

function colorKeys(mode: Node): string[] {
  return Object.keys(mode)
    .filter((key) => !key.startsWith("$"))
    .sort();
}

/**
 * Minimal CSS block reader. It records every rule with its declarations and
 * enclosing at-rules, which is enough to find a specific `:root` or `.popup`
 * block without pulling in a CSS parser.
 */
function parseCss(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let index = 0;

  function readDeclarations(ancestors: string[]): Map<string, string> {
    const declarations = new Map<string, string>();
    let buffer = "";

    const commit = (): void => {
      const declaration = buffer.trim();
      buffer = "";
      const separator = declaration.indexOf(":");
      if (separator === -1) return;
      const name = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (name) declarations.set(name, value);
    };

    while (index < css.length) {
      const character = css[index];
      if (character === "}") {
        index += 1;
        commit();
        return declarations;
      }
      if (character === ";") {
        index += 1;
        commit();
        continue;
      }
      if (character === "{") {
        const prelude = buffer.trim();
        buffer = "";
        index += 1;
        const nested = readDeclarations([...ancestors, prelude]);
        rules.push({
          selectors: prelude
            .split(",")
            .map((selector) => selector.trim())
            .filter(Boolean),
          ancestors,
          declarations: nested,
        });
        continue;
      }
      buffer += character;
      index += 1;
    }

    commit();
    return declarations;
  }

  readDeclarations([]);
  return rules;
}

function findRule(rules: CssRule[], predicate: (rule: CssRule) => boolean, label: string): CssRule {
  const rule = rules.find(predicate);
  expect(rule, `should find ${label}`).toBeDefined();
  if (!rule) throw new Error(`Could not find ${label}`);
  return rule;
}

function parseCssColor(value: string): Rgba | undefined {
  const text = value.trim();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1];
    if (!digits) return undefined;
    const full =
      digits.length === 3 ? [...digits].map((digit) => `${digit}${digit}`).join("") : digits;
    return {
      red: Number.parseInt(full.slice(0, 2), 16),
      green: Number.parseInt(full.slice(2, 4), 16),
      blue: Number.parseInt(full.slice(4, 6), 16),
      alpha: 1,
    };
  }

  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (!functional) return undefined;
  const channel = functional[1];
  if (!channel) return undefined;
  const parts = channel
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  const [red, green, blue, alpha = 1] = parts;
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  return { red, green, blue, alpha };
}

function colorToken(theme: string, group: Node, key: string): Rgba {
  const label = `tokens.color.${theme}.${key}`;
  const token = group[key];
  expect(isRecord(token), `${label} should be a color token`).toBe(true);
  if (!isRecord(token) || !isRecord(token.$value)) {
    throw new Error(`${label} is not a color token`);
  }

  const color = parseCssColor(String(token.$value.hex));
  expect(color, `${label}.hex should be a hex color`).toBeDefined();
  if (!color) throw new Error(`${label}.hex is not a hex color`);

  const { alpha } = token.$value;
  if (alpha !== undefined) {
    expect(typeof alpha, `${label}.alpha`).toBe("number");
    if (typeof alpha !== "number") throw new Error(`${label}.alpha is not a number`);
    color.alpha = alpha;
  }
  return color;
}

function rounded(color: Rgba): Rgba {
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return {
    red: round(color.red),
    green: round(color.green),
    blue: round(color.blue),
    alpha: round(color.alpha),
  };
}

describe("design tokens", () => {
  test("uses the DTCG 2025.10 schema", () => {
    expect(tokens.$schema).toBe("https://www.designtokens.org/schemas/2025.10/format.json");
  });

  test("every token is valid for its declared type", () => {
    validate(tokens, undefined, "tokens");
  });

  test("light, dark and popup themes expose the same color tokens", () => {
    const expected = colorKeys(tokens.color.light);
    expect(colorKeys(tokens.color.dark)).toEqual(expected);
    expect(colorKeys(tokens.color.popup)).toEqual(expected);
  });

  test("is plain JSON-serializable data", () => {
    expect(JSON.parse(JSON.stringify(tokens))).toEqual(tokens);
  });

  test("CSS custom properties mirror the color tokens", () => {
    const baseCss = parseCss(
      readFileSync(`${import.meta.dir}/packages/ui/src/styles/base.css`, "utf8"),
    );
    const appCss = parseCss(readFileSync(`${import.meta.dir}/extension/assets/app.css`, "utf8"));

    const light = findRule(
      baseCss,
      (rule) => rule.ancestors.length === 0 && rule.selectors.includes(":root"),
      "the light :root block in packages/ui/src/styles/base.css",
    );
    const dark = findRule(
      baseCss,
      (rule) =>
        rule.selectors.includes(":root") &&
        rule.ancestors.some((ancestor) => /prefers-color-scheme:\s*dark/.test(ancestor)),
      "the dark :root block in packages/ui/src/styles/base.css",
    );
    const popup = findRule(
      appCss,
      (rule) =>
        rule.declarations.has("--bg") &&
        rule.selectors.some((selector) =>
          /\.(?:popup(?:-body)?|theme-popup)(?![\w-])/.test(selector),
        ),
      "the popup theme block in extension/assets/app.css",
    );

    const themes: Array<{ name: string; file: string; rule: CssRule; group: Node }> = [
      {
        name: "light",
        file: "packages/ui/src/styles/base.css",
        rule: light,
        group: tokens.color.light as unknown as Node,
      },
      {
        name: "dark",
        file: "packages/ui/src/styles/base.css",
        rule: dark,
        group: tokens.color.dark as unknown as Node,
      },
      {
        name: "popup",
        file: "extension/assets/app.css",
        rule: popup,
        group: tokens.color.popup as unknown as Node,
      },
    ];

    for (const theme of themes) {
      for (const [key, property] of COLOR_PROPERTIES) {
        const expected = rounded(colorToken(theme.name, theme.group, key));
        const declared = theme.rule.declarations.get(property);
        expect(declared, `${property} should be declared in ${theme.file}`).toBeString();

        const actual = parseCssColor(declared ?? "");
        expect(actual, `${property} in ${theme.file} should be a hex or rgba color`).toBeDefined();
        if (!actual) continue;

        expect(
          rounded(actual),
          `${property} in ${theme.file} should match tokens.color.${theme.name}.${key}`,
        ).toEqual(expected);
      }
    }
  });
});
