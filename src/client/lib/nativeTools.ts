import type { TFunction } from "i18next";
import {
  ArrowRightLeft,
  BellOff,
  Calculator,
  CheckCircle2,
  Clock,
  Code2,
  Image as ImageIcon,
  LayoutGrid,
  type LucideIcon,
  Mic,
  Smile,
  SquarePen,
  StickyNote,
  Tag,
  Tags,
} from "lucide-react";

// Display metadata for the built-in native tools (icon + friendly label + one-line description),
// shared by the agent editor's tool cards and the Components catalog. The graph-side catalog
// (src/graph/tools/catalog.ts) stays dependency-free; this is the UI-only projection.

export const NATIVE_TOOL_ICONS: Record<string, LucideIcon> = {
  handoff_to_human: ArrowRightLeft,
  private_note: StickyNote,
  set_custom_attribute: Tag,
  assign_label: Tags,
  resolve_conversation: CheckCircle2,
  kanban_move_card: LayoutGrid,
  update_kanban_task: SquarePen,
  set_voice_preference: Mic,
  react_to_message: Smile,
  send_image: ImageIcon,
  skip_reply: BellOff,
  calculator: Calculator,
  get_current_time: Clock,
  run_code: Code2,
};

export interface NativeToolMeta {
  label: string;
  description: string;
  icon: LucideIcon;
}

// Static t() calls (one per tool) so the i18n extractor + the no-dynamic-i18n-key lint are happy.
export function nativeToolMeta(name: string, t: TFunction): NativeToolMeta {
  const icon = NATIVE_TOOL_ICONS[name] ?? Tag;
  switch (name) {
    case "handoff_to_human":
      return {
        icon,
        label: t("nativeTools.handoff_to_human.label", "Hand off to human"),
        description: t(
          "nativeTools.handoff_to_human.desc",
          "Escalate the conversation to a human agent, optionally with a summary note.",
        ),
      };
    case "private_note":
      return {
        icon,
        label: t("nativeTools.private_note.label", "Private note"),
        description: t(
          "nativeTools.private_note.desc",
          "Post an internal note visible only to human agents, not the customer.",
        ),
      };
    case "set_custom_attribute":
      return {
        icon,
        label: t("nativeTools.set_custom_attribute.label", "Set attribute"),
        description: t(
          "nativeTools.set_custom_attribute.desc",
          "Set a conversation custom attribute (e.g. lead stage, qualification flag).",
        ),
      };
    case "assign_label":
      return {
        icon,
        label: t("nativeTools.assign_label.label", "Add label"),
        description: t(
          "nativeTools.assign_label.desc",
          "Add a label (tag) to the conversation to categorize it (vip, urgent, lead…).",
        ),
      };
    case "resolve_conversation":
      return {
        icon,
        label: t("nativeTools.resolve_conversation.label", "Resolve"),
        description: t(
          "nativeTools.resolve_conversation.desc",
          "Mark the conversation as resolved when the request is fully handled.",
        ),
      };
    case "kanban_move_card":
      return {
        icon,
        label: t("nativeTools.kanban_move_card.label", "Move kanban card"),
        description: t(
          "nativeTools.kanban_move_card.desc",
          "Move a funnel card (task) to another board step.",
        ),
      };
    case "update_kanban_task":
      return {
        icon,
        label: t("nativeTools.update_kanban_task.label", "Update kanban card"),
        description: t(
          "nativeTools.update_kanban_task.desc",
          "Update a funnel card's title, description, priority or scheduled dates.",
        ),
      };
    case "set_voice_preference":
      return {
        icon,
        label: t("nativeTools.set_voice_preference.label", "Voice preference"),
        description: t(
          "nativeTools.set_voice_preference.desc",
          "Record whether the customer prefers audio or text replies.",
        ),
      };
    case "react_to_message":
      return {
        icon,
        label: t("nativeTools.react_to_message.label", "React with emoji"),
        description: t(
          "nativeTools.react_to_message.desc",
          "React to the customer's last message with an emoji (WhatsApp reaction).",
        ),
      };
    case "send_image":
      return {
        icon,
        label: t("nativeTools.send_image.label", "Send image"),
        description: t(
          "nativeTools.send_image.desc",
          "Deliver an image to the customer from its URL, limited to the hosts you allow.",
        ),
      };
    case "skip_reply":
      return {
        icon,
        label: t("nativeTools.skip_reply.label", "Skip reply"),
        description: t(
          "nativeTools.skip_reply.desc",
          "Decide not to reply when a message needs no answer (e.g. just 'ok' or an emoji).",
        ),
      };
    case "calculator":
      return {
        icon,
        label: t("nativeTools.calculator.label", "Calculator"),
        description: t(
          "nativeTools.calculator.desc",
          "Evaluate arithmetic expressions exactly (+ - * / % ^ and parentheses).",
        ),
      };
    case "get_current_time":
      return {
        icon,
        label: t("nativeTools.get_current_time.label", "Current time"),
        description: t(
          "nativeTools.get_current_time.desc",
          "Get the current date and time in the agent's timezone.",
        ),
      };
    case "run_code":
      return {
        icon,
        label: t("nativeTools.run_code.label", "Run code"),
        description: t(
          "nativeTools.run_code.desc",
          "Run a JavaScript snippet in an isolated sandbox for exact computation and verdicts (check digits, dates, parsing).",
        ),
      };
    default:
      return { icon, label: name, description: "" };
  }
}
