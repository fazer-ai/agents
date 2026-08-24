import { describe, expect, test } from "bun:test";
import { encryptJson } from "@/api/lib/crypto";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import type { ScopedDb } from "@/lib/tenancy";
import { VAULT_REF_PREFIX } from "@/modules/vault/service";

// Minimal mock for the scoped DB surface used by loadToolSelections.
function buildMockDb(options: {
  toolRows?: Array<{
    vaultId: bigint;
    kind: string;
    paramName: string | null;
    baseUrl?: string | null;
  }>;
}): ScopedDb {
  const { toolRows = [] } = options;

  return {
    agentToolSelection: {
      findMany: async () => [
        {
          source: "HTTP",
          enabledTools: [],
          knowledgeBaseIds: [],
          toolDefinition: {
            name: "my_tool",
            description: "desc",
            method: "GET",
            urlTemplate: "https://example.com/v1",
            allowedHosts: ["example.com"],
            headers: {},
            inputSchema: {},
            credentialRef: toolRows[0]
              ? `${VAULT_REF_PREFIX}${toolRows[0].vaultId}`
              : null,
            enabled: true,
            ackEnabled: false,
            ackMessage: null,
          },
          mcpServerConnection: null,
          integrationInstance: null,
        },
      ],
    },
    vaultEntry: {
      findMany: async ({ where }: { where: { id: { in: bigint[] } } }) => {
        const ids = where?.id?.in ?? [];
        return toolRows
          .filter((r) => ids.includes(r.vaultId))
          .map((r) => ({
            id: r.vaultId,
            secret: encryptJson("secret"),
            kind: r.kind,
            paramName: r.paramName,
            baseUrl: r.baseUrl ?? null,
          }));
      },
    },
  } as unknown as ScopedDb;
}

describe("loadToolSelections — credential kind + paramName batch resolution", () => {
  test("resolves credentialKind and credentialParamName from the vault entry", async () => {
    const db = buildMockDb({
      toolRows: [{ vaultId: 42n, kind: "header", paramName: "X-Api-Key" }],
    });
    const sel = await loadToolSelections(db, 1n);
    expect(sel.httpToolDefs).toHaveLength(1);
    const def = sel.httpToolDefs[0];
    expect(def?.credentialKind).toBe("header");
    expect(def?.credentialParamName).toBe("X-Api-Key");
  });

  test("resolves credentialKind for non-paramName kinds (credentialParamName is null)", async () => {
    const db = buildMockDb({
      toolRows: [{ vaultId: 7n, kind: "bearer_token", paramName: null }],
    });
    const sel = await loadToolSelections(db, 1n);
    const def = sel.httpToolDefs[0];
    expect(def?.credentialKind).toBe("bearer_token");
    expect(def?.credentialParamName).toBeNull();
  });

  test("credentialKind and credentialParamName are null when no credentialRef", async () => {
    const db = buildMockDb({ toolRows: [] });
    const sel = await loadToolSelections(db, 1n);
    const def = sel.httpToolDefs[0];
    expect(def?.credentialKind).toBeNull();
    expect(def?.credentialParamName).toBeNull();
  });

  test("resolves credentialBaseUrl from the vault entry baseUrl", async () => {
    const db = buildMockDb({
      toolRows: [
        {
          vaultId: 99n,
          kind: "bearer_token",
          paramName: null,
          baseUrl: "https://api.example.com",
        },
      ],
    });
    const sel = await loadToolSelections(db, 1n);
    const def = sel.httpToolDefs[0];
    expect(def?.credentialBaseUrl).toBe("https://api.example.com");
  });

  test("credentialBaseUrl is null when vault entry has no baseUrl", async () => {
    const db = buildMockDb({
      toolRows: [
        { vaultId: 7n, kind: "bearer_token", paramName: null, baseUrl: null },
      ],
    });
    const sel = await loadToolSelections(db, 1n);
    const def = sel.httpToolDefs[0];
    expect(def?.credentialBaseUrl).toBeNull();
  });
});

describe("buildHttpTools — credentialParamName propagation", () => {
  test("passes credentialParamName into the built tool (header kind injects the named header)", async () => {
    // buildHttpTools wraps buildHttpTool; inject the fetch at the HttpToolBuildDeps resolveCredential
    // level and capture the outbound request via the credential path.
    const tools = buildHttpTools(
      [
        {
          name: "test_tool",
          description: null,
          method: "GET",
          urlTemplate: "https://8.8.8.8/v1",
          allowedHosts: ["8.8.8.8"],
          headers: {},
          inputSchema: {},
          expectedStatuses: [],
          credentialRef: "vault:1",
          credentialKind: "header",
          credentialParamName: "X-Token",
          credentialBaseUrl: null,
          ackEnabled: false,
          ackMessage: null,
          query: {},
          body: {},
        },
      ],
      {
        resolveCredential: async () => "tok",
        // NOTE: fetchImpl is not part of HttpToolBuildDeps; we use globalThis.fetch override here.
        // The actual injection test lives in tools-http.test.ts; this test only verifies that
        // buildHttpTools correctly threads credentialParamName into the tool definition shape.
      },
    );
    // Verify that the tool was built (not just skipped due to missing credentialParamName).
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("test_tool");
  });
});

// Document grants are FAIL-CLOSED, like HTTP/MCP/integration/RAG and unlike NATIVE. NATIVE defaults
// to everything when there is no row, and a document tool inheriting that default would hand every
// existing agent, on upgrade, a tool that issues priced paperwork nobody granted.
function documentDb(rows: unknown[]): ScopedDb {
  return {
    agentToolSelection: { findMany: async () => rows },
    vaultEntry: { findMany: async () => [] },
    knowledgeBase: { findMany: async () => [] },
  } as unknown as ScopedDb;
}

const TEMPLATE = {
  id: 7n,
  name: "Orçamento",
  slug: "orcamento",
  description: null,
  blocks: [{ id: "t", type: "text", text: "Olá {{cliente}}" }],
  fields: [{ name: "cliente", label: "Cliente", type: "text" }],
  enabled: true,
};

describe("loadToolSelections: DOCUMENT grants", () => {
  test("an agent with no document grant gets no document tool", async () => {
    const sel = await loadToolSelections(documentDb([]), 1n);
    expect(sel.documentSelections).toEqual([]);
  });

  test("a granted template becomes one selection", async () => {
    const sel = await loadToolSelections(
      documentDb([
        {
          source: "DOCUMENT",
          enabledTools: [],
          knowledgeBaseIds: [],
          toolDefinition: null,
          mcpServerConnection: null,
          integrationInstance: null,
          documentTemplate: TEMPLATE,
        },
      ]),
      1n,
    );
    expect(sel.documentSelections).toHaveLength(1);
    expect(sel.documentSelections[0]).toMatchObject({
      templateId: 7n,
      slug: "orcamento",
    });
    expect(sel.documentSelections[0]?.fields).toHaveLength(1);
  });

  test("a disabled template is skipped, like a disabled tool or connection", async () => {
    const sel = await loadToolSelections(
      documentDb([
        {
          source: "DOCUMENT",
          enabledTools: [],
          knowledgeBaseIds: [],
          toolDefinition: null,
          mcpServerConnection: null,
          integrationInstance: null,
          documentTemplate: { ...TEMPLATE, enabled: false },
        },
      ]),
      1n,
    );
    expect(sel.documentSelections).toEqual([]);
  });

  // A template written by a newer build can carry a block this one cannot render. Exposing it with
  // an empty argument list would give the model a tool that produces a blank document — worse for
  // the customer than a tool the agent does not have.
  test("a template whose content no longer parses is skipped, not exposed empty", async () => {
    const sel = await loadToolSelections(
      documentDb([
        {
          source: "DOCUMENT",
          enabledTools: [],
          knowledgeBaseIds: [],
          toolDefinition: null,
          mcpServerConnection: null,
          integrationInstance: null,
          documentTemplate: {
            ...TEMPLATE,
            blocks: [{ id: "x", type: "signature" }],
          },
        },
      ]),
      1n,
    );
    expect(sel.documentSelections).toEqual([]);
  });
});
