// The sandbox's fixed limits, in a module with no imports so the console can read them (the code
// editor's length cap, the help text) without dragging the interpreter or the worker into the
// browser bundle. The reasoning behind each value is in code-sandbox.ts.

export const SANDBOX_TIMEOUT_MS = 1000;
export const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
export const SANDBOX_STACK_BYTES = 256 * 1024;
// The body of a code tool. An operator's function is a few hundred lines at most, and the bound
// keeps a pasted library from being handed to a thread as a megabyte of source.
export const SANDBOX_CODE_MAX_CHARS = 20_000;
// The model's arguments, as JSON text. The tool's schema types them but does not bound a string,
// and what crosses into the thread is bounded here so a runaway argument cannot become a
// megabyte of `JSON.parse` on the operator's deadline.
export const CODE_TOOL_INPUT_MAX_CHARS = 32_000;
