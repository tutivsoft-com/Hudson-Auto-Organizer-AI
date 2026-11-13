export const TRASH_FOLDER_NAME = "Deleted";

export function isTrashPath(path: string): boolean {
  return path.replace(/\\/g, "/").split("/")[0].toLowerCase() === TRASH_FOLDER_NAME.toLowerCase();
}

export function trashDestination(runId: string, sourcePath: string): string {
  const path = sourcePath.replace(/\\/g, "/");
  if (!/^[a-f0-9-]{36}$/i.test(runId) || !path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || isTrashPath(path)) {
    throw new Error("Choose a file outside the Deleted folder.");
  }
  return `${TRASH_FOLDER_NAME}/${runId}/${path}`;
}
