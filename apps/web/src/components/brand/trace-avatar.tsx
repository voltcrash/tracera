import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

/*
 * Avatars are generated from the Tracera mark rather than uploaded: one source
 * node, one straight trunk, and curved branches ending in terminal nodes. A
 * choice is stored on the user as the token `trace:<n>`, so nothing is hosted.
 */
const AVATAR_PREFIX = "trace:";

const discs = [
  { disc: "#89f336", mark: "#14210a" },
  { disc: "#7f9c62", mark: "#f4f6f0" },
  { disc: "#c47f95", mark: "#fbf2f4" },
  { disc: "#e9e1d6", mark: "#b0657f" },
  { disc: "#7d8ba1", mark: "#f2f5f9" },
  { disc: "#9a86bd", mark: "#f7f4fc" },
  { disc: "#d9a441", mark: "#241703" },
  { disc: "#6aa8a2", mark: "#f0f8f7" },
];

const shapes = [
  { branches: 5, rotation: -90, curve: 0.9 },
  { branches: 6, rotation: -60, curve: -0.7 },
  { branches: 7, rotation: -90, curve: 0.55 },
  { branches: 8, rotation: -67.5, curve: -0.45 },
];

export const AVATAR_COUNT = discs.length * shapes.length;

type AvatarDesign = {
  id: string;
  disc: string;
  mark: string;
  branches: number;
  rotation: number;
  curve: number;
};

export function parseAvatarId(image: string | null | undefined): AvatarDesign | null {
  if (!image?.startsWith(AVATAR_PREFIX)) return null;
  const index = Number(image.slice(AVATAR_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || index >= AVATAR_COUNT) return null;
  const palette = discs[index % discs.length]!;
  const shape = shapes[Math.floor(index / discs.length)]!;
  return { id: image, ...palette, ...shape };
}

/** Shuffling never lands on the mark already showing. */
export function shuffleAvatarId(current: string | null) {
  const currentIndex = parseAvatarId(current) ? Number(current!.slice(AVATAR_PREFIX.length)) : null;
  const span = currentIndex === null ? AVATAR_COUNT : AVATAR_COUNT - 1;
  let next = Math.floor(Math.random() * span);
  if (currentIndex !== null && next >= currentIndex) next += 1;
  return `${AVATAR_PREFIX}${next}`;
}

/** Google hands back a hosted photo, which stands in until a mark is picked. */
export function isPhotoUrl(image: string | null | undefined) {
  return Boolean(image?.startsWith("http"));
}

export function TraceAvatar({
  className,
  image,
  label,
}: {
  className?: string;
  image: string | null;
  label: string;
}) {
  const design = parseAvatarId(image);
  return (
    <Avatar className={className}>
      {design ? <TraceBurst design={design} /> : null}
      {!design && isPhotoUrl(image) ? (
        <AvatarImage src={image!} alt="" referrerPolicy="no-referrer" />
      ) : null}
      {!design ? <AvatarFallback>{label.slice(0, 2)}</AvatarFallback> : null}
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
