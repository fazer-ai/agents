import { AppError } from "@/lib/errors";

// n8n workflow export (pure). The security-critical invariant (hardened spec): a generated
// workflow must NEVER carry a secret. We enforce this with BOTH halves of belt-and-suspenders:
//   1. ALLOWLIST construction — the workflow is built field-by-field from a curated safe shape,
//      never by spreading arbitrary tenant objects (so credentials/headers simply never enter);
//   2. a VALUE scan backstop — assertNoSecrets walks the finished JSON and throws if any string
//      VALUE looks like a secret (a secret hidden in a url or under an innocent key is caught).
// A name-based denylist alone would be a disguised denylist and miss secrets under innocent keys.

export class SecretLeakError extends AppError {
  constructor(where: string) {
    super(`refusing to export: a secret-like value was found in ${where}`, 400);
    this.name = "SecretLeakError";
  }
}

// High-confidence secret shapes. Deliberately NOT matching our own `{{secret}}` vault placeholder
// (that is a reference, not a secret) — only concrete token material.
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\b(?:bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/i, // Authorization header material
  /\bsk-[A-Za-z0-9]{16,}\b/, // OpenAI-style keys
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/, // JWT
];

// A key=value / "key": "value" pair where the KEY names a credential AND the VALUE is concrete
// (not our {{...}} placeholder, not empty).
const SECRET_KV_PATTERN =
  /(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|secret)["']?\s*[:=]\s*["']?(?!\s*\{\{)([^\s"'&]{6,})/i;

function isPlaceholder(value: string): boolean {
  // Our vault-reference syntax, e.g. {{secret}} — a reference, never a real secret.
  return /^\{\{\s*[\w.]+\s*\}\}$/.test(value.trim());
}

function scanString(value: string, where: string): void {
  if (isPlaceholder(value)) return;
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(value)) throw new SecretLeakError(where);
  }
  if (SECRET_KV_PATTERN.test(value)) throw new SecretLeakError(where);
}

// The same question asked of SOURCE CODE, where the key/value matcher above cannot be used as it
// stands. In a JSON value, `password: <anything concrete>` is a leak. In a program it is usually a
// variable: `const password = input.password` and `return { authorization: input.authorization }`
// are what a body that FORWARDS a credential looks like, and refusing them makes the agent that
// owns such a tool unexportable, with the scanner blocking the backup it exists to protect (round
// 30, measured: four ordinary bodies refused).
//
// So the pair still has to be concrete, and in code "concrete" means a STRING LITERAL. An
// expression is a reference to a value that lives elsewhere; a quoted run of characters is the
// value itself. Everything else the scanner knows (the shaped patterns: `sk-`, `AKIA`, a JWT) is
// applied unchanged, since those are recognisable wherever they appear, quoted or not.
//
// THREE delimiters, not two, and the third is not symmetric with the others. JavaScript writes a
// literal with `'`, `"` or a backtick, and a backtick one is exactly as concrete as the other two
// (round 31: `const apiKey = \`abcdef123456\`` walked out of the scanner untouched) -- until it
// INTERPOLATES, at which point it is an expression again and `const api_key = \`${input.chave}\``
// is the same forwarding body the paragraph above exists to allow. So the backtick arm rejects the
// whole literal when a `${` appears anywhere inside it, which is the template equivalent of the
// `{{` guard the JSON scanner already carries.
const SECRET_KV_IN_CODE_PATTERN =
  /(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|authorization|secret)["'`]?\s*[:=]\s*(?:(["'])(?!\s*\{\{)[^"'\s&]{6,}\1|`(?!\s*\{\{)(?![^`]*\$\{)[^`\s&]{6,}`)/i;

export function assertNoSecretsInCode(code: string, where: string): void {
  if (isPlaceholder(code)) return;
  for (const re of SECRET_VALUE_PATTERNS) {
    if (re.test(code)) throw new SecretLeakError(where);
  }
  if (SECRET_KV_IN_CODE_PATTERN.test(code)) throw new SecretLeakError(where);
}

// Recursively asserts that no string VALUE anywhere in the object looks like a secret.
export function assertNoSecrets(node: unknown, path = "$"): void {
  if (typeof node === "string") {
    scanString(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      assertNoSecrets(v, `${path}[${i}]`);
    });
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      // The KEY is also scanned as a string (a secret accidentally used as a key name).
      scanString(k, `${path}.<key>`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  active: false;
}

export interface ToolWorkflowInput {
  name: string;
  method: string;
  url: string;
}

// Builds an importable n8n workflow (Manual Trigger → HTTP Request) mirroring an HTTP tool.
// Auth is intentionally NOT included: the importer configures an n8n credential (see the
// returned `credentialsNote`). Node ids are deterministic so the output is stable/testable.
export function buildToolWorkflow(input: ToolWorkflowInput): N8nWorkflow {
  const trigger: N8nNode = {
    id: "node-trigger",
    name: "When clicked",
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    position: [240, 300],
    parameters: {},
  };
  const http: N8nNode = {
    id: "node-http",
    name: "HTTP Request",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4,
    position: [480, 300],
    parameters: {
      method: input.method.toUpperCase(),
      url: input.url,
      // No credential material — the importer wires n8n credentials manually.
      authentication: "none",
      options: {},
    },
  };
  const workflow: N8nWorkflow = {
    name: input.name,
    nodes: [trigger, http],
    connections: {
      "When clicked": {
        main: [[{ node: "HTTP Request", type: "main", index: 0 }]],
      },
    },
    settings: {},
    active: false,
  };
  // Backstop: even though we built from an allowlist, refuse to emit if anything secret-like
  // slipped through (e.g. a secret hardcoded in the tool's url).
  assertNoSecrets(workflow);
  return workflow;
}

export const CREDENTIALS_NOTE =
  "This workflow contains no credentials. Configure authentication for the HTTP Request node in n8n (e.g. a Header Auth or Bearer credential) before running it.";
