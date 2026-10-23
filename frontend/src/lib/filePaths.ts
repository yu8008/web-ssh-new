/** Lexical remote POSIX paths for browser navigation, not a server permission boundary. */
export function normalizeDirectoryPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

export function isPathWithinDirectory(path: string, directory: string): boolean {
  const root = normalizeDirectoryPath(directory);
  const target = normalizeDirectoryPath(path);
  return root === "/" || target === root || target.startsWith(root + "/");
}
