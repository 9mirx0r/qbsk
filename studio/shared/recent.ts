// The files you actually work on (docs/studio.md §20).
//
// Opening a scene meant a modal file dialog every time, starting at `examples/` — so
// returning to the file you were editing five minutes ago cost a dialog, a folder walk
// and a double click, every time. The folder button in the toolbar was wired to nothing
// at all.
//
// Data in, data out, no Electron and no filesystem: same reason as `marks.ts`.

/** How many files the list keeps. */
export const RECENT_LIMIT = 10;

/**
 * The list with `path` at the front, deduplicated, capped.
 *
 * Returns a NEW array. Mutating the caller's list would make the persisted copy and the
 * one in memory the same object, and then a failed write would leave them disagreeing
 * with no way to tell which was right.
 */
export function addRecent(
  list: readonly string[],
  path: string,
  limit: number = RECENT_LIMIT,
): string[] {
  const trimmed = path.trim();
  if (trimmed === "") {
    // A scene with no path — the default scene before it is ever saved — is not a file
    // anyone can return to, and an empty row in the menu opens nothing.
    return [...list];
  }
  const rest = list.filter((p) => !samePath(p, trimmed));
  return [trimmed, ...rest].slice(0, limit);
}

/**
 * Are these two the same file?
 *
 * Case-insensitive and separator-insensitive, because this list is written on Windows,
 * where `C:\\x\\a.qbsk` and `c:/x/a.qbsk` are one file. Compared case-sensitively, the
 * same scene appears three times in the menu depending on how it was opened.
 *
 * Deliberately NOT a real path resolution: that needs the filesystem, and this module is
 * the half that can be tested without one. The main process resolves before it calls in.
 */
export function samePath(a: string, b: string): boolean {
  return normalise(a) === normalise(b);
}

function normalise(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** The label for a menu row: the file name, with enough parent to tell two apart. */
export function recentLabel(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) => p !== "");
  const file = parts[parts.length - 1] ?? path;
  const parent = parts[parts.length - 2];
  // `duel.qbsk` and `duel.qbsk` in two folders are the same word in the menu, and the
  // only thing distinguishing them is the folder above.
  return parent === undefined ? file : `${parent}/${file}`;
}
