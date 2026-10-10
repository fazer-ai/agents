import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { replaceAgentToolSelections } from "@/modules/agents/service";
import {
  createCodeTool,
  deleteCodeTool,
  updateCodeTool,
} from "@/modules/code-tools/service";
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import { lockToolNames } from "@/modules/tool-definitions/namespace";
import {
  createToolDefinition,
  deleteToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// An agent import takes the tenant's tool-name lock ONCE, before it touches any tool row
// (createMissingComponents in modules/agents/transfer.ts), then reads and writes rows under it. Every
// other path that takes both locks takes them in that order, or the two deadlock (row held, waiting
// for the namespace, against namespace held, waiting for the row) and Postgres kills one, losing a
// whole import to a concurrent save of an unrelated tool. Each writer is started while another
// transaction holds the namespace: it has to park there, and while it waits the row it is about to
// lock must still be free, which a `NOWAIT` probe from a third transaction proves.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: 9520n,
  role: "TENANT_ADMIN",
});

const uniq = () => `${process.pid}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!dbUp)(
  "the namespace lock is taken before any row lock",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "LOCKORDER", slug: `lockorder-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (tenantId) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    // Holds the tenant's tool-name lock until released, and answers with the holder's backend pid.
    async function holdNamespace() {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let announce!: (pid: number) => void;
      const gotIt = new Promise<number>((r) => {
        announce = r;
      });
      const done = runScopedOn(suDb, ctx(), async (db) => {
        await lockToolNames(db);
        const [me] = await db.$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid()::int AS pid`;
        announce(me?.pid as number);
        await held;
      });
      return { pid: await gotIt, release, done };
    }

    async function parksOnTheNamespaceFirst(
      table: string,
      id: bigint,
      write: () => Promise<unknown>,
    ) {
      const holder = await holdNamespace();
      const writing = write();
      writing.catch(() => {});
      try {
        expect(
          await waitUntilBlocked(suDb, holder.pid, 1),
        ).toBeGreaterThanOrEqual(0);
        await suDb.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT 1 FROM "${table}" WHERE "id" = ${id} FOR UPDATE NOWAIT`,
          );
        });
      } finally {
        holder.release();
        await holder.done;
        await writing;
      }
    }

    test("tool definitions: update and delete", async () => {
      const tool = await createToolDefinition(
        ctx(),
        {
          name: `ordem_${uniq()}`,
          label: "Ordem",
          method: "GET",
          urlTemplate: "https://8.8.8.8/x",
          allowedHosts: ["8.8.8.8"],
        },
        appDb,
      );
      const id = BigInt(tool.id);
      await parksOnTheNamespaceFirst("tool_definitions", id, () =>
        updateToolDefinition(ctx(), id, { label: "Ordem 2" }, appDb),
      );
      await parksOnTheNamespaceFirst("tool_definitions", id, () =>
        deleteToolDefinition(ctx(), id, appDb),
      );
    });

    test("code tools: update and delete", async () => {
      const created = await createCodeTool(
        ctx(),
        {
          name: `ordem_codigo_${uniq()}`,
          label: "Ordem",
          description: "d",
          code: "return 1",
        },
        appDb,
      );
      const id = BigInt(created.tool.id);
      await parksOnTheNamespaceFirst("code_tool_definitions", id, () =>
        updateCodeTool(ctx(), id, { label: "Ordem 2" }, appDb),
      );
      await parksOnTheNamespaceFirst("code_tool_definitions", id, () =>
        deleteCodeTool(ctx(), id, appDb),
      );
    });

    test("document templates: update and delete", async () => {
      const created = await createDocumentTemplate(
        ctx(),
        {
          name: `ordem ${uniq()}`,
          blocks: [{ id: "t", type: "text", text: "x" }],
          fields: [],
        },
        appDb,
      );
      const id = BigInt(created.id);
      await parksOnTheNamespaceFirst("document_templates", id, () =>
        updateDocumentTemplate(ctx(), id, { enabled: false }, appDb),
      );
      await parksOnTheNamespaceFirst("document_templates", id, () =>
        deleteDocumentTemplate(ctx(), id, appDb),
      );
    });

    // NOTE: The fourth path, and the one that takes NO row lock on a tool: it locks the AGENT row, deletes
    // the selection rows, and only then asks the foreign key for the tool, which is enough to close the
    // cycle against a delete holding the tool row (`tests/modules/grant-target-vanishes.test.ts` forces
    // it). The lock comes first here for the same reason, so the probe asks for the agent's row.
    test("an agent's grant replacement", async () => {
      const agent = await suDb.agent.create({
        data: { tenantId, name: "Ordem", systemPrompt: "x" },
        select: { id: true },
      });
      await parksOnTheNamespaceFirst("agents", agent.id, () =>
        replaceAgentToolSelections(
          ctx(),
          agent.id,
          [{ source: "NATIVE", enabledTools: ["handoff_to_human"] }],
          appDb,
        ),
      );
    });
  },
);
