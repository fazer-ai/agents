import { AppWindow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState, ProGate } from "@/client/components";

// The client channel in the Free edition: the agent's channels say the feature exists, with an
// upgrade gate in place of the embedding applications.
export function ClientAppsSection(_props: { agentId: string }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-text-primary text-sm font-medium">
          {t("clientApps.title", "Embedding applications")}
        </h3>
        <p className="text-text-secondary text-xs">
          {t(
            "clientApps.subtitle",
            "Web applications that put this agent on their own pages. Each one signs its users in with a key of its own.",
          )}
        </p>
      </div>
      <EmptyState
        icon={AppWindow}
        title={t("clientApps.proTitle", "Embedding the agent is a Pro feature")}
        description={t(
          "upgrade.clientChannel.description",
          "Put this agent on your own web application with a script tag: it answers your signed-in users, guides them through your pages and can run the tools your app declares. Upgrade to Pro to embed it.",
        )}
        action={<ProGate feature="clientChannel" size="md" />}
      />
    </section>
  );
}
