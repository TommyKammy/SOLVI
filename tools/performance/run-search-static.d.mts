export interface StaticOptions {
  output?: string;
  'exercise-cleanup'?: boolean;
}
export function parseSearchStaticArgs(args: readonly string[]): StaticOptions | { help: true };
export function executeSearchStatic(
  args: StaticOptions,
  dependencies?: {
    prepareOutput?: (output: string | undefined, profile: string, wp: string) => Promise<string>;
    readCorpus?: () => Promise<Uint8Array>;
    fixtureDefinition?: () => Record<string, unknown>;
    createRuntime?: (options: {
      workPackage: string;
      signal: AbortSignal;
      onProgress: (stage: string) => void;
    }) => Promise<{
      meta?: Record<string, unknown>;
      prepareStaticFixture(): Promise<unknown>;
      withStaticReadOnly: unknown;
      buildTicketListQuery: unknown;
      cleanup(): Promise<{ success: boolean }>;
    }>;
    analyzeSearchStatic?: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
    onProgress?: (stage: string) => void;
    writeReport?: (path: string, bytes: string) => Promise<void>;
    quiet?: boolean;
  },
): Promise<{
  success: boolean;
  interrupted: boolean;
  cleanup?: { success: boolean };
  failureCode?: string;
  queryAnalysis?: Record<string, unknown>;
  [key: string]: unknown;
}>;
