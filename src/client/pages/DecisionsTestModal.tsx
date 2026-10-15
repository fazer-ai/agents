import { FlaskConical } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ComboBox,
  type ComboItem,
  Modal,
  useModalController,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { DecisionTickMarker } from "./DecisionTickMarker";
import type { DecisionTickView } from "./decisionTick";

// "Test an agent here" on the conversation page (docs/decisions.md, "Testing an agent on a
// conversation"): one "Questions and rules" observer runs its saved questions and rules once on this
// conversation and nothing acts. The result is the decision marker the timeline draws for a real
// tick, marked as a test, and it lives only in this modal.

const PAGE_SIZE = 100;

// The agents a test can run: the ones that observe with questions and rules. The list route pages at
// 100, so this walks the pages; a tenant with more agents than that is rare, and the walk is bounded.
async function decisionsAgents(): Promise<ComboItem[]> {
  const out: ComboItem[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await api.api.v1.agents.get({
      query: { page, pageSize: PAGE_SIZE, orderBy: "name", order: "asc" },
    });
    if (error || !data) throw error ?? new Error("agents");
    for (const a of data.agents) {
      const engine = (
        a.settings as { monitoring?: { engine?: unknown } } | null
      )?.monitoring?.engine;
      if (a.mode === "monitoring" && engine === "decisions") {
        out.push({ id: String(a.id), label: a.name, hint: "" });
      }
    }
    if (page * PAGE_SIZE >= data.total) break;
  }
  return out;
}

export function DecisionsTestButton({
  conversationId,
  observerIds,
}: {
  conversationId: string;
  // The agents observing this conversation's inbox: the one to test is usually one of them, so it
  // comes picked.
  observerIds: readonly string[];
}) {
  const { t } = useTranslation();
  const [agentId, setAgentId] = useState("");
  const [agents, setAgents] = useState<ComboItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState<DecisionTickView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setAgents(null);
    try {
      const items = await decisionsAgents();
      setAgents(items);
      const pick =
        items.find((a) => observerIds.includes(a.id)) ??
        (items.length === 1 ? items[0] : undefined);
      setAgentId((cur) =>
        cur && items.some((a) => a.id === cur) ? cur : (pick?.id ?? ""),
      );
    } catch (e) {
      setAgents([]);
      setError(
        apiErrorMessage(e) ??
          t(
            "conversation.decisionsTest.loadFailed",
            "Could not list the agents.",
          ),
      );
    }
  }, [observerIds, t]);

  const modal = useModalController({
    onOpen: () => {
      setTick(null);
      setError(null);
      void load();
    },
  });

  const run = async () => {
    if (!agentId) return;
    setRunning(true);
    setError(null);
    setTick(null);
    try {
      const { data, error: err } = await api.api.v1
        .conversations({ id: conversationId })
        ["decisions-test"].post({ agentId });
      if (err || !data) {
        setError(
          apiErrorMessage(err) ??
            t("conversation.decisionsTest.failed", "The test did not run."),
        );
        return;
      }
      setTick(data.tick as DecisionTickView);
    } catch (e) {
      setError(
        apiErrorMessage(e) ??
          t("conversation.decisionsTest.failed", "The test did not run."),
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => modal.open()}>
        <FlaskConical className="h-4 w-4" aria-hidden="true" />
        {t("conversation.decisionsTest.open", "Test an agent")}
      </Button>
      <Modal
        modal={modal}
        size="xl"
        busy={running}
        title={t(
          "conversation.decisionsTest.title",
          "Test an agent on this conversation",
        )}
        description={t(
          "conversation.decisionsTest.description",
          "Runs the agent's saved questions and rules once on this conversation. Nothing is executed. It is one paid classification, counted as a test.",
        )}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => modal.close()}
              disabled={running}
            >
              {t("common.close", "Close")}
            </Button>
            <Button onClick={run} loading={running} disabled={!agentId}>
              {tick
                ? t("conversation.decisionsTest.again", "Test again")
                : t("conversation.decisionsTest.run", "Test")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {agents !== null && agents.length === 0 && !error ? (
            <p className="text-sm text-text-secondary">
              {t(
                "conversation.decisionsTest.none",
                "No agent observes with questions and rules yet. Pick Questions and rules as the engine of a monitoring agent to test it here.",
              )}
            </p>
          ) : (
            <ComboBox
              value={agentId}
              onChange={(v) => {
                setAgentId(v);
                setTick(null);
                setError(null);
              }}
              items={agents ?? []}
              allowCustom={false}
              disabled={agents === null || running}
              placeholder={
                agents === null
                  ? t("common.loading", "Loading…")
                  : t(
                      "conversation.decisionsTest.pick",
                      "Agent with questions and rules",
                    )
              }
              searchPlaceholder={t(
                "conversation.decisionsTest.search",
                "Search agents",
              )}
              aria-label={t("conversation.decisionsTest.agent", "Agent")}
            />
          )}
          {error && (
            <p role="alert" className="text-error text-sm">
              {error}
            </p>
          )}
          {tick && (
            <DecisionTickMarker
              entry={{ decision: tick, durationMs: null }}
              test
            />
          )}
        </div>
      </Modal>
    </>
  );
}
