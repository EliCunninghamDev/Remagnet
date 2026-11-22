import tokens, {
  type ColorValue,
  type DesignToken,
  type DimensionValue,
  type TokenGroup,
} from "../../tokens.js";

export { tokens };

export function isToken<T>(node: unknown): node is DesignToken<T> {
  return typeof node === "object" && node !== null && "$value" in node;
}

/** Direct tokens in a group, excluding metadata keys and nested groups. */
export function tokenEntries<T>(group: TokenGroup<T>): Array<[string, DesignToken<T>]> {
  return Object.entries(group).flatMap(([name, node]) => {
    return name.startsWith("$") || !isToken<T>(node)
      ? []
      : [[name, node] as [string, DesignToken<T>]];
  });
}

/** All tokens in a group tree, with dotted names such as `popup.width`. */
export function flattenTokens<T>(
  group: TokenGroup<T>,
  prefix = "",
): Array<[string, DesignToken<T>]> {
  return Object.entries(group).flatMap(([name, node]) => {
    if (name.startsWith("$")) return [];
    const path = prefix ? `${prefix}.${name}` : name;
    if (isToken<T>(node)) return [[path, node] as [string, DesignToken<T>]];
    if (typeof node === "object" && node !== null) {
      return flattenTokens(node as TokenGroup<T>, path);
    }
    return [];
  });
}

export function colorCss(value: ColorValue): string {
  const [r, g, b] = value.components.map((component) => Math.round(component * 255));
  return value.alpha === undefined ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${value.alpha})`;
}

export function dimensionCss(value: DimensionValue): string {
  return `${value.value}${value.unit}`;
}
