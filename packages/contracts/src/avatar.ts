/*
 * Every account gets one of these marks when it is created, so nothing is ever
 * hosted and nobody starts out anonymous. A choice is stored on the user as the
 * token `trace:<n>`; the design behind that index lives here so the server can
 * hand one out and the client can draw it.
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

export type AvatarDesign = {
  id: string;
  disc: string;
  mark: string;
  branches: number;
  rotation: number;
  curve: number;
};

export function avatarId(index: number) {
  return `${AVATAR_PREFIX}${((index % AVATAR_COUNT) + AVATAR_COUNT) % AVATAR_COUNT}`;
}

export function randomAvatarId() {
  return avatarId(Math.floor(Math.random() * AVATAR_COUNT));
}

/** Accounts made before avatars existed still need a stable mark to show. */
export function avatarIdForSeed(seed: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193);
  }
  return avatarId(Math.abs(hash));
}

export function avatarIndex(image: string | null | undefined) {
  if (!image?.startsWith(AVATAR_PREFIX)) return null;
  const index = Number(image.slice(AVATAR_PREFIX.length));
  if (!Number.isInteger(index) || index < 0 || index >= AVATAR_COUNT) return null;
  return index;
}

export function avatarDesign(image: string, seed: string): AvatarDesign {
  const id = avatarIndex(image) === null ? avatarIdForSeed(seed) : image;
  const index = avatarIndex(id)!;
  return { id, ...discs[index % discs.length]!, ...shapes[Math.floor(index / discs.length)]! };
}

/** Shuffling never lands on the mark already showing. */
export function shuffleAvatarId(current: string | null) {
  const currentIndex = avatarIndex(current);
  const span = currentIndex === null ? AVATAR_COUNT : AVATAR_COUNT - 1;
  let next = Math.floor(Math.random() * span);
  if (currentIndex !== null && next >= currentIndex) next += 1;
  return avatarId(next);
}
