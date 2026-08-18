// A Chatwoot that answers the two custom-attribute endpoints the way the DEPLOYED fork does.
//
// The semantics are not a convention picked here — they were MEASURED on 2026-08-18 with a
// rolled-back `rails runner` probe against the fork, running the controller's own two lines:
//
//   POST /conversations/{id}/custom_attributes  {produto:"A"} -> {produto:"A"}
//                                               {medida:"B"}  -> {medida:"B"}   (produto GONE)
//                                               {}            -> {}             (the /reset clear)
//
// The action is `@conversation.custom_attributes = params.permit(custom_attributes: {})[...]` plus
// `save!`, a plain assignment with no setter override on the model, and byte-identical in upstream
// Chatwoot. `PUT /contacts/{id}` assigns the same way. So BOTH endpoints REPLACE the whole hash.
//
// Shapes, read off the deployed jbuilders: `GET /conversations/{id}` renders the conversation
// partial, where `custom_attributes` is TOP-LEVEL; the contact payload nests it under `payload`.
export interface FakeChatwootRequest {
  method: string;
  path: string;
  token: string;
}

export interface FakeChatwootAttributeStore {
  fetchImpl: typeof fetch;
  conversations: Map<number, Record<string, unknown>>;
  contacts: Map<number, Record<string, unknown>>;
  requests: FakeChatwootRequest[];
}

export function fakeChatwootAttributeStore(
  accountId: number,
  initial?: {
    conversations?: Record<number, Record<string, unknown>>;
    contacts?: Record<number, Record<string, unknown>>;
  },
): FakeChatwootAttributeStore {
  const entries = (r?: Record<number, Record<string, unknown>>) =>
    Object.entries(r ?? {}).map(
      ([k, v]) => [Number(k), v] as [number, Record<string, unknown>],
    );
  const conversations = new Map(entries(initial?.conversations));
  const contacts = new Map(entries(initial?.contacts));
  const requests: FakeChatwootRequest[] = [];
  const bag = (m: Map<number, Record<string, unknown>>, id: number) =>
    m.get(id) ?? {};

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname.replace(
      `/api/v1/accounts/${accountId}`,
      "",
    );
    const body = init?.body
      ? (JSON.parse(init.body as string) as {
          custom_attributes?: Record<string, unknown>;
        })
      : undefined;
    requests.push({
      method,
      path,
      token:
        ((init?.headers ?? {}) as Record<string, string>)["api-access-token"] ??
        "",
    });
    const ok = (payload: unknown) =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(payload),
      }) as unknown as Response;

    let m = path.match(/^\/conversations\/(\d+)\/custom_attributes$/);
    if (m) {
      const id = Number(m[1]);
      conversations.set(id, { ...(body?.custom_attributes ?? {}) }); // REPLACE
      return ok({ custom_attributes: bag(conversations, id) });
    }
    m = path.match(/^\/conversations\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      return ok({ id, custom_attributes: bag(conversations, id) });
    }
    m = path.match(/^\/contacts\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === "PUT") {
        contacts.set(id, { ...(body?.custom_attributes ?? {}) }); // REPLACE
      }
      return ok({ payload: { custom_attributes: bag(contacts, id) } });
    }
    throw new Error(`fake Chatwoot: unrouted ${method} ${path}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, conversations, contacts, requests };
}
