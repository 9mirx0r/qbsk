# examples/res/assets/

Organized home for pixel-art content going forward (an earlier release, 2026-08-09). Two
directories, kept strictly separate:

## `generated/`

Sprites `examples/lib/pixelart.qbsk` produced itself — 100% original, from-scratch QBSK
content. Subfolders by category: `creatures/`, `weapons/`, `terrain/`, `structures/`,
`resources/`. This is the only directory whose contents may ship as real QBSK example/
game content.

## `reference/`

External material used for **comparison and technique study only** — never copied into
`generated/`, never shipped as QBSK content. Currently: `demons/`, sliced from the
owner's own AI-generated reference sheets via `bench/spritesheet-slice.mjs`
(`examples/lib/spritesheet.qbsk` does the actual cropping — see that file's header for
why PNG decoding itself stays a host-side script, `src/tools/pngDecode.ts`). The same
"inspired by mechanism, never copied" rule this project has used for every other
external reference (Dwarf Fortress, Cataclysm DDA, the DF/CDDA sprite comparison in
06-active-language-phases.md's an earlier release entry) applies here: looking at these to judge
what QBSK's own generator should do differently is the point; porting them in is not.

Pre-existing assets outside this folder (`examples/res/pixelart_*.qbdata`,
`examples/res/sprites/*.svg` — an earlier release creature/sword/orc/demon demo) predate this
folder and were not migrated; new work lands here.
