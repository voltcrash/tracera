const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0];

/** Extracts a conservative set of non-binary EXIF fields from JPEG data URIs. */
export function extractExifMetadata(image: string): Record<string, string> | undefined {
  const match = image.match(/^data:image\/jpeg;base64,(.+)$/s);
  if (!match) return undefined;
  try {
    const bytes = decodeBase64(match[1]!);
    const tiffOffset = findExifTiffOffset(bytes);
    if (tiffOffset === undefined) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const byteOrder = view.getUint16(tiffOffset, false);
    const littleEndian = byteOrder === 0x4949;
    if (!littleEndian && byteOrder !== 0x4d4d) return undefined;
    if (view.getUint16(tiffOffset + 2, littleEndian) !== 42) return undefined;

    const metadata: Record<string, string> = {};
    const firstIfd = tiffOffset + view.getUint32(tiffOffset + 4, littleEndian);
    const exifIfd = readIfd(view, tiffOffset, firstIfd, littleEndian, metadata);
    if (exifIfd !== undefined) {
      readIfd(view, tiffOffset, tiffOffset + exifIfd, littleEndian, metadata);
    }
    return Object.keys(metadata).length ? metadata : undefined;
  } catch {
    // Malformed metadata must not make an otherwise useful image uncheckable.
    return undefined;
  }
}

function findExifTiffOffset(bytes: Uint8Array) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    if (
      marker === 0xe1 &&
      EXIF_HEADER.every((value, index) => bytes[offset + 4 + index] === value)
    ) {
      return offset + 10;
    }
    offset += 2 + length;
  }
  return undefined;
}

function readIfd(
  view: DataView,
  tiffOffset: number,
  ifdOffset: number,
  littleEndian: boolean,
  metadata: Record<string, string>,
) {
  const count = view.getUint16(ifdOffset, littleEndian);
  let exifIfd: number | undefined;
  for (let index = 0; index < Math.min(count, 128); index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const itemCount = view.getUint32(entry + 4, littleEndian);
    if (tag === 0x8769 && itemCount === 1) {
      exifIfd = view.getUint32(entry + 8, littleEndian);
      continue;
    }
    const label = EXIF_TAGS.get(tag);
    if (!label) continue;
    const value = readExifValue(view, tiffOffset, entry, type, itemCount, littleEndian);
    if (value) metadata[label] = value;
  }
  return exifIfd;
}

function readExifValue(
  view: DataView,
  tiffOffset: number,
  entry: number,
  type: number,
  count: number,
  littleEndian: boolean,
) {
  if (type === 2 && count > 0 && count <= 512) {
    const start = count <= 4 ? entry + 8 : tiffOffset + view.getUint32(entry + 8, littleEndian);
    if (start < 0 || start + count > view.byteLength) return undefined;
    return new TextDecoder()
      .decode(new Uint8Array(view.buffer, view.byteOffset + start, count))
      .replace(/\0+$/, "")
      .trim();
  }
  if (type === 3 && count === 1) {
    return String(view.getUint16(entry + 8, littleEndian));
  }
  return undefined;
}

function decodeBase64(value: string) {
  const decoded = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

const EXIF_TAGS = new Map([
  [0x010f, "Camera make"],
  [0x0110, "Camera model"],
  [0x0112, "Orientation"],
  [0x0131, "Software"],
  [0x0132, "Modified at"],
  [0x9003, "Captured at"],
  [0xa434, "Lens model"],
]);
