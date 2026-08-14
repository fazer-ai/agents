/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

interface MockConversation {
  id: string;
  threadId: string;
  chatwootConversationId: number;
  status: string;
  assigneeId: number | null;
  assigneeType: string | null;
  assigneeName: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  inbox: { id: string; name: string } | null;
  contact: { name: string | null } | null;
  agentName: string | null;
  outOfHours: boolean;
}

interface MockPageResult {
  data: {
    instance: { id: string; name: string };
    conversations: MockConversation[];
    nextCursor: string | null;
  };
  error: null;
}

const emptyPage: MockPageResult = {
  data: {
    instance: { id: "test", name: "test" },
    conversations: [],
    nextCursor: null,
  },
  error: null,
};

const mockGetConversations = mock(
  async (_request: unknown): Promise<MockPageResult> => emptyPage,
);

mock.module("@/client/lib/api", () => ({
  api: {
    api: {
      v1: {
        conversations: { get: mockGetConversations },
      },
    },
  },
}));

mock.module("@/client/hooks/useTenantEvents", () => ({
  useTenantEvents: () => {},
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useThemedAsset: (path: string) => ({ src: path }),
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: "en" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const { ConversationsPage } = await import("@/client/pages/ConversationsPage");

describe("ConversationsPage group projection", () => {
  beforeEach(() => {
    mockGetConversations.mockClear();
    mockGetConversations.mockImplementation(async () => emptyPage);
  });

  afterEach(() => {
    cleanup();
  });

  test("excludes groups on the initial web request", async () => {
    render(
      <MemoryRouter>
        <ConversationsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(mockGetConversations).toHaveBeenCalled());
    expect(mockGetConversations.mock.calls[0]?.[0]).toEqual({
      query: { excludeGroups: true },
    });
  });

  test("keeps group exclusion when loading the next page", async () => {
    mockGetConversations.mockResolvedValueOnce({
      data: {
        instance: { id: "test", name: "test" },
        conversations: [
          {
            id: "1",
            threadId: "1:1:1",
            chatwootConversationId: 1,
            status: "pending",
            assigneeId: null,
            assigneeType: "AgentBot",
            assigneeName: null,
            lastEventAt: "2026-08-14T12:00:00.000Z",
            lastError: null,
            lastErrorAt: null,
            inbox: { id: "1", name: "Support" },
            contact: { name: "Alice" },
            agentName: "Julia",
            outOfHours: false,
          },
        ],
        nextCursor: "cursor-1",
      },
      error: null,
    });

    render(
      <MemoryRouter>
        <ConversationsPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() => expect(mockGetConversations).toHaveBeenCalledTimes(2));
    expect(mockGetConversations.mock.calls[1]?.[0]).toEqual({
      query: {
        cursor: "cursor-1",
        excludeGroups: true,
      },
    });
  });
});
