import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${path}: ${e.message}`);
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a config. */
export async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export async function writeText(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (e: any) {
    return e.code === "EISDIR";
  }
}

/** Creates a directory readable only by this user (0700), tightening it if it already exists. */
export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
