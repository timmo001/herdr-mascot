import { isAbsolute, relative, sep } from "node:path";

export function containsPath(root: string, file: string) {
  const child = relative(root, file);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
}
