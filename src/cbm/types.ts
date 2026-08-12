export type CbmPrimitive = string | number | boolean;

export type CbmArgValue = CbmPrimitive | readonly CbmPrimitive[];

export type CbmArgs = Record<string, CbmArgValue | undefined>;

export interface CbmCommandResult<T = unknown> {
  command: string;
  args: readonly string[];
  stdout: string;
  stderr: string;
  parsed: T | null;
  elapsedMs?: number;
  transport?: string;
}

export interface CbmClientOptions {
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  transport?: CbmTransport;
  preferPersistent?: boolean;
  requestTimeoutMs?: number;
  indexTimeoutMs?: number;
}

export interface CbmCallOptions {
  timeoutMs?: number;
}

export interface CbmTransport {
  readonly kind: string;
  readonly processStartCount: number;
  callTool<T = unknown>(tool: string, args?: CbmArgs, options?: CbmCallOptions): Promise<CbmCommandResult<T>>;
  close(): Promise<void> | void;
}
