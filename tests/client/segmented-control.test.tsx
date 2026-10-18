/// <reference lib="dom" />

// The segmented control is as wide as its options, wherever it sits. Inside a flex column (every
// FormField) an item is stretched to the column's width whatever its `display`, so `inline-flex`
// alone drew the pill to the form's edge with empty track after the options. The width has to be the
// component's own, not each caller's: the suite has no layout engine to catch a caller that forgets.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { FormField, SegmentedControl } from "@/client/components";

afterEach(cleanup);

test("the pill sizes to its options, even as the child of a stretching column", () => {
  render(
    <div className="flex flex-col">
      <FormField label="Data" group>
        <SegmentedControl
          value="a"
          onChange={() => {}}
          aria-label="Data"
          options={[
            { value: "a", label: "Conversations" },
            { value: "b", label: "AI usage" },
          ]}
        />
      </FormField>
    </div>,
  );
  const pill = screen.getByRole("radiogroup", { name: "Data" });
  const classes = pill.className.split(/\s+/);
  expect(classes).toContain("w-fit");
  expect(classes).toContain("max-w-full");
  expect(classes).not.toContain("w-full");
});
