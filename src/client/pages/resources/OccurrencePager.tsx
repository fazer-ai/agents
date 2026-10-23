import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components";

// "21 to 40 of 57", with the previous and next page. `first` is the 1-based position of the page's
// first row; the page size is what the caller shows per page.
export function OccurrencePager({
  first,
  shown,
  total,
  onPrevious,
  onNext,
  hasNext,
  label,
}: {
  first: number;
  shown: number;
  total: number;
  onPrevious: (() => void) | null;
  onNext: () => void;
  hasNext: boolean;
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  if (total === 0) return null;
  return (
    <nav
      aria-label={label}
      className="flex flex-wrap items-center justify-between gap-2 text-sm text-text-muted"
    >
      <span>
        {t("occurrences.pager.range", "{{first}} to {{last}} of {{total}}", {
          first: nf.format(first),
          last: nf.format(first + shown - 1),
          total: nf.format(total),
        })}
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={onPrevious === null}
          onClick={() => onPrevious?.()}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {t("occurrences.pager.previous", "Previous")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!hasNext}
          onClick={onNext}
        >
          {t("occurrences.pager.next", "Next")}
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </span>
    </nav>
  );
}
