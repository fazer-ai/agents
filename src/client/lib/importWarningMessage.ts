import type { TFunction } from "i18next";
import { importWarningCount } from "@/client/lib/importWarningCount";
import type { ImportWarningCode } from "@/modules/agents/import-warning-codes";

/**
 * Localized text for a structured import warning. Static keys (one per code) keep it extract-safe;
 * params interpolate the names and counts. The switch is exhaustive over `ImportWarningCode`, so a code
 * added to the list without its sentence does not type-check; at runtime an unknown code (a newer
 * server during a rolling deploy) renders as the bare code.
 */
export function importWarningMessage(
  w: { code: ImportWarningCode; params?: Record<string, string | number> },
  t: TFunction,
): string {
  const p = w.params ?? {};
  switch (w.code) {
    case "guidanceClipped":
      return t(
        "editor.importWarning.guidanceClipped",
        'The text in "{{field}}" was longer than {{max}} characters and was trimmed on import.',
        p,
      );
    // NOTE: What create would have refused, taken out so the default applies. Named by path, like
    // guidanceClipped: the bundle may hold several, and the path is what says where to look.
    case "settingsValueDropped":
      return t(
        "editor.importWarning.settingsValueDropped",
        'The value in "{{field}}" is not one this agent can use, so it was left out on import and the default applies.',
        p,
      );
    case "settingsValuesDroppedMore":
      return t(
        "editor.importWarning.settingsValuesDroppedMore",
        "{{count}} more settings values this agent cannot use were left out on import.",
        { ...p, count: importWarningCount(p) },
      );
    case "promptToolRenamed":
      return t(
        "editor.importWarning.promptToolRenamed",
        'The prompt named a tool that was renamed, so {{count}} mentions now say "{{name}}". Worth a read.',
        { ...p, count: importWarningCount(p) },
      );
    case "protectedLabelsClipped":
      return t(
        "editor.importWarning.protectedLabelsClipped",
        "The bundle carried more than {{max}} labels out of reach, so {{count}} of them were dropped on import.",
        { ...p, count: importWarningCount(p) },
      );
    case "allowedLabelsClipped":
      return t(
        "editor.importWarning.allowedLabelsClipped",
        "The bundle carried more than {{max}} labels the agent may add, so {{count}} of them were dropped on import.",
        { ...p, count: importWarningCount(p) },
      );
    case "otherInboxesCleared":
      return t(
        "editor.importWarning.otherInboxesCleared",
        "The inboxes this agent read for a contact's other conversations belong to the installation the bundle came from, so the selection was cleared and the feature turned off. Pick the inboxes here to turn it back on.",
      );
    case "credentialNotFound":
      return t(
        "editor.importWarning.credentialNotFound",
        'Credential "{{name}}" was not found here, so it was left unset.',
        p,
      );
    case "credentialPending":
      return t(
        "editor.importWarning.credentialPending",
        'Credential "{{name}}" was not found here, so a placeholder was created. Fill in its secret to activate it.',
        p,
      );
    // NOTE: The entry was found and wired; what does not fit is the PAIRING. Named by field rather
    // than by credential name, unlike the four around it: the same credential can be right on one
    // field and wrong on the next, so the name alone would not say where to look.
    case "credentialKindUnusable":
      return t(
        "editor.importWarning.credentialKindUnusable",
        'The credential wired to "{{field}}" is a "{{kind}}" credential, which that field cannot use. It was left wired so you can see it; pick another one there.',
        p,
      );
    case "credentialMissingMeta":
      return t(
        "editor.importWarning.credentialMissingMeta",
        'Credential "{{name}}" is missing from the export metadata, so it was left unset.',
        p,
      );
    case "credentialAmbiguous":
      return t(
        "editor.importWarning.credentialAmbiguous",
        'Credential "{{name}}" appears with more than one type in the export, so it was left unset.',
        p,
      );
    case "hoursNotFound":
      return t(
        "editor.importWarning.hoursNotFound",
        'Business hours "{{name}}" were not found here, so they were left unset.',
        p,
      );
    case "hoursReused":
      return t(
        "editor.importWarning.hoursReused",
        'Business hours "{{name}}" already existed and were reused; check the schedule is right.',
        p,
      );
    // NOTE: `importWarningCount` is the other half of the rolling-deploy overlap (see `transfer.ts`):
    // it reads the count under either name, because an editor from THIS release can reach a
    // container from the previous one, which sends `n` only. The four counters below hand `count` in
    // as a LITERAL property next to the spread on purpose: `i18next-parser` reads the call site, so a
    // shared helper would leave it seeing only the spread and, with `keepRemoved: false`, delete the
    // plural forms on the next `i18n:extract`.
    case "hoursWindowsDropped":
      return t(
        "editor.importWarning.hoursWindowsDropped",
        'Business hours "{{name}}": {{count}} weekly windows were not stored as written. Open the schedule and check the days are right.',
        { ...p, count: importWarningCount(p) },
      );
    case "hoursExceptionsDropped":
      return t(
        "editor.importWarning.hoursExceptionsDropped",
        'Business hours "{{name}}": {{count}} date exceptions were not stored as written. Open the schedule and check the holidays and closures are right.',
        { ...p, count: importWarningCount(p) },
      );
    case "httpToolBodyIgnored":
      return t(
        "editor.importWarning.httpToolBodyIgnored",
        'Tool "{{name}}" had a request body in a shape this version does not accept, so it was reduced to the part that was actually being sent. The request is unchanged; open it under Body to check it.',
        p,
      );
    case "httpToolMethodUnsupported":
      return t(
        "editor.importWarning.httpToolMethodUnsupported",
        'Tool "{{name}}" asks for the HTTP method {{method}}, which is not one this platform sends, so the tool was not imported. The rest of the agent was.',
        p,
      );
    case "httpToolUrlTemplateUnusable":
      return t(
        "editor.importWarning.httpToolUrlTemplateUnusable",
        'Tool "{{name}}" has a request URL this platform cannot call, so the tool was not imported. The rest of the agent was.',
        p,
      );
    case "knowledgeSourceUnusable":
      return t(
        "editor.importWarning.knowledgeSourceUnusable",
        'Knowledge base "{{name}}" was imported without its help center source, which this platform cannot store. Set the source again on the base.',
        p,
      );
    case "knowledgeBaseNameUnusable":
      return t(
        "editor.importWarning.knowledgeBaseNameUnusable",
        'Knowledge base "{{name}}" has a name this platform cannot store, so it was not imported. The rest of the agent was.',
        p,
      );
    case "httpToolReused":
      return t(
        "editor.importWarning.httpToolReused",
        'Tool "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "httpToolRenamed":
      return t(
        "editor.importWarning.httpToolRenamed",
        'Tool "{{name}}" carries the name of a built-in tool, so it was imported as "{{renamed}}"; a prompt that names it must follow.',
        p,
      );
    case "httpToolCredNotFound":
      return t(
        "editor.importWarning.httpToolCredNotFound",
        'Tool "{{tool}}" credential "{{credential}}" was not found here, so it was left unset.',
        p,
      );
    case "httpToolConversationRefNotFound":
      return t(
        "editor.importWarning.httpToolConversationRefNotFound",
        'Tool "{{tool}}" hands the conversation reference to the generic webhook "{{integration}}", which was not found here, so the tool will refuse to run until one is chosen.',
        p,
      );
    case "mcpReused":
      return t(
        "editor.importWarning.mcpReused",
        'MCP server "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "mcpUnsafeStdio":
      return t(
        "editor.importWarning.mcpUnsafeStdio",
        'MCP server "{{name}}" has an unsupported command and was skipped.',
        p,
      );
    case "mcpInvalidHeaders":
      return t(
        "editor.importWarning.mcpInvalidHeaders",
        'MCP server "{{name}}" declares headers this server does not accept and was skipped.',
        p,
      );
    case "integrationUnknownType":
      return t(
        "editor.importWarning.integrationUnknownType",
        'Integration "{{name}}" has an unknown type and was skipped.',
        p,
      );
    case "integrationReused":
      return t(
        "editor.importWarning.integrationReused",
        'Integration "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "kbReused":
      return t(
        "editor.importWarning.kbReused",
        'Knowledge base "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "kbReusedDocsSkipped":
      return t(
        "editor.importWarning.kbReusedDocsSkipped",
        'Knowledge base "{{name}}" already existed and was reused; its {{count}} bundled documents were not imported.',
        { ...p, count: importWarningCount(p) },
      );
    case "kbGrantNotFound":
      return t(
        "editor.importWarning.kbGrantNotFound",
        'Knowledge base "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    case "httpGrantNotFound":
      return t(
        "editor.importWarning.httpGrantNotFound",
        'Tool "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    // NOTE: Says WHY nothing was granted, which "not found" would not: the tools are there, and there
    // are too many of them for the name to mean one of them.
    case "httpToolAmbiguous":
      return t(
        "editor.importWarning.httpToolAmbiguous",
        '{{n}} tools here already answer to the name "{{name}}", so the bundled tool was not imported. Rename them apart and import again.',
        p,
      );
    case "codeToolAmbiguous":
      return t(
        "editor.importWarning.codeToolAmbiguous",
        '{{n}} code tools here already answer to the name "{{name}}", so the bundled tool was not imported. Rename them apart and import again.',
        p,
      );
    case "httpGrantAmbiguous":
      return t(
        "editor.importWarning.httpGrantAmbiguous",
        '{{n}} tools here answer to the name "{{name}}", so the grant was skipped rather than bound to one of them. Rename them apart and grant it by hand.',
        p,
      );
    case "codeGrantAmbiguous":
      return t(
        "editor.importWarning.codeGrantAmbiguous",
        '{{n}} code tools here answer to the name "{{name}}", so the grant was skipped rather than bound to one of them. Rename them apart and grant it by hand.',
        p,
      );
    case "mcpGrantNotFound":
      return t(
        "editor.importWarning.mcpGrantNotFound",
        'MCP server "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    case "unknownGrantSourceSkipped":
      return t(
        "editor.importWarning.unknownGrantSourceSkipped",
        "{{count}} tool grants came from a newer version and were skipped.",
        { ...p, count: importWarningCount(p) },
      );
    case "documentGrantNotFound":
      return t(
        "editor.importWarning.documentGrantNotFound",
        'Document template "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    case "documentTemplateReused":
      return t(
        "editor.importWarning.documentTemplateReused",
        'Document template "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "documentTemplateNameTaken":
      return t(
        "editor.importWarning.documentTemplateNameTaken",
        'Document template "{{name}}" was not imported: this account already has a template with that name ({{existing}}). Names have to be unique, because the agent picks between documents by name.',
        p,
      );
    case "codeToolBodyWarning":
      return t(
        "editor.importWarning.codeToolBodyWarning",
        'Code tool "{{name}}": the imported body has a problem — {{reason}}. It was saved as written and will fail when the agent calls it.',
        p,
      );
    case "toolSchemaAdjusted":
      return t(
        "editor.importWarning.toolSchemaAdjusted",
        'Tool "{{name}}": the imported input schema was adjusted — {{reason}}. Check the arguments the agent may send.',
        p,
      );
    case "documentToolNameTaken":
      return t(
        "editor.importWarning.documentToolNameTaken",
        'Document template "{{name}}" was not imported: the tool name {{tool}} it would publish is already used by the tool "{{holder}}". One name reaches the model, so one of the two would stop being callable.',
        p,
      );
    case "documentTemplateInvalid":
      return t(
        "editor.importWarning.documentTemplateInvalid",
        'Document template "{{name}}" could not be imported: {{reason}}',
        p,
      );
    case "integrationGrantNotFound":
      return t(
        "editor.importWarning.integrationGrantNotFound",
        'Integration "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    case "codeToolRenamed":
      return t(
        "editor.importWarning.codeToolRenamed",
        'Code tool "{{name}}" carries the name of a built-in tool, so it was imported as "{{renamed}}"; a prompt that names it must follow.',
        p,
      );
    case "codeToolReused":
      return t(
        "editor.importWarning.codeToolReused",
        'Code tool "{{name}}" already existed and was reused; check it is right.',
        p,
      );
    case "codeGrantNotFound":
      return t(
        "editor.importWarning.codeGrantNotFound",
        'Code tool "{{name}}" was not found, so its grant was skipped.',
        p,
      );
    case "nativeToolUnknown":
      return t(
        "editor.importWarning.nativeToolUnknown",
        'Built-in tool "{{name}}" is not one this version has, so it was left out of the agent.',
        p,
      );
    default: {
      const unrendered: never = w.code;
      return unrendered;
    }
  }
}
