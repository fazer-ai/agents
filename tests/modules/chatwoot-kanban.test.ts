import { afterEach, describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  __resetKanbanStepsCache,
  loadKanbanContext,
  matchKanbanStep,
} from "@/modules/chatwoot/kanban";

afterEach(() => __resetKanbanStepsCache());

const STEPS = [
  {
    id: 7,
    name: "Novo Lead",
    description: "Lead recém-chegado",
    color: "#aaa",
  },
  { id: 8, name: "Qualificando", color: "#bbb" },
  { id: 9, name: "Proposta Enviada" },
  { id: 10, name: "Perdido", cancelled: true },
];

function fullCard(id: number) {
  return {
    id,
    board_id: 2,
    board_step_id: 8,
    board: { name: "Vendas SDR" },
    title: "João - Plano Pro",
    description: "Cliente quer fechar até o fim do mês",
    priority: "high",
    status: "open",
    value: 1500,
    start_date: "2026-06-10T09:00:00-03:00",
    due_date: "2026-06-30T18:00:00-03:00",
    custom_attributes: { orcamento: 2000, produto: "Plano Pro" },
    labels: ["vip", "quente"],
  };
}

function fakeClient(opts: {
  taskId: number | null;
  stepsCalls?: { n: number };
  // The fork wraps steps under `steps`; older shapes used `payload` or a bare array — all accepted.
  stepsShape?: "wrapped" | "payload" | "array";
  // Pro builds before .168 embed the whole card under conversation.kanban_task; .168+ embed only
  // `{id}` and serve the card from GET /kanban/tasks/:id.
  embedded?: "full" | "reference";
  taskReads?: number[];
  taskRead?: () => Promise<unknown>;
}): ChatwootClient {
  return {
    kanbanTaskForConversation: async () => {
      if (opts.taskId == null) return null;
      return opts.embedded === "reference"
        ? { id: opts.taskId }
        : fullCard(opts.taskId);
    },
    getKanbanTask: async (id: number) => {
      opts.taskReads?.push(id);
      return opts.taskRead ? opts.taskRead() : fullCard(id);
    },
    listKanbanSteps: async () => {
      if (opts.stepsCalls) opts.stepsCalls.n++;
      const shape = opts.stepsShape ?? "wrapped";
      if (shape === "array") return STEPS;
      if (shape === "payload") return { payload: STEPS };
      return { steps: STEPS };
    },
  } as unknown as ChatwootClient;
}

describe("loadKanbanContext", () => {
  test("resolves the card's board + current step + available steps", async () => {
    const k = await loadKanbanContext(fakeClient({ taskId: 11 }), 7, "1:2");
    expect(k).not.toBeNull();
    expect(k?.taskId).toBe(11);
    expect(k?.boardName).toBe("Vendas SDR");
    expect(k?.currentStepId).toBe(8);
    expect(k?.currentStepName).toBe("Qualificando");
    expect(k?.steps.map((s) => s.name)).toEqual([
      "Novo Lead",
      "Qualificando",
      "Proposta Enviada",
      "Perdido",
    ]);
  });

  test("captures step description + cancelled flag", async () => {
    const k = await loadKanbanContext(fakeClient({ taskId: 11 }), 7, "1:2");
    expect(k?.steps[0]?.description).toBe("Lead recém-chegado");
    expect(k?.steps[1]?.description).toBeUndefined();
    expect(k?.steps[3]?.cancelled).toBe(true);
    expect(k?.steps[0]?.cancelled).toBeUndefined();
  });

  test("captures the card snapshot (title/value/priority/status/attributes)", async () => {
    const k = await loadKanbanContext(fakeClient({ taskId: 11 }), 7, "1:2");
    expect(k?.card.title).toBe("João - Plano Pro");
    expect(k?.card.value).toBe(1500);
    expect(k?.card.priority).toBe("high");
    expect(k?.card.status).toBe("open");
    expect(k?.card.attributes.orcamento).toBe(2000);
    expect(k?.card.attributes.produto).toBe("Plano Pro");
    expect(k?.card.labels).toEqual(["vip", "quente"]);
  });

  test("captures the card's description + scheduled dates", async () => {
    const k = await loadKanbanContext(fakeClient({ taskId: 11 }), 7, "1:2");
    expect(k?.card.description).toBe("Cliente quer fechar até o fim do mês");
    expect(k?.card.startDate).toBe("2026-06-10T09:00:00-03:00");
    expect(k?.card.dueDate).toBe("2026-06-30T18:00:00-03:00");
  });

  test("parses steps under wrapped / payload / bare-array shapes", async () => {
    for (const stepsShape of ["wrapped", "payload", "array"] as const) {
      __resetKanbanStepsCache();
      const k = await loadKanbanContext(
        fakeClient({ taskId: 11, stepsShape }),
        7,
        "1:2",
      );
      expect(k?.steps.map((s) => s.id)).toEqual([7, 8, 9, 10]);
    }
  });

  test("reads the card from the task endpoint when the conversation carries only its id", async () => {
    const taskReads: number[] = [];
    const k = await loadKanbanContext(
      fakeClient({ taskId: 11, embedded: "reference", taskReads }),
      7,
      "1:2",
    );
    expect(taskReads).toEqual([11]);
    expect(k?.taskId).toBe(11);
    expect(k?.boardId).toBe(2);
    expect(k?.boardName).toBe("Vendas SDR");
    expect(k?.currentStepName).toBe("Qualificando");
    expect(k?.steps.map((s) => s.id)).toEqual([7, 8, 9, 10]);
    expect(k?.card.title).toBe("João - Plano Pro");
    expect(k?.card.labels).toEqual(["vip", "quente"]);
  });

  test("gives the same context for both payload shapes, reading the task only when needed", async () => {
    const taskReads: number[] = [];
    const full = await loadKanbanContext(
      fakeClient({ taskId: 11, embedded: "full", taskReads }),
      7,
      "1:2",
    );
    expect(taskReads).toEqual([]);
    __resetKanbanStepsCache();
    const ref = await loadKanbanContext(
      fakeClient({ taskId: 11, embedded: "reference" }),
      7,
      "1:2",
    );
    expect(ref).toEqual(full);
  });

  test("a refused task read fails the load instead of an empty funnel", async () => {
    const refused = new Error("403");
    await expect(
      loadKanbanContext(
        fakeClient({
          taskId: 11,
          embedded: "reference",
          taskRead: () => Promise.reject(refused),
        }),
        7,
        "1:2",
      ),
    ).rejects.toBe(refused);
  });

  test("returns null when the conversation has no linked card", async () => {
    expect(
      await loadKanbanContext(fakeClient({ taskId: null }), 7, "1:2"),
    ).toBeNull();
  });

  test("caches the board's steps per board (TTL)", async () => {
    const stepsCalls = { n: 0 };
    const client = fakeClient({ taskId: 11, stepsCalls });
    await loadKanbanContext(client, 7, "1:2", 1_000);
    await loadKanbanContext(client, 7, "1:2", 1_000 + 30_000);
    expect(stepsCalls.n).toBe(1); // second resolve reused the cached steps
  });
});

describe("matchKanbanStep", () => {
  test("matches a step name case-insensitively", () => {
    const steps = [
      { id: 7, name: "Novo Lead" },
      { id: 9, name: "Proposta Enviada" },
    ];
    expect(matchKanbanStep(steps, "novo lead")?.id).toBe(7);
    expect(matchKanbanStep(steps, "Proposta Enviada")?.id).toBe(9);
    expect(matchKanbanStep(steps, "inexistente")).toBeNull();
  });
});
