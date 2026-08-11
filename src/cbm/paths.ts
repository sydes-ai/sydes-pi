import { access } from "node:fs/promises";
import { delimiter } from "node:path";

export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (name.includes("/")) {
    return canExecute(name);
  }

  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) {
      continue;
    }

    const candidate = `${dir}/${name}`;
    const resolved = await canExecute(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function canExecute(path: string): Promise<string | null> {
  try {
    await access(path);
    return path;
  } catch {
    return null;
  }
}
