import { cn } from "@/lib/utils";

export function TraceraMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-10 shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g
        className="stroke-brand-lime-ink dark:stroke-brand-lime"
        fill="none"
        strokeWidth={2.6}
        strokeLinecap="round"
        opacity={0.65}
      >
        <path d="M12 16C17.5 16 17 6 22.4 6" />
        <path d="M12 16C17.5 16 17 26 22.4 26" />
      </g>
      <path
        className="stroke-brand-lime-ink dark:stroke-brand-lime"
        d="M6 16H22.4"
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <g className="fill-brand-ink dark:fill-brand-paper">
        <circle cx="22.6" cy="6" r="2.7" />
        <circle cx="22.6" cy="16" r="2.7" />
        <circle cx="22.6" cy="26" r="2.7" />
      </g>
      <circle className="fill-brand-lime-ink dark:fill-brand-lime" cx="6" cy="16" r="4.2" />
    </svg>
  );
}

export function BrandLockup({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("inline-flex h-10 items-center gap-2.5", className)}>
      <TraceraMark className={markClassName} />
      <span className="translate-y-px font-serif text-2xl uppercase leading-none tracking-wide text-foreground">
        Tracera
      </span>
    </span>
  );
}
