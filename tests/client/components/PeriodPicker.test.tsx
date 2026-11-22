import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { PeriodPicker } from "@/client/components";
import { withI18n } from "@/tests/utils/i18n";

// THE PERIOD BUTTON ON ITS OWN, in Portuguese: typing reaches an option whatever its accents, as a
// native select does.

afterEach(cleanup);

const groups = [
  {
    label: "Calendário",
    options: [
      { value: "today", label: "Hoje" },
      { value: "this-month", label: "Este mês" },
    ],
  },
  {
    label: "Janela móvel",
    options: [
      { value: "7d", label: "Últimos 7 dias" },
      { value: "30d", label: "Últimos 30 dias" },
      { value: "90d", label: "Últimos 90 dias" },
    ],
  },
];

describe("typing in the presets", () => {
  test("a plain letter reaches an accented label, and repeating it steps through them", async () => {
    render(
      withI18n(
        <PeriodPicker
          value="this-month"
          label="Este mês"
          dates={null}
          compareShort={null}
          compareFull={null}
          progress={null}
          dayText={null}
          groups={groups}
          onSelect={() => {}}
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /Este mês/ }));
    const focused = () => document.activeElement?.getAttribute("data-value");
    await waitFor(() => expect(focused()).toBe("this-month"));
    const type = (k: string) =>
      fireEvent.keyDown(document.activeElement as Element, { key: k });
    type("u");
    expect(focused()).toBe("7d");
    type("u");
    expect(focused()).toBe("30d");
    type("u");
    expect(focused()).toBe("90d");
  });
});
