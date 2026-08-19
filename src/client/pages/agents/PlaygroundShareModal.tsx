import { Check, Copy, Link2, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  FormField,
  Input,
  Modal,
  type ModalController,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDate } from "@/client/lib/utils";

// Derived from the treaty response; never hand-mirrored (see docs/eden-treaty.md).
type ShareLinksData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.agents>["playground"]["share"]["get"]>
>["data"];
type ShareLink = NonNullable<ShareLinksData>["links"][number];

const DEFAULT_TTL_HOURS = 48;
const DEFAULT_MAX_MESSAGES = 60;

// Operator-facing manager for public, no-login playground share links: lists existing links,
// mints a new one (reveals the URL once — only the token hash is stored server-side), and revokes.
export function PlaygroundShareModal({
  modal,
  agentId,
}: {
  modal: ModalController;
  agentId: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const confirm = useModalController<ConfirmPayload>();
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [ttlHours, setTtlHours] = useState(String(DEFAULT_TTL_HOURS));
  const [maxMessages, setMaxMessages] = useState(String(DEFAULT_MAX_MESSAGES));
  const [minting, setMinting] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchLinks = useCallback(async () => {
    setLoading(true);
    const { data } = await api.api.v1
      .agents({ id: agentId })
      .playground.share.get();
    setLinks(data?.links ?? []);
    setLoading(false);
  }, [agentId]);

  useOnModalOpen(modal, () => {
    setMintedUrl(null);
    setCopied(false);
    setTtlHours(String(DEFAULT_TTL_HOURS));
    setMaxMessages(String(DEFAULT_MAX_MESSAGES));
    void fetchLinks();
  });

  const mint = async () => {
    setMinting(true);
    setCopied(false);
    try {
      const { data, error } = await api.api.v1
        .agents({ id: agentId })
        .playground.share.post({
          ttlHours: Number(ttlHours) || undefined,
          maxMessages: Number(maxMessages) || undefined,
        });
      if (error || !data) {
        showToast(
          t("playground.share.createFailed", "Could not create the link"),
          "error",
        );
        return;
      }
      setMintedUrl(data.url);
      void fetchLinks();
    } finally {
      setMinting(false);
    }
  };

  const copyUrl = async () => {
    if (!mintedUrl) return;
    try {
      await navigator.clipboard.writeText(mintedUrl);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the URL stays selectable.
    }
  };

  const requestRevoke = (link: ShareLink) => {
    confirm.open({
      title: t("playground.share.revokeTitle", "Revoke share link"),
      message: t(
        "playground.share.revokeMessage",
        "The link will stop working immediately. This cannot be undone.",
      ),
      confirmLabel: t("playground.share.revoke", "Revoke"),
      danger: true,
      onConfirm: async () => {
        const { error } = await api.api.v1
          .agents({ id: agentId })
          .playground.share({ linkId: link.id })
          .delete();
        if (error) {
          showToast(
            t("playground.share.revokeFailed", "Could not revoke the link"),
            "error",
          );
          throw new Error("revoke failed");
        }
        void fetchLinks();
      },
    });
  };

  const isActive = (link: ShareLink) =>
    !link.revokedAt && new Date(link.expiresAt).getTime() > Date.now();

  return (
    <Modal
      modal={modal}
      title={t("playground.share.title", "Share this agent")}
      size="md"
    >
      <div className="space-y-5">
        <p className="text-text-secondary text-xs">
          {t(
            "playground.share.hint",
            "Create a public link so a customer can chat with this agent, no login required. It expires and stops accepting messages after its quota.",
          )}
        </p>

        {mintedUrl ? (
          <div className="space-y-3 rounded-lg border border-warning bg-warning-soft px-3 py-2">
            <p className="text-text-primary text-xs">
              {t(
                "playground.share.urlWarning",
                "Copy this link now. It is shown only once here.",
              )}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-text-primary text-xs">
                {mintedUrl}
              </code>
              <Button size="sm" variant="secondary" onClick={copyUrl}>
                {copied ? (
                  <Check className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden="true" />
                )}
                {copied
                  ? t("common.copied", "Copied")
                  : t("common.copy", "Copy")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <FormField label={t("playground.share.ttl", "Expires in (hours)")}>
              <Input
                type="number"
                min={1}
                max={48}
                value={ttlHours}
                onChange={(e) => setTtlHours(e.target.value)}
                className="w-28"
              />
            </FormField>
            <FormField
              label={t("playground.share.maxMessages", "Message limit")}
            >
              <Input
                type="number"
                min={1}
                max={500}
                value={maxMessages}
                onChange={(e) => setMaxMessages(e.target.value)}
                className="w-28"
              />
            </FormField>
            <Button onClick={() => void mint()} loading={minting}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("playground.share.create", "Create link")}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="font-medium text-text-secondary text-xs uppercase tracking-wide">
            {t("playground.share.existing", "Existing links")}
          </h3>
          {loading ? (
            <p className="text-text-muted text-xs">
              {t("common.loading", "Loading…")}
            </p>
          ) : links.length === 0 ? (
            <p className="text-text-muted text-xs">
              {t("playground.share.empty", "No share links yet.")}
            </p>
          ) : (
            <ul className="space-y-2">
              {links.map((link) => {
                const active = isActive(link);
                return (
                  <li
                    key={link.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-xs"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-text-primary">
                        <Link2
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        {active
                          ? t(
                              "playground.share.statusActive",
                              "Active until {{date}}",
                              { date: formatDate(link.expiresAt) },
                            )
                          : link.revokedAt
                            ? t("playground.share.statusRevoked", "Revoked")
                            : t("playground.share.statusExpired", "Expired")}
                      </span>
                      <span className="text-text-muted">
                        {t(
                          "playground.share.messageCount",
                          "{{used}}/{{max}} messages",
                          { used: link.messageCount, max: link.maxMessages },
                        )}
                      </span>
                    </div>
                    {active && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => requestRevoke(link)}
                        aria-label={t(
                          "playground.share.revokeAria",
                          "Revoke share link",
                        )}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
        </div>
      </div>

      <ConfirmDialog modal={confirm} />
    </Modal>
  );
}
