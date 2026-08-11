export type CbmPrimitive = string | number | boolean;

export type CbmArgValue = CbmPrimitive | readonly CbmPrimitive[];

export type CbmArgs = Record<string, CbmArgValue | undefined>;

export interface CbmCommandResult<T = unknown> {
  command: string;
  args: readonly string[];
  stdout: string;
  stderr: string;
  parsed: T | null;
}

export interface CbmClientOptions {
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}
