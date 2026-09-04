import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors [&>svg]:size-3 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-brand-mint",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border bg-card/70 text-foreground/70",
        emerald: "border-emerald-200 bg-emerald-100 text-emerald-800",
        amber: "border-amber-200 bg-amber-100 text-amber-800",
        rose: "border-rose-200 bg-rose-100 text-rose-800",
        violet: "border-violet-200 bg-violet-100 text-violet-800",
        slate: "border-slate-200 bg-slate-100 text-slate-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
