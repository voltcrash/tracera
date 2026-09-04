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
        emerald: "border-tint-mint-foreground/22 bg-tint-mint text-tint-mint-foreground",
        amber: "border-tint-amber-foreground/22 bg-tint-amber text-tint-amber-foreground",
        rose: "border-tint-rose-foreground/22 bg-tint-rose text-tint-rose-foreground",
        violet: "border-tint-lilac-foreground/22 bg-tint-lilac text-tint-lilac-foreground",
        slate: "border-border bg-muted text-muted-foreground",
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
