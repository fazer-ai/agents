import { afterAll, beforeAll, spyOn } from "bun:test";

// Replaces exported functions of one of OUR client modules (a context hook, a realtime hook) for the
// calling FILE only: `spyOn` on the module object, installed before the file's first test and
// restored after its last. Call it at the top level of a test file.
//
// Never `mock.module` for this. Bun's module mock is process-global and its undo is a second global
// rewrite, so a stub written for one file is what the NEXT file in the same process imports: a page
// rendered under the real `AuthProvider` elsewhere would read this file's hard-coded role. `spyOn`
// is per object and `mockRestore` puts the real export back. See `tooling/process/agents-ship/
// testes.md`, "`mock.module` e o export singleton decidem pelo PROCESSO".
//
// A stub only replaces what is NAMED here. A hook that calls another export internally (the real
// `useThemedAsset` calls `useTheme`) does not see the spy on the second one, so stub both.
export function stubExports<M extends object>(
  mod: M,
  impls: {
    [K in keyof M]?: M[K] extends (...args: never[]) => unknown
      ? (...args: never[]) => unknown
      : never;
  },
): void {
  const spies: { mockRestore(): void }[] = [];
  beforeAll(() => {
    for (const [name, impl] of Object.entries(impls)) {
      spies.push(
        spyOn(mod as Record<string, () => unknown>, name).mockImplementation(
          impl as () => unknown,
        ),
      );
    }
  });
  afterAll(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });
}
