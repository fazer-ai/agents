import { ChevronDown, History, Plus, Trash2 } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Button, Tooltip } from "@/client/components";
import { cn } from "@/client/lib/utils";
import type { PlaygroundCapabilities } from "./PlaygroundChat";
import { PlaygroundChat } from "./PlaygroundChat";
import type { usePlaygroundChat } from "./usePlaygroundChat";

// Floating playground: a FAB that toggles a docked, RESIZABLE + DRAGGABLE chat panel over the editor
// tabs, so the operator can tweak the prompt/model/settings on one tab and test the change live (draft
// override) without leaving. It renders PlaygroundChat over the SAME shared `chat` hook value as the
// Playground tab, so the conversation is one and the same.

const W_KEY = "@app:playground-fab-w";
const H_KEY = "@app:playground-fab-h";
const POS_KEY = "@app:playground-fab-pos";
const DEFAULT_W = 544; // ~34rem
const MIN_W = 320;
const MIN_H = 320;
// Default bottom offset (px): clears the WHOLE sticky save/test action bar (its card is ~64px tall:
// a button row + py-3 + border/shadow) plus the page's bottom padding and a gap, so the panel opens
// ABOVE the bar instead of aligning with the buttons and clipping the bar around them (item 13).
const DEFAULT_BOTTOM = 104;
const DEFAULT_RIGHT = 16;

function clampW(w: number): number {
  return Math.max(MIN_W, Math.min(w, Math.min(window.innerWidth - 32, 760)));
}
function clampH(h: number): number {
  // Leave room for the bottom anchor + a top margin.
  return Math.max(MIN_H, Math.min(h, window.innerHeight - 48));
}
function readStored(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}
function persistSize(w: number, h: number): void {
  try {
    localStorage.setItem(W_KEY, String(w));
    localStorage.setItem(H_KEY, String(h));
  } catch {
    // NOTE: Ignore localStorage errors
  }
}

type Pos = { left: number; top: number };

function readStoredPos(): Pos | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Pos>;
    return typeof p.left === "number" && typeof p.top === "number"
      ? { left: p.left, top: p.top }
      : null;
  } catch {
    return null;
  }
}
function persistPos(p: Pos): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    // NOTE: Ignore localStorage errors
  }
}

// The app header height (px) from the CSS var, so a dragged panel never covers the header.
function headerHeightPx(): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--header-height")
      .trim();
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return raw.endsWith("rem") ? n * 16 : n;
  } catch {
    // fall through to the default
  }
  return 56;
}
// The right edge of the desktop sidebar (px), so a dragged panel stays in the agent page region and
// doesn't overlap the sidebar. 0 when there is no sidebar (mobile / not found).
function sidebarRightPx(): number {
  try {
    const el = document.getElementById("app-sidebar");
    if (el) {
      const r = el.getBoundingClientRect();
      return r.width > 0 ? r.right : 0;
    }
  } catch {
    // fall through
  }
  return 0;
}
// Clamp a free position to the agent page region: below the header, right of the sidebar, inside the
// viewport (keeping the title bar grabbable at the bottom).
function clampPos(left: number, top: number, w: number): Pos {
  const minLeft = Math.max(8, sidebarRightPx() + 8);
  const maxLeft = Math.max(minLeft, window.innerWidth - w - 8);
  const minTop = headerHeightPx() + 8;
  // Keep at least the title bar in view (don't require the whole panel height to fit).
  const maxTop = Math.max(minTop, window.innerHeight - 48);
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}

export function PlaygroundFab({
  chat,
  agentId,
  missingConfig,
  capabilities,
  toolsDirty,
  open,
  onOpenChange,
}: {
  chat: ReturnType<typeof usePlaygroundChat>;
  agentId: string;
  missingConfig: string[];
  capabilities: PlaygroundCapabilities;
  toolsDirty: boolean;
  // Controlled by AgentEditorPage; the open trigger lives in the editor's save bar (TabActionBar),
  // not a floating button. The panel still owns its own close (X) in the header.
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [size, setSize] = useState(() => ({
    w: clampW(readStored(W_KEY, DEFAULT_W)),
    h: clampH(readStored(H_KEY, Math.round(window.innerHeight * 0.78))),
  }));
  // null = the default anchor (bottom-right, above the action bar). A resize or a drag switches to an
  // explicit {left, top} so both interactions share one positioning model.
  const [pos, setPos] = useState<Pos | null>(() => {
    const stored = readStoredPos();
    return stored
      ? clampPos(stored.left, stored.top, clampW(readStored(W_KEY, DEFAULT_W)))
      : null;
  });
  const panelRef = useRef<HTMLDivElement>(null);

  // Resize from the top-left grip: the panel grows up-left, keeping its BOTTOM-RIGHT corner fixed in
  // place (in both the default and the dragged positioning modes).
  const onResizeStart = (e: ReactPointerEvent) => {
    e.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    const fixedRight = rect ? rect.right : null;
    const fixedBottom = rect ? rect.bottom : null;
    const start = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
    let latest = size;
    let latestPos = pos;
    const move = (ev: PointerEvent) => {
      const w = clampW(start.w + (start.x - ev.clientX));
      const h = clampH(start.h + (start.y - ev.clientY));
      latest = { w, h };
      setSize(latest);
      if (pos && fixedRight != null && fixedBottom != null) {
        latestPos = clampPos(fixedRight - w, fixedBottom - h, w);
        setPos(latestPos);
      }
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      persistSize(latest.w, latest.h);
      if (latestPos) persistPos(latestPos);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  // Drag the title bar to move the panel, clamped to the agent page region (below the header, right of
  // the sidebar, inside the viewport). Ignores pointer-downs on the bar's buttons (New/Sessions/the
  // minimize chevron handle their own clicks). A pointer-down on the bar's EMPTY area that doesn't move
  // is treated as a click → minimize: the whole bar is the drag handle, so the minimize lives in the
  // gesture's end rather than a full-bleed overlay button, which would swallow every drag.
  const onTitleBarPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = rect.left;
    const origTop = rect.top;
    let moved = false;
    let latestPos: Pos | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      latestPos = clampPos(origLeft + dx, origTop + dy, size.w);
      setPos(latestPos);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      if (moved && latestPos) {
        persistPos(latestPos);
      } else if (!moved) {
        // A click (no drag) on the empty bar area minimizes — the pointer-down already excluded the
        // control buttons above, so this only fires on the bar's empty space.
        onOpenChange(false);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };

  const pickSession = (tid: string) => {
    setSessionsOpen(false);
    void chat.loadSession(tid);
  };
  const startNew = () => {
    setSessionsOpen(false);
    chat.newSession();
  };
  const sessionsDisabled = chat.busy || chat.recording;

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          className="fixed z-[var(--z-fab)] flex max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-xl"
          style={{
            width: size.w,
            height: size.h,
            ...(pos
              ? { left: pos.left, top: pos.top }
              : { right: DEFAULT_RIGHT, bottom: DEFAULT_BOTTOM }),
          }}
        >
          {/* Resize grip (top-left corner; the panel is anchored bottom-right, so dragging up/left
              grows it). Pointer-only enhancement, hence aria-hidden. */}
          <Tooltip content={t("playground.resize", "Drag to resize")}>
            <div
              onPointerDown={onResizeStart}
              aria-hidden="true"
              className="absolute top-0 left-0 z-20 flex h-6 w-6 cursor-nwse-resize items-center justify-center text-text-muted/70 hover:text-text-secondary"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 10 L10 3 M3 14 L14 3 M7 14 L14 7" />
              </svg>
            </div>
          </Tooltip>

          {/* The whole header bar is the drag handle (grab cursor). Dragging moves the panel; a click
              on its empty area minimizes (handled in onTitleBarPointerDown's pointerup). The chevron at
              the right is the keyboard-accessible minimize; New/Sessions keep their own actions (the
              drag handler ignores pointer-downs that land on a button). */}
          <div
            onPointerDown={onTitleBarPointerDown}
            className="relative flex cursor-grab items-center gap-2 border-border border-b py-2 pr-2 pl-8 active:cursor-grabbing"
          >
            <Button
              variant="secondary"
              size="sm"
              className="relative z-10"
              onClick={startNew}
              disabled={
                (!chat.hasConversation && !chat.currentThreadId) ||
                sessionsDisabled
              }
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("playground.newSession", "New session")}
            </Button>
            <Tooltip content={t("playground.sessions", "Sessions")}>
              <button
                type="button"
                onClick={() => setSessionsOpen((o) => !o)}
                aria-label={t("playground.sessions", "Sessions")}
                aria-expanded={sessionsOpen}
                className={cn(
                  "relative z-10 rounded p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                  { "bg-bg-hover text-text-primary": sessionsOpen },
                )}
              >
                <History className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tooltip>
            <span className="flex-1" />
            <Tooltip content={t("playground.minimize", "Minimize")}>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label={t("playground.minimize", "Minimize")}
                className="relative z-10 rounded p-1 text-text-muted hover:text-text-primary"
              >
                <ChevronDown className="h-4 w-4" aria-hidden="true" />
              </button>
            </Tooltip>
          </div>

          {sessionsOpen && (
            <>
              {/* Click-outside catcher (below the header), closes the menu. */}
              <button
                type="button"
                aria-label={t("common.close", "Close")}
                tabIndex={-1}
                className="absolute inset-x-0 top-12 bottom-0 z-10 cursor-default"
                onClick={() => setSessionsOpen(false)}
              />
              <div className="absolute inset-x-2 top-12 z-20 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-bg-secondary p-1 shadow-lg">
                {chat.sessions.length === 0 ? (
                  <p className="px-2 py-1.5 text-text-muted text-xs">
                    {t("playground.historyEmpty", "No saved sessions yet.")}
                  </p>
                ) : (
                  chat.sessions.map((s) => {
                    const active = s.threadId === chat.currentThreadId;
                    return (
                      <div
                        key={s.threadId}
                        className={cn(
                          "group flex items-center gap-1 rounded-md hover:bg-bg-hover",
                          { "bg-bg-hover": active },
                        )}
                      >
                        <button
                          type="button"
                          className={cn(
                            "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-sm",
                            active
                              ? "text-text-primary"
                              : "text-text-secondary",
                          )}
                          disabled={sessionsDisabled}
                          onClick={() => pickSession(s.threadId)}
                        >
                          {s.title ||
                            t("playground.untitledSession", "Untitled session")}
                        </button>
                        <button
                          type="button"
                          aria-label={t("common.delete", "Delete")}
                          className="shrink-0 rounded p-1 text-text-muted opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                          onClick={() => void chat.deleteSession(s.threadId)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}

          <div className="min-h-0 flex-1">
            <PlaygroundChat
              chat={chat}
              agentId={agentId}
              missingConfig={missingConfig}
              capabilities={capabilities}
              toolsDirty={toolsDirty}
              showSidebar={false}
              bare
            />
          </div>
        </div>
      )}
    </>
  );
}
