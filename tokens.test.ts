import { describe, expect, test } from "bun:test";
import tokens from "./tokens.js";

type Node = Record<string, unknown>;

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
});
