import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, Skeleton } from "@/client/components";
import { api } from "@/client/lib/api";
import { formatRelativeTime } from "@/client/lib/utils";
import { THEMES_LIMIT_RANGE } from "@/modules/occurrences/settings";
import { OccurrencePager } from "./OccurrencePager";

type Theme = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.themes.get>>["data"]
>["themes"][number];
type ThemeDetail = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.occurrences.themes>["get"]>
  >["data"]
>["theme"];

// Themes shown per page.
export const THEMES_PAGE = 20;

// The monitor's open themes, flagged first, a page at a time. The list is read once and paged here,
// so a round that reorders the themes while the operator pages never repeats or skips one; Refresh
// reads it again. Opening one shows its conversations, each with the sentence its customer's
// conversation produced, verbatim, and a link to it in Chatwoot.
// Two names that differ only in case, accents or spacing say the same thing.
function sameWords(a: string, b: string): boolean {
  const norm = (x: string) =>
    x
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

export function OccurrenceThemes({ active = true }: { active?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const [themes, setThemes] = useState<Theme[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  // Keyed by the theme it answers for, so a slow answer for a theme closed since never shows under
  // another one; `seq` drops every answer but the latest request's.
  const [detail, setDetail] = useState<
    { id: string; theme: ThemeDetail } | { id: string; failed: true } | null
  >(null);
  const seq = useRef(0);
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(i18n.language, {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "";
  const flagLabel = (f: string) =>
    f === "new"
      ? t("occurrences.flagNew", "new")
      : f === "above_usual"
        ? t("occurrences.flagAboveUsual", "above its usual")
        : f === "concentrated"
          ? t(
              "occurrences.flagConcentratedReference",
              "concentrated on one reference",
            )
          : f;

  const load = useCallback(async () => {
    setFailed(false);
    const res = await api.api.v1.occurrences.themes.get({
      query: { limit: THEMES_LIMIT_RANGE.max },
    });
    if (res.error || !res.data) {
      setFailed(true);
      return;
    }
    const list = res.data.themes;
    setThemes(list);
    setTotal(res.data.total);
    setReadAt(new Date());
    // The page stays where it was while it still has themes.
    setPage((p) =>
      Math.min(p, Math.max(0, Math.ceil(list.length / THEMES_PAGE) - 1)),
    );
  }, []);

  // Read again each time the tab is opened, so the themes a round just placed are there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening the tab is the trigger; refresh reads the open theme too.
  useEffect(() => {
    if (active) void refresh();
  }, [active]);

  // Refresh reads the expanded theme's conversations too, so its evidence never lags its totals.
  async function refresh() {
    await Promise.all([load(), ...(open === null ? [] : [loadDetail(open)])]);
  }

  async function toggle(id: string) {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    await loadDetail(id);
  }

  async function loadDetail(id: string) {
    const mine = ++seq.current;
    setDetail(null);
    const res = await api.api.v1.occurrences.themes({ id }).get();
    if (mine !== seq.current) return;
    setDetail(
      !res.error && res.data
        ? { id, theme: res.data.theme }
        : { id, failed: true },
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-text-primary">
            {t("occurrences.themes", "Open themes")}
          </h2>
          <p className="text-text-muted text-xs">
            {t(
              "occurrences.themesIntro",
              "Flagged first, then the most recently seen. {{size}} per page.",
              { size: THEMES_PAGE },
            )}
            {readAt &&
              ` ${t("occurrences.themesReadAt", "Read at {{time}}.", {
                time: readAt.toLocaleTimeString(i18n.language, {
                  timeStyle: "short",
                }),
              })}`}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={refresh}>
          {t("common.refresh", "Refresh")}
        </Button>
      </div>
      {failed ? (
        <p className="text-sm text-text-muted">
          {t("occurrences.themesError", "Could not read the themes.")}
        </p>
      ) : themes === null ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : themes.length === 0 ? (
        <p className="text-sm text-text-muted">
          {t("occurrences.themesEmpty", "No open theme yet.")}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {themes
            .slice(page * THEMES_PAGE, (page + 1) * THEMES_PAGE)
            .map((th) => (
              <li key={th.id} className="py-2">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 text-left"
                  aria-expanded={open === th.id}
                  onClick={() => toggle(th.id)}
                >
                  {open === th.id ? (
                    <ChevronDown
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                  ) : (
                    <ChevronRight
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-medium text-sm text-text-primary">
                      {th.title}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-text-muted text-xs">
                      <span>
                        {t(
                          "occurrences.themeConversationCount",
                          "{{count}} conversations",
                          { count: th.conversations },
                        )}
                      </span>
                      {/* The main reference, named, and only when it says more than the title. */}
                      {th.reference && !sameWords(th.reference, th.title) && (
                        <span>
                          {t(
                            "occurrences.themeReference",
                            "Reference: {{reference}}",
                            { reference: th.reference },
                          )}
                        </span>
                      )}
                      {th.lastSeenAt && (
                        <time dateTime={th.lastSeenAt}>
                          {t(
                            "occurrences.themeLastSeen",
                            "last seen {{when}}",
                            {
                              when: formatRelativeTime(
                                th.lastSeenAt,
                                i18n.language,
                              ),
                            },
                          )}
                        </time>
                      )}
                      {th.flags.map((f) => (
                        <Badge key={f} variant="warning">
                          {flagLabel(f)}
                        </Badge>
                      ))}
                    </span>
                  </span>
                </button>
                {open === th.id && (
                  <div className="mt-2 ml-6 flex flex-col gap-1">
                    {/* The exact times, where touch and keyboard reach them: the row says them
                        relatively. */}
                    {th.lastSeenAt && (
                      <p className="text-text-muted text-xs">
                        {th.firstSeenAt === th.lastSeenAt
                          ? t("occurrences.themeSeenAt", "Seen at {{when}}.", {
                              when: when(th.lastSeenAt),
                            })
                          : t(
                              "occurrences.themeSeenRange",
                              "Seen from {{first}} to {{last}}.",
                              {
                                first: when(th.firstSeenAt),
                                last: when(th.lastSeenAt),
                              },
                            )}
                      </p>
                    )}
                    {detail === null || detail.id !== th.id ? (
                      <Skeleton className="h-6 w-full" />
                    ) : "failed" in detail ? (
                      <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                        <span role="alert">
                          {t(
                            "occurrences.themeDetailError",
                            "Could not read this theme's conversations.",
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => loadDetail(th.id)}
                        >
                          {t("common.retry", "Retry")}
                        </Button>
                      </div>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {detail.theme.conversationsShown.map((c) => (
                          <li
                            key={c.conversationId}
                            className="flex flex-wrap items-baseline gap-2 text-sm"
                          >
                            <a
                              href={c.url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-accent"
                            >
                              {`#${c.chatwootConversationId}`}
                              <ExternalLink
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            </a>
                            <span className="text-text-primary">
                              {c.sentence}
                            </span>
                            {c.reference && (
                              <span className="text-text-muted text-xs">
                                {c.reference}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
      {themes !== null && themes.length > 0 && (
        <>
          <OccurrencePager
            label={t("occurrences.themesPages", "Theme pages")}
            first={page * THEMES_PAGE + 1}
            shown={Math.min(THEMES_PAGE, themes.length - page * THEMES_PAGE)}
            total={themes.length}
            onPrevious={page > 0 ? () => setPage((p) => p - 1) : null}
            onNext={() => setPage((p) => p + 1)}
            hasNext={(page + 1) * THEMES_PAGE < themes.length}
          />
          {total > themes.length && (
            <p className="text-text-muted text-xs">
              {t(
                "occurrences.themesTruncated",
                "Showing the first {{shown}} of {{total}} open themes.",
                { shown: themes.length, total },
              )}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
