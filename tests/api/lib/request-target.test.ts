import { describe, expect, test } from "bun:test";
import { loggedPath, loggedUrl } from "@/api/lib/request-target";

describe("loggedPath", () => {
  test.each([
    [
      "a credential parameter is masked",
      "/api/v1/chatwoot/webhook/tok3n",
      "/api/v1/chatwoot/webhook/:routeToken",
      "/api/v1/chatwoot/webhook/[redacted]",
    ],
    [
      "an id the route names is printed",
      "/api/v1/agents/7/playground/sessions/t1",
      "/api/v1/agents/:id/playground/sessions/:threadId",
      "/api/v1/agents/7/playground/sessions/t1",
    ],
    [
      "a name nobody classified is masked",
      "/x/abc",
      "/x/:somethingNew",
      "/x/[redacted]",
    ],
    [
      "an optional parameter is masked",
      "/x/abc",
      "/x/:secret?",
      "/x/[redacted]",
    ],
    [
      "a wildcard keeps what it matched",
      "/api/v1/chatwoot/webhook/tok3n",
      "/api/*",
      "/api/v1/chatwoot/webhook/tok3n",
    ],
    [
      "a trailing slash keeps its shape",
      "/api/v1/chatwoot/webhook/tok3n/",
      "/api/v1/chatwoot/webhook/:routeToken",
      "/api/v1/chatwoot/webhook/[redacted]/",
    ],
    [
      "an unmatched request is printed as sent",
      "/nope/tok3n",
      null,
      "/nope/tok3n",
    ],
  ])("%s", (_name, path, route, expected) => {
    expect(loggedPath(path, route)).toBe(expected);
  });
});

describe("loggedUrl", () => {
  test("keeps the origin and every query key, and masks every query value", () => {
    expect(
      loggedUrl(
        "https://agents.example/api/auth/invite?token=s3cret&lang=pt",
        "/api/auth/invite",
      ),
    ).toBe(
      "https://agents.example/api/auth/invite?token=[redacted]&lang=[redacted]",
    );
  });

  test("adds no query string when the request had none", () => {
    expect(
      loggedUrl(
        "http://localhost/api/v1/chatwoot/webhook/tok3n",
        "/api/v1/chatwoot/webhook/:routeToken",
      ),
    ).toBe("http://localhost/api/v1/chatwoot/webhook/[redacted]");
  });
});
