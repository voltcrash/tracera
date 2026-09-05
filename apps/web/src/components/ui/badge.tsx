import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
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
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: "badge", variant },
  });
}

export { Badge, badgeVariants };
