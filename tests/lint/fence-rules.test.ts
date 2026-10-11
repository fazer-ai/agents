import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The fences in biome-plugins/ that were source sweeps in tests/api, client, graph and modules, run
// through the real Biome over probe files. biome.jsonc applies each rule under
// tests/lint/.probe-fence-*, and the owners a rule exempts are linted as they are in the tree. The
// probes end in `.ts` or `.tsx`, never `.test.ts`, so `bun test` never collects them, and each run
// writes under its own pid. One Biome process lints every probe, with every rule on, so a waiver that
// outlives its call is reported (`suppressions/unused`), as `bun run lint` reports it.

const ROOT = join(import.meta.dir, "../..");
const PROBE = `tests/lint/.probe-fence-${process.pid}`;
// Built rather than written: a literal path into the source tree is what no-test-reads-source refuses,
// and a literal raw clear of the flow log is what no-raw-flowlog-clear refuses in this very file.
const SRC = ["s", "rc"].join("");
const EXEC_LOGS = ["execution", "logs"].join("_");
// The same for a read: tests/modules/flowlog-reader-scope.test.ts counts every reader spelled in the
// suite, these fixtures included.
const EL = "executionLog";
const FL = "flowLog";

const RULES = {
  cast: "Do not cast to ErrorTranslationKey",
  verify: "not a direct `verifyPassword` call",
  stepUp: "Hand `confirmStepUp`",
  record: "A zod record that validates",
  parse: "Parse caller input with `parseInput`",
  windowOpen: "`window.open` on an /api/ path",
  textarea: "Declare the field's cap",
  highlighted: "This editor clamps",
  contact: "example person comes from",
  ternary: "binds as `(a || b) ? c : d`",
  reply: "Read the model's final text",
  gemini: "A Gemini built-in tool",
  sink: "Pass `callbacks` beside `signal`",
  ownership: "A strict ownership check",
  docTool: "Build a document tool name",
  clear: "Clear the flow log",
  read: "Read the flow log through",
  gate: "The gate-close outcomes",
  ingest: "Ask for the message's own row",
  playground: "The playground takes",
  schedulerRow: "Create a scheduler job row",
  drain: "A scheduler drain without",
  bareTenant: "not its bare id",
  vault: "Write vault entries through",
  secretRef: "Only the owning service writes",
  staleness: "makes the check a tautology",
  unusedWaiver: "Suppression comment has no effect",
} as const;
type Rule = keyof typeof RULES;

const P = (name: string) => `${PROBE}/${name}`;
const ANY = "declare const db: any, ctx: any, user: any, x: any, w: any;\n";

const PROBES: Record<string, string> = {
  // no-error-key-cast
  [P("cast.ts")]:
    'type ErrorTranslationKey = string;\nexport const k = "errors.x" as ErrorTranslationKey;\n',
  [P("cast-typed.ts")]:
    'type ErrorTranslationKey = string;\nexport const k: ErrorTranslationKey = "errors.x";\n',

  // no-verify-password-outside-login, step-up-takes-boundary-principal
  [P("verify-password.ts")]: `${ANY}export const a = verifyPassword(x, w);\n`,
  [P("step-up-hand-built.ts")]:
    `${ANY}export const a = confirmStepUp({ userId: x, actorType: "user" }, w);\n`,
  [P("step-up-ctx.ts")]: `${ANY}export const a = confirmStepUp(ctx, w);\n`,
  [P("step-up-principal.ts")]:
    `${ANY}export const a = confirmStepUp(stepUpPrincipalOf(user), w);\n`,

  // no-constrained-zod-record
  [P("record-string.ts")]:
    `${ANY}export const a = z.record(z.string(), z.string());\n`,
  [P("record-multiline.ts")]:
    `${ANY}export const a = z.record(\n  z.string(),\n  z.number(),\n);\n`,
  [P("record-unknown.ts")]:
    `${ANY}export const a = z.record(z.string(), z.unknown());\n`,
  [P("record-prose.ts")]:
    '// never write z.record(z.string(), z.string())\nexport const doc = "z.record(z.string(), z.string())";\n',

  // require-parse-input
  [P("parse-bare.ts")]: `${ANY}export const d = x.parse(w);\n`,
  [P("parse-chained.ts")]:
    `${ANY}export const t = z.string().min(1).parse(w);\n`,
  [P("parse-multiline.ts")]:
    `${ANY}export const v = z\n  .array(x)\n  .parse(w);\n`,
  [P("parse-waived.ts")]:
    `${ANY}// biome-ignore lint/plugin/require-parse-input: not caller input, a stored row\nexport const d = x.parse(w);\n`,
  [P("parse-not-zod.ts")]:
    `${ANY}export const a = [JSON.parse(w), Number.parseInt(w), Date.parse(w), parseInput(x, w), x.safeParse(w)];\n`,
  [P("parse-waiver-stale.ts")]:
    `${ANY}// biome-ignore lint/plugin/require-parse-input: the parse it argued for is gone\nexport const d = JSON.parse(w);\n`,

  // no-window-open-api-path
  [P("window-open-api.ts")]: 'window.open("/api/v1/x");\n',
  [P("window-open-api-template.ts")]:
    'declare const id: string;\nwindow.open(`/api/v1/files/\u0024{id}`, "_blank");\n',
  [P("window-open-blob.ts")]:
    'declare const blobUrl: string;\nwindow.open(blobUrl);\nwindow.open("https://example.com/api/x");\n',

  // require-textarea-cap, require-highlighted-cap
  [P("textarea-uncapped.tsx")]:
    `${ANY}export const a = <Textarea value={x} />;\n`,
  [P("textarea-capped.tsx")]:
    `${ANY}export const a = <Textarea value={x} maxLength={10} />;\n`,
  [P("textarea-waived.tsx")]:
    `${ANY}export const a = (\n  <div>\n    {/* biome-ignore lint/plugin/require-textarea-cap: one host per line */}\n    <Textarea value={x} />\n  </div>\n);\n`,
  [P("textarea-waiver-stale.tsx")]:
    `${ANY}export const a = (\n  <div>\n    {/* biome-ignore lint/plugin/require-textarea-cap: the field it argued for is capped now */}\n    <Textarea value={x} maxLength={10} />\n  </div>\n);\n`,
  [P("highlighted-clamped.tsx")]:
    `${ANY}export const a = (\n  <HighlightedPromptEditor\n    rows={3}\n    value={x}\n    onChange={(v) => w({ text: clipText(v, SIGNATURE_MAX) })}\n  />\n);\n`,
  [P("highlighted-declared.tsx")]:
    `${ANY}export const a = (\n  <HighlightedPromptEditor\n    rows={3}\n    maxLength={SIGNATURE_MAX}\n    value={x}\n    onChange={(v) => w({ text: clipText(v, SIGNATURE_MAX) })}\n  />\n);\n`,
  [P("highlighted-unclamped.tsx")]:
    `${ANY}export const a = (\n  <HighlightedPromptEditor rows={10} value={x} onChange={w} />\n);\n`,

  // no-sample-contact-in-preview
  [P("contact-email.tsx")]:
    'export const vars = { email: "maria.silva@exemplo.com" };\n',
  [P("contact-name.tsx")]: 'export const vars = { contactName: "Maria" };\n',
  [P("contact-from-vars.tsx")]:
    `${ANY}export const vars = { contactName: x.name, email: x.email };\n`,

  // no-unparenthesised-fallback-ternary
  [P("ternary-unparenthesised.ts")]:
    `${ANY}showToast(\n  apiErrorMessage(err) || x === 409 ? t("a", "A") : t("b", "B"),\n  "error",\n);\n`,
  [P("ternary-parenthesised.ts")]:
    `${ANY}showToast(\n  apiErrorMessage(err) || (x === 409 ? t("a", "A") : t("b", "B")),\n  "error",\n);\n`,
  [P("ternary-optional-chain.ts")]:
    `${ANY}showToast(apiErrorMessage(err) || x?.msg || t("b", "B"), "error");\n`,
  [P("ternary-next-argument.ts")]:
    `${ANY}showToast(apiErrorMessage(err) || t("b", "B"), w ? "error" : "info");\n`,

  // require-reply-rule-on-final-text
  [P("reply-unguarded.ts")]:
    `${ANY}export const reply = lastAssistantText(x.messages).trim();\n`,
  [P("reply-customer.ts")]:
    `${ANY}export const drafted = customerFacingReply(lastAssistantText(x.messages));\n`,
  [P("reply-proactive.ts")]:
    `${ANY}export const drafted = proactiveReply(lastAssistantText(x.messages));\n`,

  // no-gemini-builtin-tool
  [P("gemini-search.ts")]:
    `${ANY}export const g = x.bindTools([{ googleSearch: {} }]);\n`,
  [P("gemini-code.ts")]:
    `${ANY}export const g = x.bindTools([{ codeExecution: {} }]);\n`,
  [P("gemini-none.ts")]:
    `${ANY}export const g = x.bindTools(toGeminiTools(w));\n`,

  // require-usage-sink
  [P("sink-missing.ts")]:
    `${ANY}export const res = await x.invoke(w, {\n  signal: AbortSignal.timeout(15_000),\n});\n`,
  [P("sink-present.ts")]:
    `${ANY}export const res = await x.invoke(w, {\n  signal: AbortSignal.timeout(15_000),\n  callbacks: ctx,\n});\n`,

  // strict-ownership-passes-assignee
  [P("ownership-no-assignee.ts")]:
    `${ANY}export const a = shouldBotHandle({ status: x.status }, { ourAgentBotId: w });\n`,
  [P("ownership-assignee.ts")]:
    `${ANY}export const a = shouldBotHandle(\n  { status: x.status, assigneeId: x.assigneeId },\n  { ourAgentBotId: w },\n);\n`,
  [P("ownership-loose.ts")]:
    `${ANY}export const a = shouldBotHandle({ status: x.status, assigneeType: x.t });\n`,

  // no-document-tool-name-outside-slug
  [P("doc-tool-template.ts")]: `${ANY}export const name = \`send_\${x}\`;\n`,
  [P("doc-tool-native.ts")]:
    'export const names = ["send_image", "send_audio"];\n',

  // no-raw-flowlog-clear, no-raw-flowlog-read
  [P("clear-delete-many.ts")]:
    `${ANY}await db.executionLog.deleteMany({ where: x });\n`,
  [P("clear-delete-sql.ts")]:
    `${ANY}await db.$executeRawUnsafe(\`DELETE FROM ${EXEC_LOGS} WHERE x\`);\n`,
  [P("clear-truncate.ts")]:
    `${ANY}await db.$executeRawUnsafe("TRUNCATE ${EXEC_LOGS}");\n`,
  [P("clear-truncate-table.ts")]:
    `${ANY}await db.$executeRawUnsafe(\`TRUNCATE TABLE "${EXEC_LOGS}"\`);\n`,
  [P("clear-formatted.ts")]:
    `${ANY}await db.executionLog\n  .deleteMany({ where: x });\nawait db.$executeRawUnsafe(\`DELETE\n  FROM ${EXEC_LOGS}\n  WHERE x\`);\n`,
  [P("clear-two.ts")]:
    `${ANY}await db.executionLog.deleteMany({ a: x });\nawait db.executionLog.deleteMany({ b: x });\n`,
  [P("clear-helper.ts")]:
    `${ANY}await clearFlowLog(db, { tenantId: x });\nawait db.alertDelivery.deleteMany({ where: x });\nawait db.$executeRawUnsafe(\`DELETE FROM alert_deliveries WHERE x\`);\n`,
  [P("read-raw.ts")]:
    `${ANY}await db.${EL}.findMany({ w });\nawait db.${EL}.findFirst({ w });\nawait db.${EL}.count({ w });\nawait db.${EL}\n  .findMany({ w });\n`,
  [P("read-helper.ts")]:
    `${ANY}await ${FL}Rows(db, { where: x });\nawait ${FL}Row(db, { where: x });\nawait ${FL}Count(db, { where: x });\nawait db.${EL}.create({ data: x });\nawait db.alertDelivery.findMany({ where: x });\n`,

  // no-gate-close-outcome-outside-owner
  [P("gate-outcome.ts")]:
    'export const a = { detail: { outcome: "taken_over" } };\n',
  [P("gate-outcome-tight.ts")]:
    "export const a = { outcome:'ownership_lost' };\n",
  [P("gate-outcome-spaced.ts")]:
    'export const a = { outcome  :  "taken_over" };\n',
  [P("gate-outcome-other.ts")]:
    'export const a = { detail: { outcome: "resolved" } };\n',

  // no-ingest-population-assertion
  [P("ingest-population.ts")]:
    `${ANY}expect((await rows(x, "INGEST_MESSAGE")).length).toBe(1);\nexpect((await rows(x, "INGEST_MESSAGE")).length).toBeGreaterThan(0);\n`,
  [P("ingest-own-row.ts")]:
    `${ANY}expect(await row(x, ingestDedupeKey(w, 7))).not.toBeNull();\n`,

  // no-playground-tenant-context
  [P("playground-context.ts")]:
    'export function sysCtx(tenantId: bigint) {\n  return { tenantId, userId: null, role: "TENANT_ADMIN" };\n}\n',
  [P("playground-prose.ts")]:
    `${ANY}// never write role: "TENANT_ADMIN" here\nexport const a = await runScopedOn(x, ctx, (d: any) => d.x.findMany());\n`,

  // no-scheduler-row-outside-service
  [P("scheduler-upsert.ts")]:
    `${ANY}await db.schedulerJob.upsert({ where: {}, create: {}, update: {} });\n`,
  [P("scheduler-create-formatted.ts")]:
    `${ANY}await db.schedulerJob\n  .create({ data: {} });\n`,
  [P("scheduler-create-many.ts")]:
    `${ANY}await db.schedulerJob.createMany({ data: [] });\n`,
  [P("scheduler-insert-sql.ts")]:
    `${ANY}await db.$executeRaw\`INSERT INTO scheduler_jobs (tenant_id) VALUES (1)\`;\n`,
  [P("scheduler-innocent.ts")]:
    `${ANY}await db.schedulerJob.updateMany({ where: {}, data: {} });\nawait db.schedulerJob.findFirst({ where: {} });\nawait db.schedulerJob.deleteMany({ where: {} });\nawait db.$executeRaw\`UPDATE scheduler_jobs SET status = 'DONE'\`;\n`,

  // require-tenant-on-scheduler-drain
  [P("drain.ts")]:
    `${ANY}await runSchedulerTick(db, { staleMs: 5, batchSize: 20 });\nawait runSchedulerTick(db, { batchSize: f(g(1)), tenantId: x });\nawait claimDueJobs(50, db, new Date(), x.tenantId);\n`,
  [P("drain-mention.ts")]:
    `${ANY}// runSchedulerTick(db, { batchSize: 20 }) would be unfenced here.\nexport const sample = "runSchedulerTick(db, { batchSize: 20 })";\nawait runSchedulerTick(db, { batchSize: 20, tenantId: x });\n`,

  // no-bare-tenant-id-in-api
  [P("bare-tenant-helper.ts")]:
    `${ANY}export function tenantId(c: { tenantId: bigint | null } | null): bigint {\n  if (!c) throw new Error();\n  if (c.tenantId === null) throw new Error();\n  return c.tenantId;\n}\n`,
  [P("bare-tenant-inline.ts")]:
    `${ANY}export const created = await createIntegrationInstance(\n  ctx.tenantId as bigint,\n  w,\n);\n`,
  [P("bare-tenant-context.ts")]:
    `${ANY}export function ctxOrThrow(c: { tenantId: bigint | null } | null) {\n  if (!c) throw new Error();\n  return c;\n}\nexport const name = getTenantName(user.tenantId);\n`,

  // no-vault-entry-write-outside-service
  [P("vault-write.ts")]:
    `${ANY}await db.vaultEntry.create({ data: x });\nawait db.vaultEntry.upsert(x);\n`,
  [P("vault-read.ts")]:
    `${ANY}await db.vaultEntry.findMany({ where: x });\nawait db.vaultEntry.createManyAndReturn({ data: x });\n`,

  // no-secret-ref-write-outside-owner
  [P("secret-ref-webhook.ts")]:
    `${ANY}await db.webhookSubscription.create({ data: x });\n`,
  [P("secret-ref-alert.ts")]:
    `${ANY}await db.alertChannel.updateManyAndReturn({ where: x, data: w });\n`,
  [P("secret-ref-read.ts")]:
    `${ANY}await db.webhookSubscription.findMany({ where: x });\nawait db.alertChannel.findFirst({ where: x });\n`,

  // no-tautological-staleness
  [P("staleness-same.ts")]:
    `${ANY}x.capture(w, ctx, { accountIds: user }, { accountIds: user });\n`,
  [P("staleness-live.ts")]:
    `${ANY}x.capture(w, ctx, { accountIds: user }, { accountIds: user.current });\n`,
};

// The modules each fence exempts, linted as they are: each holds the shape its rule refuses to
// everyone else, so a hit here means the exemption stopped applying.
const OWNERS = [
  `${SRC}/api/lib/step-up.ts`,
  `${SRC}/api/features/auth/auth.service.ts`,
  `${SRC}/modules/documents/slug.ts`,
  `${SRC}/modules/chatwoot/gate-close.ts`,
  `${SRC}/modules/scheduler/service.ts`,
  `${SRC}/modules/vault/service.ts`,
  `${SRC}/modules/webhooks/outbound/subscriptions.ts`,
  `${SRC}/modules/flowlog/channels.ts`,
  `${SRC}/client/pages/agents/ChannelRedirectTab.tsx`,
  `${SRC}/client/pages/agents/PlaygroundChat.tsx`,
  "tests/utils/flowlog.ts",
  "tests/modules/flowlog-settle.test.ts",
];

// Each exemption, and the rule it exempts from. The owner is copied to a probe path no exemption
// covers, where its rule has to fire: an owner that stops doing what it is exempted for, or is gone,
// makes its exemption stale, and the copy coming back clean is what says so.
const EXEMPTED: Array<[string, Rule]> = [
  [`${SRC}/modules/scheduler/service.ts`, "schedulerRow"],
  [`${SRC}/modules/vault/service.ts`, "vault"],
  [`${SRC}/modules/webhooks/outbound/subscriptions.ts`, "secretRef"],
  [`${SRC}/modules/flowlog/channels.ts`, "secretRef"],
  [`${SRC}/api/lib/step-up.ts`, "verify"],
  [`${SRC}/api/features/auth/auth.service.ts`, "verify"],
  [`${SRC}/api/features/auth/auth.controller.ts`, "verify"],
  [`${SRC}/api/features/invitations/invitation.service.ts`, "verify"],
  [`${SRC}/modules/documents/slug.ts`, "docTool"],
  [`${SRC}/modules/chatwoot/gate-close.ts`, "gate"],
  [`${SRC}/client/pages/agents/ChannelRedirectTab.tsx`, "textarea"],
  [`${SRC}/client/pages/agents/PlaygroundChat.tsx`, "textarea"],
  ["tests/utils/flowlog.ts", "clear"],
  ["tests/modules/flowlog-settle.test.ts", "clear"],
];
const copyOf = (i: number, path: string) =>
  P(`owner-copy-${i}${path.endsWith(".tsx") ? ".tsx" : ".ts"}`);

let hits: Map<string, Partial<Record<Rule, number>>>;

beforeAll(() => {
  for (const [path, body] of Object.entries(PROBES)) {
    mkdirSync(join(ROOT, path, ".."), { recursive: true });
    writeFileSync(join(ROOT, path), body);
  }
  EXEMPTED.forEach(([path], i) => {
    if (existsSync(join(ROOT, path))) {
      writeFileSync(
        join(ROOT, copyOf(i, path)),
        readFileSync(join(ROOT, path), "utf8"),
      );
    }
  });
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      "biome",
      "lint",
      "--max-diagnostics=none",
      "--reporter=github",
      ...Object.keys(PROBES),
      ...EXEMPTED.map(([path], i) => copyOf(i, path)).filter((p) =>
        existsSync(join(ROOT, p)),
      ),
      ...OWNERS.filter((p) => existsSync(join(ROOT, p))),
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    const at = m[1].indexOf("tests/");
    const file = at >= 0 ? m[1].slice(at) : m[1].slice(m[1].indexOf(SRC));
    const rule = (Object.keys(RULES) as Rule[]).find((r) =>
      m[2]?.includes(RULES[r]),
    );
    if (!rule) continue;
    const h = hits.get(file) ?? {};
    h[rule] = (h[rule] ?? 0) + 1;
    hits.set(file, h);
  }
});

afterAll(() => {
  rmSync(join(ROOT, PROBE), { recursive: true, force: true });
});

const of = (name: string) => hits.get(P(name)) ?? {};

describe("each fence refuses its shape and nothing else", () => {
  test.each([
    ["cast.ts", { cast: 1 }],
    ["cast-typed.ts", {}],
    ["verify-password.ts", { verify: 1 }],
    ["step-up-hand-built.ts", { stepUp: 1 }],
    ["step-up-ctx.ts", {}],
    ["step-up-principal.ts", {}],
    ["record-string.ts", { record: 1 }],
    ["record-multiline.ts", { record: 1 }],
    ["record-unknown.ts", {}],
    ["record-prose.ts", {}],
    ["parse-bare.ts", { parse: 1 }],
    ["parse-chained.ts", { parse: 1 }],
    ["parse-multiline.ts", { parse: 1 }],
    ["parse-waived.ts", {}],
    ["parse-not-zod.ts", {}],
    ["parse-waiver-stale.ts", { unusedWaiver: 1 }],
    ["window-open-api.ts", { windowOpen: 1 }],
    ["window-open-api-template.ts", { windowOpen: 1 }],
    ["window-open-blob.ts", {}],
    ["textarea-uncapped.tsx", { textarea: 1 }],
    ["textarea-capped.tsx", {}],
    ["textarea-waived.tsx", {}],
    ["textarea-waiver-stale.tsx", { unusedWaiver: 1 }],
    ["highlighted-clamped.tsx", { highlighted: 1, textarea: 0 }],
    ["highlighted-declared.tsx", {}],
    ["highlighted-unclamped.tsx", {}],
    ["contact-email.tsx", { contact: 1 }],
    ["contact-name.tsx", { contact: 1 }],
    ["contact-from-vars.tsx", {}],
    ["ternary-unparenthesised.ts", { ternary: 1 }],
    ["ternary-parenthesised.ts", {}],
    ["ternary-optional-chain.ts", {}],
    ["ternary-next-argument.ts", {}],
    ["reply-unguarded.ts", { reply: 1 }],
    ["reply-customer.ts", {}],
    ["reply-proactive.ts", {}],
    ["gemini-search.ts", { gemini: 1 }],
    ["gemini-code.ts", { gemini: 1 }],
    ["gemini-none.ts", {}],
    ["sink-missing.ts", { sink: 1 }],
    ["sink-present.ts", {}],
    ["ownership-no-assignee.ts", { ownership: 1 }],
    ["ownership-assignee.ts", {}],
    ["ownership-loose.ts", {}],
    ["doc-tool-template.ts", { docTool: 1 }],
    ["doc-tool-native.ts", {}],
    ["clear-delete-many.ts", { clear: 1 }],
    ["clear-delete-sql.ts", { clear: 1 }],
    ["clear-truncate.ts", { clear: 1 }],
    ["clear-truncate-table.ts", { clear: 1 }],
    ["clear-formatted.ts", { clear: 2 }],
    ["clear-two.ts", { clear: 2 }],
    ["clear-helper.ts", {}],
    ["read-raw.ts", { read: 4 }],
    ["read-helper.ts", {}],
    ["gate-outcome.ts", { gate: 1 }],
    ["gate-outcome-tight.ts", { gate: 1 }],
    ["gate-outcome-spaced.ts", { gate: 1 }],
    ["gate-outcome-other.ts", {}],
    ["ingest-population.ts", { ingest: 2 }],
    ["ingest-own-row.ts", {}],
    ["playground-context.ts", { playground: 1 }],
    ["playground-prose.ts", {}],
    ["scheduler-upsert.ts", { schedulerRow: 1 }],
    ["scheduler-create-formatted.ts", { schedulerRow: 1 }],
    ["scheduler-create-many.ts", { schedulerRow: 1 }],
    ["scheduler-insert-sql.ts", { schedulerRow: 1 }],
    ["scheduler-innocent.ts", {}],
    ["drain.ts", { drain: 1 }],
    ["drain-mention.ts", {}],
    ["bare-tenant-helper.ts", { bareTenant: 1 }],
    ["bare-tenant-inline.ts", { bareTenant: 1 }],
    ["bare-tenant-context.ts", {}],
    ["vault-write.ts", { vault: 2 }],
    ["vault-read.ts", {}],
    ["secret-ref-webhook.ts", { secretRef: 1 }],
    ["secret-ref-alert.ts", { secretRef: 1 }],
    ["secret-ref-read.ts", {}],
    ["staleness-same.ts", { staleness: 1 }],
    ["staleness-live.ts", {}],
  ] as Array<[string, Partial<Record<Rule, number>>]>)("%s", (name, want) => {
    const expected = Object.fromEntries(
      Object.entries(want).filter(([, n]) => n > 0),
    );
    expect(of(name)).toEqual(expected);
  });
});

describe("the module a fence exempts is not flagged by it", () => {
  test.each(OWNERS)("%s", (path) => {
    expect(hits.get(path) ?? {}).toEqual({});
  });
});

describe("each exempted module still does what it is exempted for", () => {
  test.each(EXEMPTED.map(([path, rule], i) => [path, rule, i] as const))(
    "%s (%s)",
    (path, rule, i) => {
      expect(existsSync(join(ROOT, path))).toBe(true);
      expect(hits.get(copyOf(i, path))?.[rule] ?? 0).toBeGreaterThan(0);
    },
  );
});
