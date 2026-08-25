import {
  Check,
  ClipboardCheck,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  Skeleton,
  type TabItem,
  Tabs,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { Tooltip } from "@/client/components/Tooltip";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { docErrorEntry, mergeDocumentEvent } from "@/client/lib/knowledgeDocs";
import { cn } from "@/client/lib/utils";

type BasesData = Awaited<
  ReturnType<typeof api.api.v1.knowledge.bases.get>
>["data"];
export type Base = NonNullable<BasesData>["bases"][number];
type DocumentsData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.knowledge.bases>["documents"]["get"]>
>["data"];
type KnowledgeDoc = NonNullable<DocumentsData>["documents"][number];
type EmbeddingBlock = NonNullable<DocumentsData>["embeddingBlock"];
type BlockReason = NonNullable<EmbeddingBlock>["reason"];
type DocDetailData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.knowledge.documents>["get"]>
>["data"];
type DocDetail = NonNullable<DocDetailData>["document"];

// Minimal handle for the add-content / documents modals (the agent catalog carries only id + name).
type BaseRef = { id: string; name: string };

type UploadStatus = "idle" | "uploading" | "done" | "error";

// How long a burst of blocked documents is allowed to keep pushing the block re-read back. Short
// enough that the banner corrects itself while the operator is still looking at it, long enough to
// swallow a batch the scheduler is working through one job at a time.
const BLOCK_RECHECK_MS = 500;

// How often an open documents modal re-asks on its own, for the configuration changes no document
// event announces (a credential filled, deleted or replaced in another tab). Slow on purpose: this
// is a safety net for a screen someone left open, not the path that keeps the banner current.
const BLOCK_POLL_MS = 30_000;

// A file staged in the add-content modal. Carries its own upload status so a batch shows per-file
// progress and a partial failure stays visible (the failed ones can be retried without re-picking).
interface PickedFile {
  id: string;
  file: File;
  status: UploadStatus;
  // HTTP status of the failed upload (set when status === "error"); 0 for a thrown/network error.
  errorStatus?: number;
  errorMessage?: string;
}

// Run `worker` over `items` with at most `limit` in flight (bounded concurrency for batch uploads,
// so a large drop does not open dozens of simultaneous requests). Each worker swallows its own
// errors via the result it records; the pool itself never rejects.
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item !== undefined) await worker(item);
      }
    },
  );
  await Promise.all(runners);
}

export interface KnowledgeManager {
  openCreate: () => void;
  openEdit: (base: Base) => void;
  openEditById: (id: string) => Promise<void>;
  openDocs: (base: BaseRef) => void;
  // Open the read-only content preview for a specific document (e.g. a playground grounding source).
  openDocPreview: (doc: { id: string; title: string }) => void;
  askDelete: (base: BaseRef) => void;
  modals: ReactNode;
}

// Owns every knowledge-base management modal (create/edit base, add content, documents, doc preview)
// plus its state, handlers and the live ingestion-status WebSocket. Shared by the Components →
// Knowledge panel and the agent editor's Knowledge tab so a base can be created/edited/fed documents
// without leaving the agent. `onChanged` is called after any mutation so the consumer refetches its
// own list (the bases list itself is NOT owned here — each consumer renders its own).
export function useKnowledgeManager(opts: {
  onChanged: () => void | Promise<void>;
  // Optional: called with the freshly-created base so a caller (the agent editor) can auto-select it.
  onCreated?: (base: { id: string; name: string }) => void;
  // Show the per-document edit + delete buttons in the documents modal. Off by default (read-only
  // surfaces); the Knowledge resources page and the agent editor's Knowledge tab opt in.
  allowDocumentEdits?: boolean;
}): KnowledgeManager {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const onChanged = opts.onChanged;

  const ADD_TABS: TabItem[] = [
    { key: "texto", label: t("knowledge.tabTexto", "Text") },
    { key: "arquivo", label: t("knowledge.tabArquivo", "File") },
  ];

  const createModal = useModalController();
  const editModal = useModalController<Base>();
  const docsModal = useModalController<BaseRef>();
  // Add-content is opened from the documents modal's "+Adicionar" button and STACKS on top of it
  // (both live together, but the add form opens over the list instead of replacing it).
  const addContentModal = useModalController<BaseRef>();
  const docPreviewModal = useModalController<{ id: string; title: string }>();
  const docEditModal = useModalController<{ id: string; title: string }>();
  const confirm = useModalController<ConfirmPayload>();

  // Create/edit KB fields
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [chunkSize, setChunkSize] = useState(1000);
  const [chunkOverlap, setChunkOverlap] = useState(200);
  const [chunkSizeError, setChunkSizeError] = useState("");
  const [chunkOverlapError, setChunkOverlapError] = useState("");

  // Add content fields (the add form is a modal stacked over the documents list).
  const [addTab, setAddTab] = useState("texto");
  const [docTitle, setDocTitle] = useState("");
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".csv"];

  function addFiles(list: File[]) {
    const accepted: PickedFile[] = [];
    let rejected = false;
    for (const f of list) {
      const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        rejected = true;
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file: f, status: "idle" });
    }
    if (rejected) {
      showToast(
        t("knowledge.fileUnsupported", "Unsupported file type."),
        "error",
      );
    }
    const [first] = accepted;
    if (!first) return;
    // Single-file UX preserved: auto-fill the title from the only file's name.
    if (picked.length + accepted.length === 1 && !docTitle.trim()) {
      setDocTitle(first.file.name.replace(/\.[^.]+$/, ""));
    }
    setPicked((prev) => [...prev, ...accepted]);
  }

  function removeFile(id: string) {
    setPicked((prev) => prev.filter((p) => p.id !== id));
  }

  // Docs list
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  // The tenant's embedding block as of the last read, or null when indexing would work. Comes from
  // the list response rather than from any document row: the block belongs to the configuration, so
  // a value remembered per document would keep naming a credential the operator has since filled.
  const [embeddingBlock, setEmbeddingBlock] = useState<EmbeddingBlock>(null);

  // Doc preview
  const [docPreview, setDocPreview] = useState<string | null>(null);
  const [docPreviewLoading, setDocPreviewLoading] = useState(false);

  // Doc edit (title + text); the text loads from the GET-by-id, then a PATCH re-ingests on change.
  const [editDocTitle, setEditDocTitle] = useState("");
  const [editDocText, setEditDocText] = useState("");
  const [editDocLoading, setEditDocLoading] = useState(false);
  const [editDocOriginal, setEditDocOriginal] = useState({
    title: "",
    text: "",
  });

  const [busy, setBusy] = useState(false);

  const createDirty = name.trim() !== "" || description.trim() !== "";
  const editDirty =
    name.trim() !== (editModal.payload?.name ?? "") ||
    description.trim() !== (editModal.payload?.description ?? "") ||
    chunkSize !== (editModal.payload?.chunkSize ?? 1000) ||
    chunkOverlap !== (editModal.payload?.chunkOverlap ?? 200);
  const addContentDirty =
    addTab === "texto"
      ? docTitle.trim() !== "" || text.trim() !== ""
      : picked.length > 0 || docTitle.trim() !== "";

  // Live document status updates via realtime
  useTenantEvents({
    enabled: docsModal.isOpen,
    onKnowledgeDocument: (event) => {
      const baseId = docsModal.payload?.id;
      if (event.knowledgeBaseId !== baseId) return;
      setDocs((prev) =>
        prev
          ? prev.map((d) =>
              d.id === event.documentId ? mergeDocumentEvent(d, event) : d,
            )
          : null,
      );
      // Any of these events may mean the workspace's embedding configuration changed — another tab
      // or another administrator can fill, delete or replace the credential while this modal stays
      // open — and none of them says WHAT it changed to. UNINDEXED means the worker refused;
      // PROCESSING means it did not; but each describes the configuration as that job found it, and
      // the job runs on to READY without emitting anything else. So an event is a reason to ask,
      // never an answer: the server is the only thing that knows the configuration as it is now.
      scheduleBlockRecheck();
    },
  });

  const blockRecheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tickets order the answers about the block: two reads can be open at once (a burst re-arms the
  // window while an earlier one is still travelling), and the older one landing last would undo the
  // newer answer with nothing afterwards to correct it.
  const blockAnswerSeq = useRef(0);
  // The newest ticket that actually ARRIVED. Compared against this rather than against the newest
  // ticket ISSUED, because a read that fails answers nothing: it must not disqualify a good response
  // that was already travelling when it started.
  const blockCommitted = useRef(0);

  // Take the ticket BEFORE starting the request, never on arrival: a response that claims its number
  // when it lands is by definition the newest one, so the ticket would certify exactly the write it
  // exists to prevent — an answer something faster has already overtaken.
  function claimBlockAnswer(): number {
    blockAnswerSeq.current += 1;
    return blockAnswerSeq.current;
  }

  // Writes the block only if no NEWER answer has already arrived.
  function commitBlock(ticket: number, next: EmbeddingBlock) {
    if (ticket <= blockCommitted.current) return;
    blockCommitted.current = ticket;
    setEmbeddingBlock(next);
  }

  // Which documents modal a list response belongs to. Separate from the block's clock on purpose:
  // the two arrive in one response but answer different questions. The rows are this base's, and
  // only a newer OPENING makes them wrong; the block is the workspace's, and a dedicated read that
  // is faster than the list makes it wrong. Judging the rows by the block's clock let a list
  // response be refused outright, which left the modal on its skeleton with nothing to retry it.
  const docsSession = useRef(0);

  // Trailing window rather than a suppress-while-in-flight guard: the scheduler awaits its claimed
  // jobs one after another, so a batch produces events that need not overlap a short request at
  // all, and a guard would let each one through — one request per document, from every open tab.
  function scheduleBlockRecheck() {
    if (blockRecheckTimer.current) clearTimeout(blockRecheckTimer.current);
    blockRecheckTimer.current = setTimeout(() => {
      blockRecheckTimer.current = null;
      void recheckBlock();
    }, BLOCK_RECHECK_MS);
  }

  // A pending window outlives the component otherwise, and fires a request for a screen that is
  // gone.
  useEffect(
    () => () => {
      if (blockRecheckTimer.current) clearTimeout(blockRecheckTimer.current);
    },
    [],
  );

  // The events above only fire when a job runs. Filling, deleting or replacing the credential is a
  // configuration change with no job attached, so nothing would tell an open modal about it, and the
  // banner would go on describing a block that was resolved — or stay silent about one that appeared
  // — until the operator reopened it or tried to index. A slow poll closes that without a new
  // realtime channel: the read is one workspace-scoped question, and the window above already
  // collapses it against the event-driven reads.
  // `recheckBlock` reads only refs and the api client, so the closure captured here behaves the same
  // on every render; listing it would tear the interval down and rebuild it on each one, which never
  // reaches 30s and so never polls at all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explained directly above
  useEffect(() => {
    if (!docsModal.isOpen) return;
    const id = setInterval(() => void recheckBlock(), BLOCK_POLL_MS);
    return () => clearInterval(id);
  }, [docsModal.isOpen]);

  // Asks the workspace-scoped endpoint, not a base's document list: the question has nothing to do
  // with which base is open, and answering it by re-downloading a list was what forced every caller
  // to remember that the answer's scope and the request's scope were different things.
  async function recheckBlock() {
    const ticket = claimBlockAnswer();
    try {
      const { data } = await api.api.v1.knowledge["embedding-block"].get();
      if (data) commitBlock(ticket, data.block ?? null);
    } catch {
      // A failed read is not news about the configuration, so the last answer stands. Swallowed
      // rather than surfaced: this runs on a timer, so an offline browser would otherwise raise the
      // same rejection every 30s for as long as the modal is open, and the operator already has the
      // console's own signals for being offline.
    }
  }

  useOnModalOpen(createModal, () => {
    setName("");
    setDescription("");
    setChunkSize(1000);
    setChunkOverlap(200);
    setChunkSizeError("");
    setChunkOverlapError("");
  });

  useOnModalOpen(editModal, () => {
    const b = editModal.payload;
    if (!b) return;
    setName(b.name);
    setDescription(b.description ?? "");
    setChunkSize(b.chunkSize ?? 1000);
    setChunkOverlap(b.chunkOverlap ?? 200);
    setChunkSizeError("");
    setChunkOverlapError("");
  });

  useOnModalOpen(addContentModal, () => {
    setAddTab("texto");
    setDocTitle("");
    setText("");
    setPicked([]);
  });

  useOnModalOpen(docPreviewModal, () => {
    const payload = docPreviewModal.payload;
    if (!payload) return;
    setDocPreview(null);
    setDocPreviewLoading(true);
    api.api.v1.knowledge
      .documents({ id: payload.id })
      .get()
      .then(({ data }) => {
        setDocPreview(
          (data?.document as DocDetail | null | undefined)?.content ?? null,
        );
      })
      .catch(() => {
        setDocPreview(null);
      })
      .finally(() => {
        setDocPreviewLoading(false);
      });
  });

  useOnModalOpen(docEditModal, () => {
    const payload = docEditModal.payload;
    if (!payload) return;
    setEditDocTitle(payload.title);
    setEditDocText("");
    setEditDocOriginal({ title: payload.title, text: "" });
    setEditDocLoading(true);
    api.api.v1.knowledge
      .documents({ id: payload.id })
      .get()
      .then(({ data }) => {
        const d = data?.document as DocDetail | null | undefined;
        const title = d?.title ?? payload.title;
        const content = d?.content ?? "";
        setEditDocTitle(title);
        setEditDocText(content);
        setEditDocOriginal({ title, text: content });
      })
      .catch(() => {})
      .finally(() => {
        setEditDocLoading(false);
      });
  });

  const editDocDirty =
    editDocTitle.trim() !== editDocOriginal.title ||
    editDocText !== editDocOriginal.text;

  function validateChunkFields(): boolean {
    let valid = true;
    if (chunkSize < 100 || chunkSize > 8000) {
      setChunkSizeError(
        t("knowledge.chunkSizeError", "Must be between 100 and 8000."),
      );
      valid = false;
    } else {
      setChunkSizeError("");
    }
    if (chunkOverlap < 0 || chunkOverlap > Math.floor(chunkSize / 2)) {
      setChunkOverlapError(
        t(
          "knowledge.chunkOverlapError",
          "Must be between 0 and half the chunk size.",
        ),
      );
      valid = false;
    } else {
      setChunkOverlapError("");
    }
    return valid;
  }

  async function create() {
    if (!name.trim()) return;
    if (!validateChunkFields()) return;
    setBusy(true);
    try {
      const { data, error: err } = await api.api.v1.knowledge.bases.post({
        name: name.trim(),
        description: description.trim() || undefined,
      });
      if (err || !data) throw err;
      if (chunkSize !== 1000 || chunkOverlap !== 200) {
        await api.api.v1.knowledge
          .bases({ id: data.base.id })
          .patch({ chunkSize, chunkOverlap });
      }
      showToast(t("knowledge.created", "Knowledge base created."), "success");
      createModal.close();
      void onChanged();
      opts.onCreated?.({ id: data.base.id, name: name.trim() });
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("knowledge.createError", "Could not create."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    const b = editModal.payload;
    if (!b || !name.trim()) return;
    if (!validateChunkFields()) return;
    setBusy(true);
    try {
      const { error: err } = await api.api.v1.knowledge
        .bases({ id: b.id })
        .patch({
          name: name.trim(),
          description: description.trim() || null,
          chunkSize,
          chunkOverlap,
        });
      if (err) throw err;
      showToast(t("knowledge.updated", "Knowledge base updated."), "success");
      editModal.close();
      void onChanged();
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("knowledge.updateError", "Could not update."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addText() {
    const payload = addContentModal.payload;
    if (!payload || !text.trim()) return;
    setBusy(true);
    try {
      const { error: err } = await api.api.v1.knowledge
        .bases({ id: payload.id })
        .documents.post({
          title: docTitle.trim() || t("knowledge.docTitle", "Title"),
          text: text.trim(),
        });
      if (err) throw err;
      showToast(
        t("knowledge.addedQueued", "Document queued for processing."),
        "success",
      );
      // Close the add form (stacked on top) and refresh the list beneath so the new (processing)
      // document is visible in place.
      addContentModal.close();
      if (docsModal.payload) await reloadDocs(docsModal.payload.id);
      void onChanged();
    } catch (e) {
      // The server's own message when it sent one: a refusal that names the field and the character
      // is the whole answer, and collapsing it into "Could not add document" throws away the only
      // part the operator can act on (issue #247).
      showToast(
        apiErrorMessage(e) ??
          t("knowledge.addError", "Could not add document."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  // Localized failure reason for a per-file upload error (static keys: extractor-friendly). The
  // server's own message wins when it sent one: the statuses below are the ones we can phrase better
  // than the API can, and everything else the API already phrased for this operator's language.
  function uploadErrorMessage(
    status: number | undefined,
    message: string | undefined,
  ): string {
    if (status === 422) {
      return t(
        "knowledge.fileNotExtractable",
        "The file contains no extractable text (scanned PDF or image).",
      );
    }
    if (status === 415) {
      return t("knowledge.fileUnsupported", "Unsupported file type.");
    }
    if (status === 413) {
      return t("knowledge.fileTooLarge", "The file exceeds the size limit.");
    }
    return message ?? t("knowledge.addError", "Could not add document.");
  }

  // Upload one staged file, returning the failing HTTP status (undefined on success, 0 on a thrown
  // error). The title field only applies in single-file mode; in a batch each file keeps its own
  // name (the server defaults the title to the filename).
  async function uploadOne(
    baseId: string,
    pf: PickedFile,
    useTitle: boolean,
  ): Promise<{ status: number; message?: string } | undefined> {
    try {
      // NOTE: the treaty serializes a File body as multipart AND injects the
      // X-Tenant-Id header (SUPER_ADMIN target tenant); a raw fetch here 500s
      // for super admins because the tenant gate never resolves a target.
      const { error: err } = await api.api.v1.knowledge
        .bases({ id: baseId })
        .documents.upload.post({
          file: pf.file,
          ...(useTitle && docTitle.trim() ? { title: docTitle.trim() } : {}),
        });
      return err
        ? { status: err.status, message: apiErrorMessage(err) ?? undefined }
        : undefined;
    } catch {
      return { status: 0 };
    }
  }

  // Batch-upload every staged file not yet queued, with bounded concurrency and per-file progress.
  // A partial failure keeps the modal open with the failed rows (retryable); a clean run closes.
  async function addFilesContent() {
    const payload = addContentModal.payload;
    if (!payload) return;
    const toUpload = picked.filter((p) => p.status !== "done");
    if (toUpload.length === 0) return;
    const useTitle = picked.length === 1;
    setBusy(true);
    setPicked((prev) =>
      prev.map((p) =>
        p.status === "done"
          ? p
          : { ...p, status: "uploading", errorKey: undefined },
      ),
    );
    const results = new Map<
      string,
      { status: number; message?: string } | undefined
    >();
    await runPool(toUpload, 3, async (pf) => {
      const failure = await uploadOne(payload.id, pf, useTitle);
      results.set(pf.id, failure);
      setPicked((prev) =>
        prev.map((p) =>
          p.id === pf.id
            ? {
                ...p,
                status: failure === undefined ? "done" : "error",
                errorStatus: failure?.status,
                errorMessage: failure?.message,
              }
            : p,
        ),
      );
    });
    setBusy(false);
    const failed = [...results.values()].filter((s) => s !== undefined).length;
    const queued = results.size - failed;
    if (failed === 0) {
      showToast(
        t("knowledge.batchQueued", "{{n}} document(s) queued.", {
          n: queued,
        }),
        "success",
      );
      // Close the add form (stacked on top) and refresh the list beneath so the new (processing)
      // documents are visible in place.
      addContentModal.close();
      if (docsModal.payload) await reloadDocs(docsModal.payload.id);
      void onChanged();
      return;
    }
    showToast(
      t("knowledge.batchPartial", "{{queued}} queued, {{failed}} failed.", {
        queued,
        failed,
      }),
      queued > 0 ? "warning" : "error",
    );
    // Some did queue: refresh the list so they appear while the failed rows stay for retry.
    if (queued > 0) {
      if (docsModal.payload) void reloadDocs(docsModal.payload.id);
      void onChanged();
    }
  }

  async function openDocs(b: BaseRef) {
    setDocs(null);
    docsModal.open({ id: b.id, name: b.name });
    // Everything issued for the previous session is void, answered or not: this is a different
    // modal now, possibly on a different base, and an old response landing into it would show the
    // documents and the block of a screen the operator already closed (docs/modals.md).
    blockCommitted.current = blockAnswerSeq.current;
    const session = ++docsSession.current;
    const ticket = claimBlockAnswer();
    const { data } = await api.api.v1.knowledge
      .bases({ id: b.id })
      .documents.get();
    if (!data || session !== docsSession.current) return;
    setDocs(data.documents);
    commitBlock(ticket, data.embeddingBlock ?? null);
  }

  // Refetch the open documents modal's list in place (after an edit, so the new title/status shows).
  async function reloadDocs(baseId: string) {
    const session = docsSession.current;
    const ticket = claimBlockAnswer();
    const { data } = await api.api.v1.knowledge
      .bases({ id: baseId })
      .documents.get();
    if (!data || session !== docsSession.current) return;
    setDocs(data.documents);
    commitBlock(ticket, data.embeddingBlock ?? null);
  }

  async function saveDocEdit() {
    const payload = docEditModal.payload;
    if (!payload || !editDocTitle.trim() || !editDocText.trim()) return;
    setBusy(true);
    try {
      const { error: err } = await api.api.v1.knowledge
        .documents({ id: payload.id })
        .patch({ title: editDocTitle.trim(), text: editDocText });
      if (err) throw err;
      showToast(t("knowledge.docUpdated", "Document updated."), "success");
      docEditModal.close();
      if (docsModal.payload) await reloadDocs(docsModal.payload.id);
      void onChanged();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("knowledge.docUpdateError", "Could not update the document."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function openEditById(id: string) {
    try {
      // The list carries chunkSize/chunkOverlap (the GET-by-id shape does not), so resolve the full
      // base from the list. The agent editor only has the base id, not the editable fields.
      const { data, error: err } = await api.api.v1.knowledge.bases.get();
      if (err || !data) throw err ?? new Error("no data");
      const base = data.bases.find((b) => b.id === id);
      if (!base) throw new Error("not found");
      editModal.open(base);
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("knowledge.loadError", "Could not load this base."),
        "error",
      );
    }
  }

  // Re-index a single document. Works for FAILED (retry) and UNINDEXED (first index after an import);
  // both go PENDING server-side and re-run ingestion. Reverts to the original status on error.
  async function retryDoc(doc: KnowledgeDoc) {
    const original = doc.status;
    setDocs((prev) =>
      prev
        ? prev.map((d) =>
            d.id === doc.id ? { ...d, status: "PROCESSING" } : d,
          )
        : null,
    );
    try {
      const { error: err } = await api.api.v1.knowledge
        .documents({ id: doc.id })
        .retry.post();
      if (err) throw err;
      // Refetch the consumer's catalog so surfaces derived from unindexed counts
      // (e.g. the editor's "documents need indexing" banner) clear immediately.
      void onChanged();
      showToast(t("knowledge.retried", "Retrying..."), "success");
    } catch (e) {
      setDocs((prev) =>
        prev
          ? prev.map((d) => (d.id === doc.id ? { ...d, status: original } : d))
          : null,
      );
      showToast(
        apiErrorMessage(e) || t("knowledge.retryError", "Could not retry."),
        "error",
      );
    }
  }

  // Bulk-index every UNINDEXED document in a base (the "index all" affordance after an agent import
  // that bundled the source text). Optimistically marks them PROCESSING; reverts on error or when a
  // prerequisite blocks the run.
  async function indexAllUnindexed(baseId: string) {
    const affected = new Set(
      (docs ?? []).filter((d) => d.status === "UNINDEXED").map((d) => d.id),
    );
    if (affected.size === 0) return;
    const revert = () =>
      setDocs((prev) =>
        prev
          ? prev.map((d) =>
              affected.has(d.id) ? { ...d, status: "UNINDEXED" } : d,
            )
          : null,
      );
    setDocs((prev) =>
      prev
        ? prev.map((d) =>
            affected.has(d.id) ? { ...d, status: "PROCESSING" } : d,
          )
        : null,
    );
    const ticket = claimBlockAnswer();
    try {
      const { data, error: err } = await api.api.v1.knowledge
        .bases({ id: baseId })
        .reindex.post();
      if (err) throw err;
      // A missing prerequisite (embedding not configured, or its credential not filled yet) queues
      // nothing and leaves the docs UNINDEXED. Surface the reason + the fix instead of faking progress.
      // The reindex answer IS a fresh read of the block, and it may be newer than the one the modal
      // opened with (a credential deleted, or filled, meanwhile). Adopt it in BOTH directions: with
      // a block, or the toast fades and the badges go back to a neutral "Not indexed" the server
      // just contradicted; without one, or the snapshot goes on explaining a block that the queued
      // jobs just disproved.
      commitBlock(
        ticket,
        data?.blocked ? { reason: data.blocked.reason } : null,
      );
      if (data?.blocked) {
        revert();
        // Same text as the banner, from the same function: two wordings for one reason is how the
        // third one ended up described as the second (review finding, round 6).
        showToast(blockTextFor(data.blocked.reason), "warning");
        return;
      }
      // Refetch the consumer's catalog so surfaces derived from unindexed counts
      // (e.g. the editor's "documents need indexing" banner) clear immediately.
      void onChanged();
      showToast(t("knowledge.indexing", "Indexing…"), "success");
    } catch (e) {
      revert();
      showToast(
        apiErrorMessage(e) ||
          t("knowledge.indexAllError", "Could not start indexing."),
        "error",
      );
    }
  }

  function askDeleteDoc(doc: KnowledgeDoc) {
    confirm.open({
      title: t("knowledge.docDeleteTitle", "Delete document"),
      message: t("knowledge.docDeleteMessage", 'Delete "{{title}}"?', {
        title: doc.title,
      }),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const { error: err } = await api.api.v1.knowledge
          .documents({ id: doc.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("knowledge.docDeleteError", "Could not delete document."),
            "error",
          );
          throw err;
        }
        showToast(t("knowledge.docDeleted", "Document deleted."), "success");
        setDocs((prev) => (prev ? prev.filter((d) => d.id !== doc.id) : null));
        void onChanged();
      },
    });
  }

  function askDelete(b: BaseRef) {
    confirm.open({
      title: t("knowledge.deleteTitle", "Delete knowledge base"),
      message: t(
        "knowledge.deleteMessage",
        'Delete "{{name}}" and all its documents?',
        { name: b.name },
      ),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const { error: err } = await api.api.v1.knowledge
          .bases({ id: b.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("knowledge.deleteError", "Could not delete."),
            "error",
          );
          throw err;
        }
        showToast(t("knowledge.deleted", "Deleted."), "success");
        void onChanged();
      },
    });
  }

  // Localizes a document's failure reason. The ingest job stores a stable i18n token for known
  // failures (e.g. a missing embedding credential); anything else is a raw diagnostic message.
  //
  // The branch table moved to src/client/lib/knowledgeDocs.ts, keyed on the SAME map the server
  // throws from, because the two used to spell the tokens differently and neither branch ever fired
  // (issue #256). Only the `t` call is left here: `t` is a hook binding this component owns.
  //
  // t('knowledge.docError.embeddingEmpty', 'The embedding credential is empty. Fill it in, then index again.')
  // t('knowledge.docError.embeddingNotConfigured', 'The embedding credential is not configured for this workspace. Set it under Components, then index again.')
  // t('knowledge.docError.embeddingPending', 'The embedding credential has not been filled in yet. Fill it in, then index again.')
  function docErrorText(error: string): string {
    const entry = docErrorEntry(error);
    if (!entry) return error;
    // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via the magic comments just above
    return t(entry.key, entry.fallback);
  }

  // Operator-facing text for one block reason. The three need different instructions: create a
  // credential, fill the one that exists, or replace one whose secret is blank — sending someone to
  // the wrong one is the whole complaint. Exhaustive on purpose, with no `default`: the return type
  // makes a fourth reason a compile error here rather than a branch that quietly falls into one of
  // the other two.
  function blockTextFor(reason: BlockReason): string {
    switch (reason) {
      case "embedding_not_configured":
        return t(
          "knowledge.embeddingBlock.notConfigured",
          "The embedding credential is not configured for this workspace. Set it under Components, then index again.",
        );
      case "credential_pending":
        return t(
          "knowledge.embeddingBlock.pending",
          "The embedding credential was never filled in. Fill it under Components, then index again.",
        );
      case "credential_empty":
        return t(
          "knowledge.embeddingBlock.empty",
          "The embedding credential is empty. Fill it in, then index again.",
        );
    }
  }

  // The tenant's CURRENT block as text, or null when there is none.
  function embeddingBlockText(): string | null {
    return embeddingBlock ? blockTextFor(embeddingBlock.reason) : null;
  }

  function docStatusBadge(doc: KnowledgeDoc) {
    if (doc.status === "READY") {
      return (
        <span className="rounded-full bg-success/10 px-2 py-0.5 text-success text-xs">
          {t("knowledge.docStatus.READY", "{{n}} chunks", {
            n: doc.chunkCount,
          })}
        </span>
      );
    }
    if (doc.status === "FAILED") {
      const badge = (
        <span
          className={cn(
            "rounded-full bg-error/10 px-2 py-0.5 text-error text-xs",
            {
              "cursor-help underline decoration-dotted underline-offset-2":
                !!doc.error,
            },
          )}
        >
          {t("knowledge.docStatus.FAILED", "Failed")}
        </span>
      );
      return doc.error ? (
        <Tooltip content={docErrorText(doc.error)} side="top">
          {badge}
        </Tooltip>
      ) : (
        badge
      );
    }
    if (doc.status === "PROCESSING") {
      return (
        <span
          className={cn(
            "rounded-full bg-bg-tertiary px-2 py-0.5 text-text-muted text-xs",
            { "animate-pulse": true },
          )}
        >
          {t("knowledge.docStatus.PROCESSING", "Processing...")}
        </span>
      );
    }
    if (doc.status === "UNINDEXED") {
      // Imported-but-never-indexed: a deliberate waiting state (warning tint), not an error (no red).
      // While the workspace is blocked it is NOT merely waiting — nothing the operator does on this
      // screen will index it until a credential is sorted out — so the badge says which of the two
      // this is (issue #80) instead of reading identically in both cases. Keyed off the CURRENT
      // block, so it stops saying "blocked" the moment the block is gone.
      const blockText = embeddingBlockText();
      const badge = (
        <span
          className={cn(
            "rounded-full bg-warning-soft px-2 py-0.5 text-warning text-xs",
            {
              "cursor-help underline decoration-dotted underline-offset-2":
                !!blockText,
            },
          )}
        >
          {blockText
            ? t("knowledge.docStatus.UNINDEXED_BLOCKED", "Not indexed: blocked")
            : t("knowledge.docStatus.UNINDEXED", "Not indexed")}
        </span>
      );
      return blockText ? (
        <Tooltip content={blockText} side="top">
          {badge}
        </Tooltip>
      ) : (
        badge
      );
    }
    return (
      <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-muted text-xs">
        {t("knowledge.docStatus.PENDING", "Pending")}
      </span>
    );
  }

  function sourceIcon(doc: KnowledgeDoc) {
    if (doc.sourceType === "file")
      return (
        <FileText className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
      );
    if (doc.sourceType === "approval")
      return (
        <ClipboardCheck
          className="h-3.5 w-3.5 text-text-muted"
          aria-hidden="true"
        />
      );
    return <Type className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />;
  }

  const addContentValid =
    addTab === "texto"
      ? text.trim() !== ""
      : picked.some((p) => p.status !== "done");

  const modals = (
    <>
      {/* Create KB modal */}
      <Modal
        modal={createModal}
        unsavedChanges={createDirty}
        title={t("knowledge.addTitle", "New knowledge base")}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={busy} />
            <Button onClick={create} loading={busy} disabled={!name.trim()}>
              {t("common.create", "Create")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t("knowledge.name", "Name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("knowledge.description", "Description")}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </FormField>
          <FormField
            label={t("knowledge.chunkSize", "Chunk size (chars)")}
            hint={t(
              "knowledge.chunkSizeHint",
              "Controls how large each indexed text chunk is. Smaller chunks give more precision; larger chunks preserve more context.",
            )}
            error={chunkSizeError}
          >
            <Input
              type="number"
              min={100}
              max={8000}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
            />
          </FormField>
          <FormField
            label={t("knowledge.chunkOverlap", "Overlap (chars)")}
            hint={t(
              "knowledge.chunkOverlapHint",
              "Number of characters shared between consecutive chunks. Helps preserve context across chunk boundaries.",
            )}
            error={chunkOverlapError}
          >
            <Input
              type="number"
              min={0}
              max={Math.floor(chunkSize / 2)}
              value={chunkOverlap}
              onChange={(e) => setChunkOverlap(Number(e.target.value))}
            />
          </FormField>
        </div>
      </Modal>

      {/* Edit KB modal */}
      <Modal
        modal={editModal}
        unsavedChanges={editDirty}
        title={t("knowledge.editTitle", "Edit knowledge base")}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={busy} />
            <Button onClick={saveEdit} loading={busy} disabled={!name.trim()}>
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t("knowledge.name", "Name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label={t("knowledge.description", "Description")}>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </FormField>
          <FormField
            label={t("knowledge.chunkSize", "Chunk size (chars)")}
            hint={t(
              "knowledge.chunkSizeHint",
              "Controls how large each indexed text chunk is. Smaller chunks give more precision; larger chunks preserve more context.",
            )}
            error={chunkSizeError}
          >
            <Input
              type="number"
              min={100}
              max={8000}
              value={chunkSize}
              onChange={(e) => setChunkSize(Number(e.target.value))}
            />
          </FormField>
          <FormField
            label={t("knowledge.chunkOverlap", "Overlap (chars)")}
            hint={t(
              "knowledge.chunkOverlapHint",
              "Number of characters shared between consecutive chunks. Helps preserve context across chunk boundaries.",
            )}
            error={chunkOverlapError}
          >
            <Input
              type="number"
              min={0}
              max={Math.floor(chunkSize / 2)}
              value={chunkOverlap}
              onChange={(e) => setChunkOverlap(Number(e.target.value))}
            />
          </FormField>
        </div>
      </Modal>

      {/* Add-content modal (stacked over the documents list; opened from its "+Adicionar" button) */}
      <Modal
        modal={addContentModal}
        size="lg"
        unsavedChanges={addContentDirty}
        title={t("knowledge.addContentTitle", "Add content to {{name}}", {
          name: addContentModal.payload?.name ?? "",
        })}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={busy} />
            <Button
              onClick={addTab === "texto" ? addText : addFilesContent}
              loading={busy}
              disabled={!addContentValid}
            >
              {t("knowledge.addContentAction", "Add")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Tabs
            items={ADD_TABS}
            value={addTab}
            onChange={setAddTab}
            aria-label={t("knowledge.addContent", "Add content")}
          />
          {addTab === "texto" && (
            <div className="flex flex-col gap-4">
              <FormField label={t("knowledge.docTitle", "Title")}>
                <Input
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                />
              </FormField>
              <FormField label={t("knowledge.text", "Text")} required>
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                />
              </FormField>
            </div>
          )}
          {addTab === "arquivo" && (
            <div className="flex flex-col gap-4">
              <FormField
                label={t("knowledge.fileLabel", "File")}
                required
                group
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.md,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const list = Array.from(e.target.files ?? []);
                    if (list.length) addFiles(list);
                    // NOTE: reset so the same file(s) can be re-selected after removing
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    dragCounterRef.current += 1;
                    setDragOver(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                  }}
                  onDragLeave={() => {
                    dragCounterRef.current -= 1;
                    if (dragCounterRef.current <= 0) {
                      dragCounterRef.current = 0;
                      setDragOver(false);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dragCounterRef.current = 0;
                    setDragOver(false);
                    const dropped = Array.from(e.dataTransfer.files);
                    if (dropped.length) addFiles(dropped);
                  }}
                  className={cn(
                    "flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed py-8 text-center transition-colors",
                    {
                      "border-accent bg-accent/10": dragOver,
                      "border-border bg-bg-secondary hover:bg-bg-tertiary":
                        !dragOver,
                    },
                  )}
                  aria-label={t("knowledge.fileLabel", "File")}
                >
                  <Upload
                    className={cn("h-8 w-8", {
                      "text-accent": dragOver,
                      "text-text-muted": !dragOver,
                    })}
                    aria-hidden="true"
                  />
                  <span
                    className={cn("font-medium text-sm", {
                      "text-accent": dragOver,
                      "text-text-primary": !dragOver,
                    })}
                  >
                    {t(
                      "knowledge.dropHint",
                      "Drag and drop files here, or click to choose",
                    )}
                  </span>
                  <span className="text-text-muted text-xs">
                    {t("knowledge.fileHint", "PDF, DOCX, TXT, MD, CSV")}
                  </span>
                </button>
              </FormField>

              {picked.length > 0 && (
                <ul className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto">
                  {picked.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm"
                    >
                      <FileText
                        className="h-4 w-4 shrink-0 text-text-muted"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-text-primary">
                        {p.file.name}{" "}
                        <span className="text-text-muted text-xs">
                          {t("knowledge.fileSize", "({{kb}} KB)", {
                            kb: (p.file.size / 1024).toFixed(1),
                          })}
                        </span>
                      </span>
                      {p.status === "uploading" && (
                        <Loader2
                          className="h-4 w-4 shrink-0 animate-spin text-text-muted"
                          aria-label={t("knowledge.uploading", "Uploading…")}
                        />
                      )}
                      {p.status === "done" && (
                        <Check
                          className="h-4 w-4 shrink-0 text-success"
                          aria-label={t("knowledge.uploadQueued", "Queued")}
                        />
                      )}
                      {p.status === "error" && (
                        <Tooltip
                          content={uploadErrorMessage(
                            p.errorStatus,
                            p.errorMessage,
                          )}
                          side="top"
                        >
                          <span className="shrink-0 cursor-help rounded-full bg-error/10 px-2 py-0.5 text-error text-xs">
                            {t("knowledge.uploadFailed", "Failed")}
                          </span>
                        </Tooltip>
                      )}
                      {(p.status === "idle" || p.status === "error") && (
                        <button
                          type="button"
                          aria-label={t("knowledge.clearFile", "Clear file")}
                          onClick={() => removeFile(p.id)}
                          className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {picked.length === 1 ? (
                <FormField label={t("knowledge.docTitle", "Title")}>
                  <Input
                    value={docTitle}
                    onChange={(e) => setDocTitle(e.target.value)}
                  />
                </FormField>
              ) : picked.length > 1 ? (
                <p className="text-text-muted text-xs">
                  {t(
                    "knowledge.batchTitleHint",
                    "Each file keeps its own name as the document title.",
                  )}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </Modal>

      {/* Documents modal (list; "+Adicionar" opens the add-content modal stacked on top) */}
      <Modal
        modal={docsModal}
        size="lg"
        title={
          docs !== null
            ? t(
                "knowledge.documentsTitleWithCount",
                "Documents in {{name}} ({{count}})",
                {
                  name: docsModal.payload?.name ?? "",
                  count: docs.length,
                },
              )
            : t("knowledge.documentsTitle", "Documents in {{name}}", {
                name: docsModal.payload?.name ?? "",
              })
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (docsModal.payload) addContentModal.open(docsModal.payload);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("knowledge.addContentAction", "Add")}
            </Button>
          </div>
          {docs === null ? (
            <div className="flex flex-col gap-2" role="status">
              <span className="sr-only">{t("common.loading", "Loading…")}</span>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : docs.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t("knowledge.noDocs", "No documents yet.")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {docs.some((d) => d.status === "UNINDEXED") && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning bg-warning-soft px-3 py-2">
                  <span className="text-text-secondary text-xs">
                    {embeddingBlockText() ??
                      t(
                        "knowledge.unindexedNote",
                        "Some documents aren't indexed yet and won't be searchable until you index them.",
                      )}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (docsModal.payload) {
                        void indexAllUnindexed(docsModal.payload.id);
                      }
                    }}
                  >
                    {t("knowledge.indexAll", "Index all ({{n}})", {
                      n: docs.filter((d) => d.status === "UNINDEXED").length,
                    })}
                  </Button>
                </div>
              )}
              <ul className="flex max-h-[55vh] flex-col gap-2 overflow-y-auto">
                {docs.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-text-primary">
                          {d.title}
                        </span>
                        {d.fileName && (
                          <span className="break-all text-text-muted text-xs">
                            {d.fileName}
                          </span>
                        )}
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="flex shrink-0 items-center gap-1 text-text-muted text-xs">
                            {sourceIcon(d)}
                          </span>
                          {d.contentChars != null && (
                            <span className="text-text-muted text-xs">
                              {t("knowledge.charCount", "{{n}} characters", {
                                n: new Intl.NumberFormat(i18n.language).format(
                                  Number(d.contentChars),
                                ),
                              })}
                            </span>
                          )}
                          {docStatusBadge(d)}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            docPreviewModal.open({ id: d.id, title: d.title })
                          }
                          aria-label={t(
                            "knowledge.viewContent",
                            "View content",
                          )}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        {opts.allowDocumentEdits && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() =>
                              docEditModal.open({ id: d.id, title: d.title })
                            }
                            aria-label={t("common.edit", "Edit")}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                        {(d.status === "FAILED" ||
                          d.status === "UNINDEXED") && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => retryDoc(d)}
                            aria-label={
                              d.status === "UNINDEXED"
                                ? t("knowledge.index", "Index")
                                : t("knowledge.retry", "Retry")
                            }
                          >
                            {d.status === "UNINDEXED" ? (
                              <Play className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <RefreshCw
                                className="h-4 w-4"
                                aria-hidden="true"
                              />
                            )}
                          </Button>
                        )}
                        {opts.allowDocumentEdits && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => askDeleteDoc(d)}
                            aria-label={t("common.delete", "Delete")}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Modal>

      {/* Doc preview modal */}
      <Modal
        modal={docPreviewModal}
        size="lg"
        title={t("knowledge.previewTitle", "Content: {{title}}", {
          title: docPreviewModal.payload?.title ?? "",
        })}
      >
        {docPreviewLoading ? (
          <div className="flex flex-col gap-2" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
        ) : (
          <>
            {docPreview != null && (
              <p className="mb-2 text-text-muted text-xs">
                {t("knowledge.charCount", "{{n}} characters", {
                  n: new Intl.NumberFormat(i18n.language).format(
                    docPreview.length,
                  ),
                })}
              </p>
            )}
            <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap text-sm text-text-secondary">
              {docPreview ?? ""}
            </pre>
          </>
        )}
      </Modal>

      {/* Edit document modal */}
      <Modal
        modal={docEditModal}
        size="lg"
        unsavedChanges={editDocDirty}
        title={t("knowledge.docEditTitle", "Edit: {{title}}", {
          title: docEditModal.payload?.title ?? "",
        })}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={busy} />
            <Button
              onClick={saveDocEdit}
              loading={busy}
              disabled={
                editDocLoading ||
                !editDocTitle.trim() ||
                !editDocText.trim() ||
                !editDocDirty
              }
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        {editDocLoading ? (
          <div className="flex flex-col gap-2" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <FormField label={t("knowledge.docTitleLabel", "Title")} required>
              <Input
                value={editDocTitle}
                onChange={(e) => setEditDocTitle(e.target.value)}
              />
            </FormField>
            <FormField
              label={t("knowledge.docContentLabel", "Content")}
              required
              hint={t(
                "knowledge.docEditHint",
                "Editing the content re-indexes the document (it is re-embedded).",
              )}
            >
              <Textarea
                value={editDocText}
                onChange={(e) => setEditDocText(e.target.value)}
                rows={12}
              />
            </FormField>
          </div>
        )}
      </Modal>

      <ConfirmDialog modal={confirm} />
    </>
  );

  return {
    openCreate: () => createModal.open(),
    openEdit: (base: Base) => editModal.open(base),
    openEditById,
    openDocs,
    openDocPreview: (doc) => docPreviewModal.open(doc),
    askDelete,
    modals,
  };
}
