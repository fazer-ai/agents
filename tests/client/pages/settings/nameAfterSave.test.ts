import { describe, expect, test } from "bun:test";
import { nameAfterSave } from "@/client/pages/settings/SettingsProfilePage";

describe("nameAfterSave", () => {
  test("normalizes the field to the saved value when it still holds the submission", () => {
    expect(nameAfterSave("  Bob ", "Bob", "Bob")).toBe("Bob");
  });

  test("keeps an edit typed while the save was in flight", () => {
    expect(nameAfterSave("Charlie", "Bob", "Bob")).toBe("Charlie");
  });

  test("shows the cleared name as empty", () => {
    expect(nameAfterSave("   ", "", "")).toBe("");
  });
});
