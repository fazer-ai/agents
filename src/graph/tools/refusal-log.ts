import type {
  StructuredToolInterface,
  ToolRunnableConfig,
} from "@langchain/core/tools";
import { ToolInputParsingException } from "@langchain/core/tools";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { type DeclaredKeys, describeShape } from "@/modules/flowlog/shape";

// THE CALL THE SCHEMA REFUSED, WHICH LEFT NO TRACE AT ALL (issue #667).
//
// LangChain validates a tool's arguments inside `StructuredTool.call`, BEFORE the callback manager
// exists:
//
//   parsed = await interopParseAsync(this.schema, inputForValidation);  // throws here
//   ...
//   const callbackManager_ = CallbackManager.configure(...);            // only here
//
// So neither `handleToolStart` nor `handleToolError` fires, and `ToolFlowLogger` is blind to the
// refusal by construction: no handler it could implement would see it. The model does see it:
// LangGraph's `ToolNode` catches the exception and answers the call with `Error: Received tool input
// did not match expected schema`, and it tries again, or gives up. Neither shows up anywhere the
// operator looks: a turn where the agent tried three times to hand a conversation over and never
// managed to was byte for byte identical, in `execution_logs`, to a turn where it tried nothing.
//
// The wrap happens at the single seam where every source's tools meet (`buildToolset`), the same
// seam `applyToolPreconditions` uses, so the reactive turn, the nudge, the observation and the
// playground are covered by one wrapper instead of four call sites remembering to.
//
// WHAT THE LINE IS NOT: it is not a failure. The tool did not break and no integration is down; the
// model sent arguments its own schema does not accept, which it then usually fixes on the next step.
// So the line is `level: 'info'`, the same level, and for the same reason, as the precondition
// refusal next door (`precondition.ts`): visible in the Logs page, and NOT paging an operator's
// alert channel, whose `minLevel: warn` is what stops a model looping on one bad argument from
// becoming a burst of alerts. `status: 'skipped'` because the stage's work never happened.

// One declared parameter the refusal is about, in the schema's own vocabulary.
type RefusedParam =
  | { param: string; why: "missing" }
  | { param: string; why: "type"; expected: string; received: string };

interface Declared {
  keys: DeclaredKeys;
  required: readonly string[];
  types: Record<string, readonly string[]>;
}

// Read ONCE per tool, from the same schema the model is given. `toJsonSchema` covers both tool
// families: a zod schema (native, HTTP, toolpack) and a raw JSON Schema (MCP, whose tools come from
// the server's own declaration).
function declarationOf(tool: StructuredToolInterface): Declared {
  try {
    const schema = toJsonSchema(tool.schema) as {
      properties?: Record<string, { type?: unknown }>;
      required?: unknown;
    };
    const props = schema?.properties;
    if (!props || typeof props !== "object") {
      return { keys: null, required: [], types: {} };
    }
    const types: Record<string, readonly string[]> = {};
    for (const [name, spec] of Object.entries(props)) {
      const t = spec?.type;
      if (typeof t === "string") types[name] = [t];
      else if (Array.isArray(t))
        types[name] = t.filter((x): x is string => typeof x === "string");
    }
    return {
      keys: new Set(Object.keys(props)),
      required: Array.isArray(schema.required)
        ? schema.required.filter((x): x is string => typeof x === "string")
        : [],
      types,
    };
  } catch {
    // NOTE: An unreadable schema contributes no names, which is the safe direction: the line still
    // exists and says only that the arguments were refused.
    return { keys: null, required: [], types: {} };
  }
}

// The JSON Schema type name for a value that ARRIVED, so `expected` and `received` are comparable
// words. `number` covers both of JSON Schema's numeric names, which is also how the sentence the
// model itself was shown reads.
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "bigint") return "number";
  return t;
}

// Every value satisfies a parameter whose type the declaration does not pin (a union, an enum, an
// `anyOf`), and an integral number satisfies an `integer` parameter, the one case where the two
// numeric names are not interchangeable.
function typeAgrees(
  expected: readonly string[],
  value: unknown,
  received: string,
): boolean {
  if (expected.length === 0) return true;
  if (expected.includes(received)) return true;
  return (
    received === "number" &&
    expected.includes("integer") &&
    Number.isInteger(value)
  );
}

// WHY THE REASON IS REBUILT INSTEAD OF FORWARDED. The vendor's own text cannot be published here:
// `ToolInputParsingException.output` is `JSON.stringify(arg)`, the arguments verbatim, and a zod
// `unrecognized_keys` message quotes the key the MODEL invented. Both are precisely what the
// argument side of a tool line refuses to write (`modules/flowlog/shape.ts`), and `detail` is
// exportable through `GET /v1/logs/export`.
//
// So this names parameters from the DECLARATION and nothing else, and it deliberately does not
// re-decide the refusal: the vendor already refused, and this runs only on that path. It reports the
// two shapes a refusal takes in practice (a required parameter that did not come, a declared one
// whose type disagrees) and, when it can name none of them (a constraint inside a parameter, a
// nested object, a union), says exactly that rather than guessing. A generic reason still leaves the
// line, which is the whole point of the issue: the COUNT of refused calls is what was missing.
function refusedParams(
  args: Record<string, unknown>,
  d: Declared,
): {
  params: string[];
  issues: string[];
} {
  const found: RefusedParam[] = [];
  for (const name of d.required) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      found.push({ param: name, why: "missing" });
    }
  }
  for (const [name, expected] of Object.entries(d.types)) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) continue;
    const received = jsonTypeOf(args[name]);
    if (!typeAgrees(expected, args[name], received)) {
      found.push({
        param: name,
        why: "type",
        expected: expected.join("|"),
        received,
      });
    }
  }
  if (found.length === 0) {
    return { params: [], issues: ["arguments refused by the tool schema"] };
  }
  return {
    params: found.map((f) => f.param),
    issues: found.map((f) =>
      f.why === "missing"
        ? `${f.param}: missing`
        : `${f.param}: expected ${f.expected}, received ${f.received}`,
    ),
  };
}

function isSchemaRefusal(err: unknown): boolean {
  if (err instanceof ToolInputParsingException) return true;
  // Belt and braces for a duplicated `@langchain/core` in the tree, where `instanceof` answers false
  // across copies. The class is declared as an unnamed class expression, so its inferred name is the
  // only other stable marker.
  return (
    err instanceof Error &&
    err.constructor?.name === "ToolInputParsingException"
  );
}

// ToolNode hands the whole tool call in as the input (`{name, args, id, type: 'tool_call'}`); a
// direct invocation passes the arguments themselves, which is what a unit test does.
function argsOf(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") {
    const call = input as { type?: string; args?: unknown };
    if (call.type === "tool_call" || "args" in call) {
      const a = call.args;
      return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    }
    return input as Record<string, unknown>;
  }
  return {};
}

// Wraps each assembled tool so a call the schema refused leaves one `tool`-stage line, then rethrows
// the refusal untouched: what the model reads, and whether the turn ends, is exactly what it was.
export function logSchemaRefusals(
  tools: StructuredToolInterface[],
  flow: FlowContext | undefined,
  // The agent's `observability.logToolValues`, honoured for the same reason the tool line honours
  // it: an operator who turned raw values on for tool calls asked for them on this line too.
  logValues: boolean,
): StructuredToolInterface[] {
  if (!flow) return tools;
  const describe = logValues
    ? (value: unknown) => value
    : (value: unknown, declared: DeclaredKeys) =>
        describeShape(value, declared);
  return tools.map((inner) => {
    const d = declarationOf(inner);
    // NOTE: DELEGATION through the prototype, not a second `tool()`. See `guardedTool`'s note: the
    // prototype carries name, description and schema unchanged, only `invoke` is shadowed, and a
    // call that parses reaches exactly the run it would have had without any of this (including its
    // ToolFlowLogger line, which is what keeps a refusal and an execution countable side by side).
    const watched = Object.create(inner) as StructuredToolInterface;
    watched.invoke = (async (input: unknown, config?: ToolRunnableConfig) => {
      try {
        return await inner.invoke(input as never, config);
      } catch (err) {
        if (isSchemaRefusal(err)) {
          const args = argsOf(input);
          emitFlowEvent(flow, {
            stage: "tool",
            level: "info",
            status: "skipped",
            detail: {
              tool: inner.name,
              // The discriminator a `tool`-stage line already carries (`precondition`,
              // `precondition_unmatched`, the side-effect phases), so nothing on the reading side
              // has to learn a new field to tell this line from the others.
              phase: "schema_refusal",
              // The payload, under the name the issue proposed: which declared parameters the
              // refusal was about, and in what way.
              refused: refusedParams(args, d),
              // What ARRIVED, by the same rule the executed call's line follows: the shape of each
              // value, keys named only where the tool declared them, and a key the model invented
              // counted as `'[unnamed keys]'` and never named.
              args: describe(args, d.keys),
              // NOTE: No `output`, and no `errorMessage`. The tool never ran, so there is no result;
              // and the only error text available here is the vendor's, which quotes the arguments.
            },
          });
        }
        throw err;
      }
    }) as StructuredToolInterface["invoke"];
    return watched;
  });
}
