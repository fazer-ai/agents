import { cn } from "@/client/lib/utils";

const SIZES = {
  sm: "h-6 w-6 text-[0.625rem]",
  md: "h-8 w-8 text-xs",
  lg: "h-14 w-14 text-lg",
};

export function initialsOf(
  name: string | null | undefined,
  email: string,
): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  // By code point, so an initial drawn from outside the BMP (an emoji name) is never half a pair.
  const first = (s: string | undefined) => Array.from(s ?? "")[0] ?? "";
  const [a = "", b = ""] =
    parts.length >= 2 ? [first(parts[0]), first(parts[1])] : Array.from(source);
  return `${a}${b}`.toUpperCase();
}

// Initials on the accent tint. Decorative: whatever sits next to it
// carries the person's name, so it is aria-hidden.
export function Avatar({
  name,
  email,
  size = "md",
  className,
}: {
  name?: string | null;
  email: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent leading-none",
        SIZES[size],
        className,
      )}
    >
      {initialsOf(name, email)}
    </span>
  );
}
