import { avatarDesign, type AvatarDesign } from "@repo/contracts/avatar";

import { Avatar } from "@/components/ui/avatar";

/*
 * A mark is the Tracera logo generalised: one source node, one straight trunk,
 * and curved branches ending in terminal nodes. Which one you get is decided
 * when your account is created and only changes when you shuffle it.
 */
export function TraceAvatar({
  className,
  image,
  seed,
}: {
  className?: string;
  image: string | null;
  seed: string;
}) {
  return (
    <Avatar className={className}>
      <TraceBurst design={avatarDesign(image ?? "", seed)} />
    </Avatar>
  );
}

const CENTER = 20;
const REACH = 13.2;

function TraceBurst({ design }: { design: AvatarDesign }) {
  const angles = Array.from(
    { length: design.branches },
    (_, index) => design.rotation + (index * 360) / design.branches,
  );

  return (
    <svg
      key={design.id}
      viewBox="0 0 40 40"
      className="trace-burst size-full"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx={CENTER} cy={CENTER} r={CENTER} fill={design.disc} />
      <g stroke={design.mark} fill="none" strokeLinecap="round">
        {angles.map((angle, index) => (
          <path
            key={angle}
            d={branchPath(angle, index === 0 ? 0 : design.curve)}
            strokeWidth={index === 0 ? 2.7 : 2.1}
            opacity={index === 0 ? 1 : 0.62}
          />
        ))}
      </g>
      <g fill={design.mark}>
        {angles.map((angle) => {
          const [x, y] = endpoint(angle);
          return <circle key={angle} cx={x} cy={y} r={2.3} />;
        })}
        <circle cx={CENTER} cy={CENTER} r={3.6} />
      </g>
    </svg>
  );
}

function endpoint(angle: number) {
  const radians = (angle * Math.PI) / 180;
  return [
    round(CENTER + REACH * Math.cos(radians)),
    round(CENTER + REACH * Math.sin(radians)),
  ] as const;
}

function branchPath(angle: number, curve: number) {
  const [endX, endY] = endpoint(angle);
  if (!curve) return `M${CENTER} ${CENTER}L${endX} ${endY}`;
  const radians = (angle * Math.PI) / 180;
  const along = REACH * 0.55;
  const bend = curve * 3.6;
  const controlX = round(CENTER + along * Math.cos(radians) - bend * Math.sin(radians));
  const controlY = round(CENTER + along * Math.sin(radians) + bend * Math.cos(radians));
  return `M${CENTER} ${CENTER}Q${controlX} ${controlY} ${endX} ${endY}`;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
