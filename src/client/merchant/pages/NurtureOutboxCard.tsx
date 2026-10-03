import { MailCheck, Send, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  DataBoundary,
  EmptyState,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDateTime } from "@/client/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/merchant/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/merchant/components/ui/table";

// The operator's daily queue: PENDING bodies the drain staged. Each is
// delivered BY HAND off-platform - copy the text out, then mark it sent (or
// drop it). The send/cancel calls are CAS transitions server-side, so the
// button is safe to hit from two tabs.

type OutboxData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.nurture.outbox)["get"]>
>["data"];
export type NurtureOutboxItem = NonNullable<OutboxData>["outbox"][number];

// The rail the staged body is meant for, named on the row so the operator
// knows whether to open the lead's DM thread or reply under their post.
const CHANNEL_LABEL = {
  dm: "merchant.nurture.channel.dm",
  reply: "merchant.nurture.channel.reply",
} as const;

export function NurtureOutboxCard({
  items,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  items: NurtureOutboxItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const transition = async (
    item: NurtureOutboxItem,
    action: "send" | "cancel",
  ) => {
    setBusy(item.id);
    try {
      const { error: err } =
        action === "send"
          ? await api.api.v1.merchant.nurture
              .outbox({ id: item.id })
              .send.post({})
          : await api.api.v1.merchant.nurture
              .outbox({ id: item.id })
              .cancel.post({});
      if (err) {
        showToast(
          apiErrorMessage(err) ??
            t("merchant.nurture.outboxFailed", "Could not update the row"),
          "error",
        );
        return;
      }
      if (action === "send") {
        showToast(t("merchant.nurture.markedSent", "Marked sent"), "success");
      }
      onChanged();
    } catch {
      showToast(
        t("merchant.nurture.outboxFailed", "Could not update the row"),
        "error",
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("merchant.nurture.outboxTitle", "Outbox")}</CardTitle>
        <CardDescription>
          {t(
            "merchant.nurture.outboxSubtitle",
            "Staged follow-ups waiting on a human. Copy the body into the platform and mark it sent.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataBoundary
          loading={loading}
          error={error}
          isEmpty={items.length === 0}
          onRetry={onRetry}
          empty={
            <EmptyState
              icon={MailCheck}
              title={t("merchant.nurture.outboxEmpty", "Nothing pending")}
              description={t(
                "merchant.nurture.outboxEmptyDescription",
                "The drain stages the next step here when an enrollment comes due.",
              )}
            />
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{"Lead"}</TableHead>
                <TableHead>
                  {t("merchant.nurture.colSequence", "Sequence")}
                </TableHead>
                <TableHead>{t("merchant.nurture.colBody", "Body")}</TableHead>
                <TableHead>
                  {t("merchant.nurture.colStaged", "Staged")}
                </TableHead>
                <TableHead>
                  {t("merchant.nurture.colActions", "Actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col">
                      <span>{item.leadAuthorName}</span>
                      <span className="text-muted-foreground text-xs capitalize">
                        {item.leadPlatform}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <div className="flex flex-col gap-1">
                      <span>{item.sequenceName}</span>
                      <Badge variant="info">
                        {
                          // t('merchant.nurture.channel.dm', 'Direct message')
                          // t('merchant.nurture.channel.reply', 'Public reply')
                          // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in CHANNEL_LABEL
                          t(CHANNEL_LABEL[item.channel], item.channel)
                        }
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-md">
                    <span className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                      {item.body}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(item.createdAt, i18n.language)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => void transition(item, "send")}
                      >
                        <Send className="h-4 w-4" aria-hidden="true" />
                        {t("merchant.nurture.markSent", "Mark sent")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === item.id}
                        onClick={() => void transition(item, "cancel")}
                        aria-label={t("common.cancel", "Cancel")}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataBoundary>
      </CardContent>
    </Card>
  );
}
