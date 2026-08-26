import { useTranslation } from "react-i18next";

export type CredentialTestState =
  | { kind: "ok" }
  | { kind: "fail"; code: string; status?: number }
  | null;

// Renders the localized outcome of a credential connectivity test (POST /v1/vault[/:name]/test).
// Kept as a single component so the literal t() calls (which the i18n extractor + lint require) live
// in one place — shared by CredentialForm and CredentialPicker.
export function CredentialTestResult({
  result,
}: {
  result: CredentialTestState;
}) {
  const { t } = useTranslation();
  if (!result) return null;
  if (result.kind === "ok") {
    return (
      <span className="text-sm text-success">
        {t("vault.testOk", "Connection OK.")}
      </span>
    );
  }
  const { code, status } = result;
  let message: string;
  switch (code) {
    case "unauthorized":
    case "forbidden":
      message = t(
        "vault.testFail.unauthorized",
        "The service rejected the credential.",
      );
      break;
    case "http_error":
      message = t(
        "vault.testFail.httpError",
        "The service responded with an error (HTTP {{status}}).",
        { status: status ?? 0 },
      );
      break;
    case "timeout":
      message = t("vault.testFail.timeout", "The test timed out.");
      break;
    case "blocked_url":
      message = t(
        "vault.testFail.blockedUrl",
        "Blocked URL (internal addresses are not allowed).",
      );
      break;
    case "surrounding_whitespace":
      message = t(
        "vault.testFail.surroundingWhitespace",
        "The value begins or ends with a space or line break. Remove it before testing.",
      );
      break;
    case "missing_base_url":
      message = t(
        "vault.testFail.missingBaseUrl",
        "Enter the base URL to test.",
      );
      break;
    default:
      message = t("vault.testFail.unreachable", "Could not reach the service.");
  }
  return <span className="text-error text-sm">{message}</span>;
}
