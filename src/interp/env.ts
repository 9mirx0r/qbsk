import type { QValue } from "./value.js";

export type BindingKind = "var" | "const" | "native";

export interface Binding {
  value: QValue;
  kind: BindingKind;
}

export class Env {
  private readonly bindings = new Map<string, Binding>();

  constructor(public readonly parent: Env | null = null) {}

  define(name: string, value: QValue, kind: BindingKind = "var"): void {
    // One probe, for the same reason `binding` has one: a `Binding` is always an object,
    // so `undefined` from `get` means "absent" and `has` was hashing the name twice.
    if (this.bindings.get(name) !== undefined) {
      throw new Error(`variable '${name}' is already defined in this scope`);
    }
    this.bindings.set(name, { value, kind });
  }

  /**
   * The binding for `name`, innermost scope first — or `undefined` if it is not in scope.
   *
   * Public because a caller that needs to both READ and WRITE one resolves it here and
   * passes it to `write` below: `x += 1` used to walk the chain twice, once for the old
   * value and once for the assignment, and the second walk could only ever find what the
   * first one found.
   *
   * ONE probe per scope, and a loop rather than recursion. It used to call `has` and then
   * `get`, hashing the same string twice at every level of the chain — and this is the
   * hottest function in the interpreter, since every variable read in every expression
   * arrives here. A `Binding` is always an object, so `undefined` from `get` means
   * "absent" with no ambiguity and the double probe bought nothing.
   *
   * The loop replaces one call frame per scope level. A layer body sits three or four
   * scopes below the natives, so a name resolved from the top of a loop was paying for
   * four frames it did not need.
   */
  binding(name: string): Binding | undefined {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let env: Env | null = this;
    while (env !== null) {
      const found = env.bindings.get(name);
      if (found !== undefined) {
        return found;
      }
      env = env.parent;
    }
    return undefined;
  }

  get(name: string): QValue | undefined {
    return this.binding(name)?.value;
  }

  local(name: string): QValue | undefined {
    return this.bindings.get(name)?.value;
  }

  // The binding kind for the name in this scope chain, if defined at all.
  // Used by `qbsk_inspect` (docs/studio.md §11.4) to report var/const/native.
  kindOf(name: string): BindingKind | undefined {
    return this.binding(name)?.kind;
  }

  /**
   * Every name visible from this scope, innermost first, without duplicates.
   *
   * Walks the parent chain on purpose: a reader asking "what is in scope?" means the
   * whole chain, and since §15.5 gave the entry program its own scope the natives live
   * one link up. Returning only the local frame would report a program's own variables
   * while hiding the natives it can call — a smaller version of the same silence.
   * A shadowed name appears once, at the depth that wins lookup.
   *
   * ⚠️ This is O(names in the whole chain) and allocates. It is for tooling
   * (`qbsk_list_vars`) and for building an error message — never for a hot path. A
   * caller on the error path must be sure it is already failing before it calls this:
   * suggestion building cost a real game 3 seconds a run when it was done eagerly.
   */
  names(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (env: Env): void => {
      for (const name of env.bindings.keys()) {
        if (!seen.has(name)) {
          seen.add(name);
          out.push(name);
        }
      }
      if (env.parent !== null) {
        visit(env.parent);
      }
    };
    visit(this);
    return out;
  }

  /**
   * Write through a binding already resolved by `binding()`.
   *
   * The rules live here rather than at the call site, so the three messages a
   * reassignment can produce have one source. A native is the kind that gets forgotten:
   * it is neither var nor const, and a check that only asked about const would let
   * `len = 1` replace a native for the rest of the run.
   */
  static write(binding: Binding, name: string, value: QValue): void {
    if (binding.kind !== "var") {
      if (binding.kind === "const") {
        throw new Error(`cannot reassign to constant '${name}'`);
      }
      throw new Error(`cannot reassign to '${name}'`);
    }
    binding.value = value;
  }

}
