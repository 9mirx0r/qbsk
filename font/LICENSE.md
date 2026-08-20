# Fonts bundled with QBSK

QBSK itself is proprietary (see the repository `LICENSE`). The font in this folder is
**not** ours and is **not** covered by that license. It is redistributed under its own
terms, which are recorded here because the OFL requires the license to travel with the
font.

## GNU Unifont — `unifont-17.0.05.otf`

- **Upstream:** <https://unifoundry.com/unifont/>
- **Author:** Roman Czyborra, Paul Hardy and contributors
- **License:** dual-licensed since version 13.0.04 —
  **SIL Open Font License 1.1**, or GNU GPL v2-or-later **with the GPL Font
  Embedding Exception**.

**Why this is safe for a proprietary product.** QBSK relies on the **SIL OFL 1.1** arm of
the dual license, which permits bundling and redistribution inside commercial and
closed-source software. The GPL arm additionally carries the font-embedding exception, so
neither arm causes QBSK to become GPL.

**Conditions we must keep honouring:**

1. This license notice ships with the font — that is what this file is for.
2. The font is **not sold on its own**; it travels only as part of QBSK.
3. If the font file is ever *modified*, the derivative must stay under the OFL and must
   **not** use the reserved name "Unifont". Prefer leaving it unmodified.

Full OFL 1.1 text: <https://openfontlicense.org/> · upstream license:
<https://unifoundry.com/LICENSE.txt>

## Iosevka — `Iosevka-Regular.ttf`

- **Upstream:** <https://github.com/be5invis/Iosevka> (official release PkgTTF v33.2.7)
- **License:** SIL Open Font License 1.1
- Narrow cell (0.50 em), box-drawing designed for terminals. Outline: scales freely.

## JetBrains Mono — `JetBrainsMono-Regular.ttf`

- **Upstream:** <https://github.com/JetBrains/JetBrainsMono>
- **License:** SIL Open Font License 1.1
- Cell 0.60 em. High legibility on poor displays.

## IBM Plex Mono — `IBMPlexMono-Regular.ttf`

- **Upstream:** <https://github.com/IBM/plex>
- **License:** SIL Open Font License 1.1
- Cell 0.60 em, same width as JetBrains Mono.

> The three conditions above (ship this notice, never sell a font on its own, keep it
> unmodified or rename any derivative) apply to **every** font here — they are all OFL.

## Why Unifont, technically

It covers the whole Basic Multilingual Plane with one consistent design, which matters
for an ASCII engine: box-drawing (`╔═╗ ┌─┐`), block elements (`█▓▒░`) and arrows all come
from the same hand instead of being borrowed from whatever fallback the system picks.

**It is designed on a 16-pixel grid.** It is crispest at 16 px and at multiples of 8;
in-between sizes go soft. `studio/renderer/fit.ts` snaps play mode's computed size to that
grid for exactly this reason.
