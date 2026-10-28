import { Check, Copy, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components";
import { AntigravityIcon } from "@/client/components/icons/AntigravityIcon";
import { ClaudeIcon } from "@/client/components/icons/ClaudeIcon";
import { CodexIcon } from "@/client/components/icons/CodexIcon";
import { CopilotIcon } from "@/client/components/icons/CopilotIcon";
import { CursorIcon } from "@/client/components/icons/CursorIcon";
import { HermesIcon } from "@/client/components/icons/HermesIcon";
import { cn } from "@/client/lib/utils";

// MCP server id shown in the client config; arbitrary, surfaces as the tool namespace prefix.
const SERVER_ID = "fazer-ai";

// Where a snippet goes: a shell command ("terminal") or a literal config-file path.
type Snippet = { location: string; code: string };

// Builds the per-client install snippet from the live MCP endpoint URL. Auth is OAuth-only: the
// client discovers the login from the endpoint, so no secret is ever embedded in the command.
function buildSnippet(clientId: string, url: string): Snippet {
  switch (clientId) {
    case "claude":
      return {
        location: "terminal",
        code: `claude mcp add --transport http ${SERVER_ID} ${url}`,
      };
    case "codex":
      return {
        location: "terminal",
        code: `codex mcp add ${SERVER_ID} --url ${url}`,
      };
    case "cursor":
      return {
        location: "~/.cursor/mcp.json",
        code: JSON.stringify({ mcpServers: { [SERVER_ID]: { url } } }, null, 2),
      };
    case "hermes":
      return {
        location: "~/.hermes/config.yaml",
        code: `mcp_servers:\n  ${SERVER_ID}:\n    url: "${url}"\n    auth: oauth`,
      };
    case "copilot":
      return {
        location: "terminal",
        code: `copilot mcp add --transport http ${SERVER_ID} ${url}`,
      };
    case "antigravity":
      return {
        location: "~/.gemini/config/mcp_config.json",
        code: JSON.stringify(
          { mcpServers: { [SERVER_ID]: { serverUrl: url } } },
          null,
          2,
        ),
      };
    default:
      return {
        location: "mcp.json",
        code: JSON.stringify({ mcpServers: { [SERVER_ID]: { url } } }, null, 2),
      };
  }
}

// Brand mark per client; the generic "Other" tile and Hermes (no public brand mark) fall back to
// neutral lucide glyphs. Sizing/color come from the className the tile passes in.
function ClientTileIcon({ id, className }: { id: string; className: string }) {
  switch (id) {
    case "claude":
      return <ClaudeIcon className={className} aria-hidden="true" />;
    case "codex":
      return <CodexIcon className={className} aria-hidden="true" />;
    case "cursor":
      return <CursorIcon className={className} aria-hidden="true" />;
    case "copilot":
      return <CopilotIcon className={className} aria-hidden="true" />;
    case "antigravity":
      return <AntigravityIcon className={className} aria-hidden="true" />;
    case "hermes":
      return <HermesIcon className={className} aria-hidden="true" />;
    default:
      return <MoreHorizontal className={className} aria-hidden="true" />;
  }
}

// CLI/client selector that turns the MCP endpoint URL into a ready-to-paste install snippet. Pure
// projection over `url` (from /v1/mcp/me/info); no backend call, no secret. Used in McpPage's
// "How to connect" section. Tiles are opacity-selected (active = full, idle = dimmed) like the hub.
export function McpInstall({ url }: { url: string }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState("claude");
  const [copied, setCopied] = useState(false);

  // Proper nouns stay literal; only the generic "Other" tile is translated. Built here so the tile
  // labels live in expressions (noJsxLiterals only flags bare JSX text children, not expressions).
  const clients: { id: string; label: string }[] = [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "cursor", label: "Cursor" },
    { id: "hermes", label: "Hermes" },
    { id: "copilot", label: "GitHub Copilot" },
    { id: "antigravity", label: "Antigravity" },
    { id: "other", label: t("mcp.my.installOther", "Other") },
  ];

  const snippet = buildSnippet(selected, url);
  const locationLabel =
    snippet.location === "terminal"
      ? t("mcp.my.installRunInTerminal", "Run in your terminal")
      : t("mcp.my.installAddToFile", "Add to {{file}}", {
          file: snippet.location,
        });

  // Static t() per client (no dynamic key) so i18n:extract keeps them and the lint plugin is happy.
  let postNote: string | null = null;
  if (selected === "claude") {
    postNote = t(
      "mcp.my.installClaudePost",
      "Then run /mcp inside Claude Code to sign in.",
    );
  } else if (selected === "codex") {
    postNote = t(
      "mcp.my.installCodexPost",
      "Then run codex mcp login fazer-ai to sign in.",
    );
  } else if (selected === "hermes") {
    postNote = t("mcp.my.installHermesPost", "Then run /reload-mcp in Hermes.");
  }

  const select = (id: string) => {
    setSelected(id);
    setCopied(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context); the snippet stays selectable.
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-text-secondary text-sm font-medium">
          {t("mcp.my.installTitle", "Install in your client")}
        </span>
        <p className="text-text-muted text-sm">
          {t(
            "mcp.my.installHint",
            "Pick your tool and copy the snippet. Sign-in happens in your browser via OAuth, with no token to paste.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-center gap-4 sm:gap-6">
        {clients.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => select(c.id)}
            aria-pressed={selected === c.id}
            className={cn(
              "group focus-visible:ring-accent rounded-lg p-2 transition-[transform,opacity] duration-150 ease-out hover:scale-110 focus:outline-none focus-visible:ring-2 motion-reduce:transition-none",
              {
                "opacity-100": selected === c.id,
                "opacity-40 hover:opacity-70": selected !== c.id,
              },
            )}
          >
            <span className="flex flex-col items-center gap-2 transition-transform duration-150 ease-out group-active:scale-95 motion-reduce:transition-none">
              <ClientTileIcon id={c.id} className="text-text-primary h-9 w-9" />
              <span className="text-text-primary text-center text-xs font-medium">
                {c.label}
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-muted text-xs">{locationLabel}</span>
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            {copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
          </Button>
        </div>
        <pre className="border-border bg-bg-tertiary text-text-primary overflow-x-auto rounded-lg border px-3 py-2 font-mono text-xs">
          <code>{snippet.code}</code>
        </pre>
        {postNote && <p className="text-text-muted text-xs">{postNote}</p>}
      </div>
    </div>
  );
}
