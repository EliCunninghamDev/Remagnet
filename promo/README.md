# Remagnet Promotional Renders

Reproducible promo adapter that mounts Remagnet's **real SolidJS extension components** (`PopupList`, `SquareBar` animations, `MagnetReview`, `Wordmark`) inside [Promo Studio](../../promo-studio).

## Bulk Render (All Store Assets)

From the repository root:

```bash
# Build the real SolidJS screen bundle and render all 8 store PNGs into promo/out/
bun run promo:render
```

Options can be passed after `--`:

```bash
# Render a specific subset or 2× HiDPI assets
bun run promo:render -- --only remagnet,remagnet-cws-shot --scale 2

# Also record the 7-second 60fps download demo clip (WebM)
bun run promo:render -- --video
```

Outputs are organized by storefront inside `promo/out/` (gitignored):

- `github/hero-duo-1200x630.png`
- `chrome-web-store/screenshot-1-popup-1280x800.png`
- `chrome-web-store/screenshot-2-context-menu-1280x800.png`
- `chrome-web-store/small-tile-440x280.png`
- `chrome-web-store/marquee-1400x560.png`
- `firefox-amo/screenshot-1-popup-1280x800.png`
- `google-play/feature-graphic-1024x500.png`
- `google-play/phone-screenshot-1080x1920.png`

## Interactive Studio

```bash
# Build the SolidJS screen bundle and launch the live studio at http://127.0.0.1:4179
bun run promo
```

Or build the SolidJS adapter alone:

```bash
bun run promo:build
```

Use **Export All** in the top bar to save every preset from the live browser session, or tweak lighting/camera presets interactively.
