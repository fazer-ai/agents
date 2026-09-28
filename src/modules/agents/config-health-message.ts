import type { ConfigIssue } from "@/modules/agents/config-health";

// The sentence for one configuration warning, for the console and the server alike: which catalog
// entry an issue reads and what is interpolated into it. Translation is injected, since the console has
// a live i18next instance and the server resolves the same catalogs without one.

export interface ConfigIssueMessageDeps {
  // (key, English fallback, interpolation values) → the sentence. Matches i18next's `t`, so the
  // console passes its own `t` straight in.
  translate: (
    key: string,
    defaultValue: string,
    params?: Record<string, string | number>,
  ) => string;
  // The guardrail-health window this reading covers, and the vendor's own words on the last failed
  // check. Neither is a property of the issue: they come back with the health snapshot, and the
  // issue carries only the count and the timestamp.
  guardrailWindowHours?: number;
  guardrailLastError?: string;
  // How a timestamp is rendered for this reader. The console says "3 hours ago" in the operator's
  // language; a caller reading JSON wants the instant. Absent → the raw value.
  formatWhen?: (iso: string) => string;
}

export function configIssueMessage(
  issue: ConfigIssue,
  deps: ConfigIssueMessageDeps,
): string {
  const t = deps.translate;
  // Text already in the row, over its cap: whatever passes the cap is dropped by the reader, which
  // is invisible everywhere else. The message stops at that, without claiming the model receives
  // the rest — with the section switched off it receives none of it. When the field has no control
  // in the editor the message says so, instead of leaving the operator hunting for a tab.
  if (issue.key === "textCap") {
    const params = {
      field: issue.field ?? "",
      len: issue.length ?? 0,
      max: issue.max ?? 0,
    };
    return issue.tab
      ? t(
          "editor.configIssueTextCap",
          "{{field}} holds {{len}} characters and the limit is {{max}}: everything past that is ignored.",
          params,
        )
      : t(
          "editor.configIssueTextCapNoField",
          "{{field}} holds {{len}} characters and the limit is {{max}}: everything past that is ignored. This note has no field in the console, so it can only be shortened through the API.",
          params,
        );
  }
  if (issue.key === "knowledge") {
    return t(
      "editor.configIssueKnowledge",
      'Knowledge base "{{name}}" has documents that need indexing.',
      { name: issue.knowledgeBaseName ?? "" },
    );
  }
  // A guardrail that HAS its credential and still could not run. The count is the whole point: the
  // panel's other lines describe a state ("no key set"), this one describes what already happened,
  // and an operator has to be told that those turns went out unscreened rather than blocked.
  if (issue.key === "guardrailsFailing") {
    const params = {
      failures: issue.failures ?? 0,
      hours: deps.guardrailWindowHours ?? 24,
      when: issue.lastFailureAt
        ? (deps.formatWhen?.(issue.lastFailureAt) ?? issue.lastFailureAt)
        : "-",
      error: deps.guardrailLastError ?? "",
    };
    // NOTE: The vendor's own words when they survived the write, since they name the setting. The
    // sentence claims only what a failure row proves: that one check caught and held back nothing,
    // not that the message went out unscreened (the other check may still have screened it).
    return params.error
      ? t(
          "editor.configIssueGuardrailsFailingCause",
          "Guardrails are on, but {{failures}} of the Checks could not run in the last {{hours}} hours (the most recent {{when}}). A check that could not run caught nothing and held nothing back. The last one said: {{error}}",
          params,
        )
      : t(
          "editor.configIssueGuardrailsFailing",
          "Guardrails are on, but {{failures}} of the Checks could not run in the last {{hours}} hours (the most recent {{when}}). A check that could not run caught nothing and held nothing back. Check “Guardrails model”, “Base URL” and “API key”.",
          params,
        );
  }
  // Two out-of-hours messages on one inbox, or one announcing a closure the other serves through.
  // The inboxes are NAMED, not counted: half of every fix is on Chatwoot's screen, and "two of
  // your inboxes" does not tell anyone which two to open there.
  if (issue.key === "outOfHoursBoth" || issue.key === "outOfHoursChatwoot") {
    const inboxes = (issue.inboxNames ?? []).join(", ");
    return issue.key === "outOfHoursBoth"
      ? t(
          "editor.configIssueOutOfHoursBoth",
          "Chatwoot and this agent both send out-of-hours messages on {{inboxes}}, so the customer receives both. Their schedules are configured separately, and Chatwoot's has no dates; they also conflict on holidays.",
          { inboxes },
        )
      : t(
          "editor.configIssueOutOfHoursChatwoot",
          "Chatwoot sends an out-of-hours message on {{inboxes}}, but this agent follows only its own schedule. The customer can be told the business is closed and receive service moments later.",
          { inboxes },
        );
  }
  if (issue.pending) {
    return t(
      `editor.configIssuePending.${issue.key}`,
      "This credential is referenced but not filled in yet.",
    );
  }
  if (issue.unresolved) {
    return t(
      `editor.configIssueUnresolved.${issue.key}`,
      "This credential no longer exists. Pick another one.",
    );
  }
  // NOTE: The credential is there and filled, but its TYPE cannot serve this field: the fix is to pick
  // another entry, not to fill this one in.
  if (issue.wrongKind) {
    return t(
      `editor.configIssueWrongKind.${issue.key}`,
      "This credential's type cannot be used here. Pick one that holds a single API key.",
    );
  }
  return t(
    `editor.configIssue.${issue.key}`,
    "This feature is enabled but has no credential set.",
  );
}
