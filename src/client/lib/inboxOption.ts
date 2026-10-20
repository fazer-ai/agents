import type { TFunction } from "i18next";

// An inbox as the filter-options endpoint gives it: `account` only on an inbox whose name another
// inbox of the tenant also has (two connected Chatwoot accounts with a "SAC WhatsApp" each).
export interface InboxOption {
  id: string;
  name: string;
  account?: { id: number; name: string | null };
}

// How an inbox picker names an option: the name, and beside it the account when the name repeats,
// as the Dashboards panels name their rows ("Account 7" while the account's name has not synced).
export function inboxOptionLabel(inbox: InboxOption, t: TFunction): string {
  if (!inbox.account) return inbox.name;
  const account =
    inbox.account.name ??
    t("dashboards.accountNumber", "Account {{id}}", { id: inbox.account.id });
  return `${inbox.name} · ${account}`;
}
