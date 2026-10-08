// The operator's side of carrying the customer's files into the case: the config shape, its reader
// and the case attribute that records what was carried. Kept apart from ./carry-attachments.ts, which
// talks to Chatwoot, so the console editor can import it without pulling server code into the bundle.

export const CARRY_FILE_TYPES = ["image", "file", "audio", "video"] as const;
export type CarryFileType = (typeof CARRY_FILE_TYPES)[number];
export const CARRY_MODES = ["off", "attendance", "conversation"] as const;
export type CarryMode = (typeof CARRY_MODES)[number];

export interface CarryAttachmentsConfig {
  // off: nothing is carried. attendance: the files of the origin's current attendance, cut where
  // memory compaction cuts it. conversation: every file the contact sent in the origin conversation.
  mode: CarryMode;
  fileTypes: CarryFileType[];
  // The newest N win when there are more; the rest are counted as left out.
  maxFiles: number;
}

export const CARRY_ATTACHMENTS_MAX_FILES = 20;
export const CARRY_ATTACHMENTS_DEFAULTS: CarryAttachmentsConfig = {
  mode: "off",
  fileTypes: ["image", "file"],
  maxFiles: 10,
};

// The case's attribute that remembers which of the origin's attachments it already received, so a
// reused or continued case gets only what is new. Fixed, like the origin attribute: it is read on the
// case, by whichever agent opens or continues it, without reading that agent's settings. One entry per
// FILE, `<message id>:<attachment id>`: the message says where it came from, and the attachment is
// what is deduplicated, because one message can carry several files and one of them can fail, and
// the failed one is then tried again on the next call instead of being marked done with its siblings.
export const CROSS_INBOX_CASE_CARRIED_ATTRIBUTE = "carried_attachment_ids";
// How many ids the attribute keeps, newest last. A case is not carried thousands of files; the cap
// only keeps a pathological one from growing the attribute without end.
export const CARRIED_IDS_KEPT = 500;

// Chatwoot's own default upload ceiling is 40 MB, and the download refuses past 25 MB
// (client.ts MAX_ATTACHMENT_BYTES), so the lower of the two decides what can make the trip.
export const CARRY_MAX_FILE_BYTES = 25 * 1024 * 1024;

export function readCarryAttachments(v: unknown): CarryAttachmentsConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return {
      ...CARRY_ATTACHMENTS_DEFAULTS,
      fileTypes: [...CARRY_ATTACHMENTS_DEFAULTS.fileTypes],
    };
  }
  const o = v as Record<string, unknown>;
  const mode = (CARRY_MODES as readonly unknown[]).includes(o.mode)
    ? (o.mode as CarryMode)
    : CARRY_ATTACHMENTS_DEFAULTS.mode;
  const types: CarryFileType[] = [];
  if (Array.isArray(o.fileTypes)) {
    for (const t of o.fileTypes) {
      const name = typeof t === "string" ? t.trim().toLowerCase() : "";
      if (
        (CARRY_FILE_TYPES as readonly string[]).includes(name) &&
        !types.includes(name as CarryFileType)
      ) {
        types.push(name as CarryFileType);
      }
    }
  }
  const raw =
    typeof o.maxFiles === "string" && o.maxFiles.trim() !== ""
      ? Number(o.maxFiles)
      : o.maxFiles;
  const maxFiles =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(CARRY_ATTACHMENTS_MAX_FILES, Math.max(1, Math.round(raw)))
      : CARRY_ATTACHMENTS_DEFAULTS.maxFiles;
  return {
    mode,
    // An empty list (or one with nothing known in it) carries nothing, which is what `off` is for, so
    // it reads as the default rather than as a second way to switch the block off.
    fileTypes:
      types.length > 0 ? types : [...CARRY_ATTACHMENTS_DEFAULTS.fileTypes],
    maxFiles,
  };
}
