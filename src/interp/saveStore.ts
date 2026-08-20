// The two SaveStore implementations (docs/language.md §13.5).
//
// The natives never touch the file system: they call the store the HOST provides,
// exactly as `print` goes through `HostIO`. Tests hand in the memory store so
// persistence tests need no disk; the CLI hands in the directory store so `qbsk run`
// gets real saves beside the script.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SaveStore } from "./natives.js";

/** In-memory store: what tests use, and what a host without a disk could use. */
export function memorySaveStore(): SaveStore {
  const slots = new Map<string, string>();
  return {
    read: (slot) => slots.get(slot) ?? null,
    write: (slot, text) => {
      slots.set(slot, text);
    },
    list: () => [...slots.keys()].sort(),
  };
}

/**
 * Directory store: slots live as `<dir>/saves/<slot>.qbdata`.
 *
 * The `saves/` subdirectory is created on the first WRITE, not on construction — a
 * program that never saves must not leave an empty directory behind. Listing filters
 * to `.qbdata` and strips the extension, because a slot is a NAME, not a filename
 * (§13.4); stray files beside the saves are not saves.
 */
export function dirSaveStore(dir: string): SaveStore {
  const savesDir = join(dir, "saves");
  return {
    read: (slot) => {
      const file = join(savesDir, `${slot}.qbdata`);
      if (!existsSync(file)) {
        return null;
      }
      return readFileSync(file, "utf8");
    },
    write: (slot, text) => {
      mkdirSync(savesDir, { recursive: true });
      writeFileSync(join(savesDir, `${slot}.qbdata`), text);
    },
    list: () => {
      if (!existsSync(savesDir)) {
        return [];
      }
      return readdirSync(savesDir)
        .filter((name) => name.endsWith(".qbdata"))
        .map((name) => name.slice(0, -".qbdata".length))
        .sort();
    },
  };
}
