import { ClientOnly } from "@tanstack/react-router";

export function LocalTime({ value, dateOnly = false }: { value: string; dateOnly?: boolean }) {
  const date = new Date(value);
  const fallback = dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();
  return (
    <time dateTime={value}>
      <ClientOnly fallback={fallback}>
        {dateOnly
          ? date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
          : date.toLocaleString()}
      </ClientOnly>
    </time>
  );
}
