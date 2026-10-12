export function getReleaseVersion(date = new Date()) {
  return `v${date.toISOString().slice(2, 10).replaceAll("-", ".")}`;
}
