import { AlertTriangle, Loader2, Send } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { Button, Logo, Markdown, Textarea } from "@/client/components";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";

interface ChatTurn {
  role: "user" | "assistant" | "error";
  text: string;
}

type PageState = "loading" | "invalid" | "exhausted" | "ready";

function threadStorageKey(token: string) {
  return `@app:playground-share-thread:${token}`;
}

// Public, no-login page for an operator-minted playground share link: a customer opens this URL to
// chat with an agent, with no Chatwoot side effects. No auth, no trace/tool details — just the reply.
// biome-ignore lint/plugin/require-page-container: public page renders its own centered layout outside <Layout>, so <PageContainer> does not apply
export function PlaygroundSharePage() {
  const { t } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<PageState>("loading");
  const [agentName, setAgentName] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const threadId = useRef<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    threadId.current =
      sessionStorage.getItem(threadStorageKey(token)) ?? undefined;
    let active = true;
    api.api.v1.playground
      .share({ token })
      .get()
      .then(({ data, error }) => {
        if (!active) return;
        if (error || !data) {
          setState(error?.status === 429 ? "exhausted" : "invalid");
          return;
        }
        setAgentName(data.agentName);
        setState("ready");
      });
    return () => {
      active = false;
    };
  }, [token]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every turn added
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    setTurns((prev) => [...prev, { role: "user", text }]);
    const { data, error } = await api.api.v1.playground
      .share({ token })
      .message.post({ message: text, threadId: threadId.current });
    setSending(false);
    if (error || !data) {
      if (error?.status === 429) setState("exhausted");
      setTurns((prev) => [
        ...prev,
        {
          role: "error",
          text: t(
            "playgroundShare.sendError",
            "Something went wrong. Please try again.",
          ),
        },
      ]);
      return;
    }
    threadId.current = data.threadId;
    sessionStorage.setItem(threadStorageKey(token), data.threadId);
    setTurns((prev) => [...prev, { role: "assistant", text: data.reply }]);
  }

  return (
    <div className="flex min-h-screen flex-col items-center bg-bg-primary px-4 py-8">
      <div className="flex w-full max-w-2xl flex-1 flex-col">
        <div className="mb-6 flex items-center justify-center">
          <Logo className="h-8" />
        </div>

        {state === "loading" && (
          <div className="flex flex-1 items-center justify-center py-24">
            <Loader2
              className="h-6 w-6 animate-spin text-text-muted"
              aria-hidden="true"
            />
          </div>
        )}

        {(state === "invalid" || state === "exhausted") && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-bg-secondary px-6 py-16 text-center">
            <AlertTriangle
              className="h-6 w-6 text-text-muted"
              aria-hidden="true"
            />
            <p className="text-sm text-text-primary">
              {state === "exhausted"
                ? t(
                    "playgroundShare.exhausted",
                    "This chat link has reached its message limit.",
                  )
                : t(
                    "playgroundShare.invalid",
                    "This chat link is invalid or has expired.",
                  )}
            </p>
          </div>
        )}

        {state === "ready" && (
          <>
            <p className="mb-4 text-center text-sm text-text-muted">
              {t("playgroundShare.chattingWith", "Chatting with {{name}}", {
                name: agentName,
              })}
            </p>
            <div
              ref={scrollRef}
              className="flex flex-1 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-4"
              style={{ minHeight: "50vh" }}
            >
              {turns.length === 0 && (
                <p className="self-center px-2 py-8 text-center text-sm text-text-muted">
                  {t("playgroundShare.empty", "Send a message to start.")}
                </p>
              )}
              {turns.map((turn, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: append-only local transcript, never reordered
                  key={i}
                  className={cn(
                    "flex max-w-[85%] flex-col gap-1",
                    turn.role === "user" ? "items-end self-end" : "self-start",
                  )}
                >
                  <div
                    className={cn("rounded-lg px-3 py-2 text-sm", {
                      "bg-accent text-accent-foreground": turn.role === "user",
                      "bg-bg-tertiary text-text-primary":
                        turn.role === "assistant",
                      "border border-error/40 bg-error/10 text-error":
                        turn.role === "error",
                    })}
                  >
                    {turn.role === "assistant" ? (
                      <Markdown>{turn.text}</Markdown>
                    ) : (
                      <span className="whitespace-pre-wrap">{turn.text}</span>
                    )}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="self-start rounded-lg bg-bg-tertiary px-3 py-2">
                  <Loader2
                    className="h-4 w-4 animate-spin text-text-muted"
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>
            <form onSubmit={handleSubmit} className="mt-3 flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder={t(
                  "playgroundShare.inputPlaceholder",
                  "Type a message…",
                )}
                rows={1}
                className="flex-1 resize-none"
              />
              <Button type="submit" disabled={sending || !input.trim()}>
                <Send className="h-4 w-4" aria-hidden="true" />
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
