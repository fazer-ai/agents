import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/client/lib/utils";

// Renders agent replies as sanitized Markdown (GFM). No raw HTML is allowed (we don't add
// rehype-raw), so any HTML in the text is escaped — safe against injection and consistent with the
// app CSP (markdown becomes DOM, never an inline script). Element styling uses theme tokens, not a
// hardcoded `prose` palette, so it follows light/dark like everything else.
//
// `rehypePlugins` is optional and off by default; the prompt preview passes one that wraps resolved
// variable values in <span class="prompt-var"> so the dynamic text is colored (see promptPreview.ts).
// Without it, no spans are produced and the `span` renderer below is never invoked.
export function isConsoleLink(href: string | undefined): boolean {
  if (!href || typeof window === "undefined") return false;
  return href.startsWith(`${window.location.origin}/`);
}

export function Markdown({
  children,
  className,
  rehypePlugins,
  tone = "default",
}: {
  children: string;
  className?: string;
  rehypePlugins?: ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
  // "onAccent" recolors the palette for a bubble on the accent background (the conversation view's
  // outgoing messages): text + links become accent-foreground, code/quote get a translucent overlay,
  // so links stay legible instead of vanishing into the accent fill.
  tone?: "default" | "onAccent";
}) {
  const onAccent = tone === "onAccent";
  return (
    <div
      className={cn(
        "flex flex-col gap-2 break-words text-sm",
        onAccent ? "text-accent-foreground" : "text-text-primary",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={{
          span: ({ className: spanClass, children }) =>
            spanClass === "prompt-var" ? (
              <span className="rounded bg-accent-soft px-0.5 text-accent">
                {children}
              </span>
            ) : (
              <span className={spanClass}>{children}</span>
            ),
          p: ({ children }) => (
            <p className="whitespace-pre-wrap">{children}</p>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              // A link into the console itself (the approval link a note ends on) opens in place;
              // anything else opens in a new tab.
              {...(isConsoleLink(href)
                ? {}
                : { target: "_blank", rel: "noopener noreferrer" })}
              className={cn(
                "underline underline-offset-2",
                onAccent ? "text-accent-foreground" : "text-accent",
              )}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="flex list-disc flex-col gap-1 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="flex list-decimal flex-col gap-1 pl-5">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          h1: ({ children }) => (
            <h1 className="font-semibold text-base">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="font-semibold text-sm">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="font-semibold text-sm">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className={cn(
                "border-l-2 pl-3",
                onAccent
                  ? "border-accent-foreground/40 text-accent-foreground/90"
                  : "border-border text-text-secondary",
              )}
            >
              {children}
            </blockquote>
          ),
          code: ({ className: codeClass, children }) => {
            const inline = !codeClass;
            return inline ? (
              <code
                className={cn(
                  "rounded px-1 py-0.5 font-mono text-xs",
                  onAccent ? "bg-accent-foreground/15" : "bg-bg-tertiary",
                )}
              >
                {children}
              </code>
            ) : (
              <code className="font-mono text-xs">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre
              className={cn(
                "overflow-x-auto rounded-md p-2 text-xs",
                onAccent ? "bg-accent-foreground/10" : "bg-bg-tertiary",
              )}
            >
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1">{children}</td>
          ),
          hr: () => <hr className="border-border" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
