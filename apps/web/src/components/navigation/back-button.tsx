"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BackArrowMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("size-5 shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <g
        className="stroke-brand-lime-ink dark:stroke-brand-lime"
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
        opacity={0.85}
      >
        <path d="M6.5 16C10.5 16 10.8 9.8 14.6 8.2" />
        <path d="M6.5 16C10.5 16 10.8 22.2 14.6 23.8" />
      </g>
      <path
        className="stroke-brand-lime-ink dark:stroke-brand-lime"
        d="M6.5 16H24.6"
        fill="none"
        strokeWidth={3}
        strokeLinecap="round"
      />
      <g className="fill-brand-ink dark:fill-brand-paper">
        <circle cx="14.8" cy="8.2" r="2.4" />
        <circle cx="14.8" cy="23.8" r="2.4" />
        <circle cx="6.5" cy="16" r="2.4" />
      </g>
      <circle className="fill-brand-lime-ink dark:fill-brand-lime" cx="24.8" cy="16" r="3.2" />
    </svg>
  );
}

/** Sits in the canvas gutter, so the label stays assistive-only and never takes width. */
export function BackButton({
  className,
  href,
  label,
}: {
  className?: string;
  href?: string;
  label?: string;
}) {
  const router = useRouter();
  const title = label ?? "Go back";

  const content = (
    <>
      <BackArrowMark className="transition-transform group-hover/back:-translate-x-0.5" />
      <span className="sr-only">{title}</span>
    </>
  );
  const classes = cn("canvas-back group/back rounded-full", className);

  if (href) {
    return (
      <Button
        render={<Link href={href} />}
        variant="ghost"
        size="icon-sm"
        title={title}
        className={classes}
      >
        {content}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      title={title}
      onClick={() => router.back()}
      className={classes}
    >
      {content}
    </Button>
  );
}
