import { readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeSearchStatic,
  parseSearchStaticArgs,
} from '../../tools/performance/run-search-static.mjs';

const evidenceFixture = vi.hoisted(() => ({ live: false }));
const rulesFixture = vi.hoisted(() => ({
  mode: 'historical' as 'historical' | 'live' | 'tampered',
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const { fileURLToPath } = await vi.importActual<typeof import('node:url')>('node:url');
  const { resolve } = await vi.importActual<typeof import('node:path')>('node:path');
  const evidenceRoot = fileURLToPath(new URL('../../evidence', import.meta.url));
  const rulesPath = resolve(evidenceRoot, '..', 'AGENTS.md');
  const historicalRulesPath = resolve(evidenceRoot, '..', 'docs/planning/AGENTS.md');
  // 78 prior directories plus .gitkeep from `git ls-tree 82afbaee6aa79e5ac8c67680c340ac09874f0615:evidence`.
  // WP053 excludes its own directory. Freeze this root inventory and the approved
  // historical rules bytes ONLY. docs/planning/AGENTS.md retains those exact bytes;
  // later root formatting is not a new WP053 approval. All nested evidence reads,
  // original 991 file bytes, 12 source hashes, corpus and approval guard remain real.
  // The production CLI is unchanged and still rejects the current root rules.
  const approvedNames = new Set([
    '.gitkeep',
    'SELF-AUDIT-001',
    'WP-P1-AUD-004',
    'WP-P1-AUD-018',
    'WP-P1-AUD-019',
    'WP-P1-CI-006',
    'WP-P1-DATA-002',
    'WP-P1-IDM-009',
    'WP-P1-IDM-010',
    'WP-P1-IDM-011',
    'WP-P1-IDM-012',
    'WP-P1-IDM-013',
    'WP-P1-IDM-014',
    'WP-P1-IDM-015',
    'WP-P1-IDM-016',
    'WP-P1-IDM-017',
    'WP-P1-OBS-005',
    'WP-P1-PLAT-001',
    'WP-P1-SEC-024',
    'WP-P2-ATTACH-026',
    'WP-P2-CLOSE-014',
    'WP-P2-COLLAB-004',
    'WP-P2-CONV-034',
    'WP-P2-DRAFT-030',
    'WP-P2-FLOW-025',
    'WP-P2-GATE-007',
    'WP-P2-GRP-015',
    'WP-P2-INBOX-027',
    'WP-P2-NTF-005',
    'WP-P2-OPS-003',
    'WP-P2-OPSUI-010',
    'WP-P2-PERF-020',
    'WP-P2-PERF-021',
    'WP-P2-PERF-041',
    'WP-P2-PERF-042',
    'WP-P2-PERF-043',
    'WP-P2-PERF-044',
    'WP-P2-PERF-045',
    'WP-P2-PERF-046',
    'WP-P2-PERF-047',
    'WP-P2-PERF-048',
    'WP-P2-PERF-049',
    'WP-P2-PERF-050',
    'WP-P2-PERF-051',
    'WP-P2-PERF-052',
    'WP-P2-POLISH-033',
    'WP-P2-PORTAL-002',
    'WP-P2-PRIO-013',
    'WP-P2-RECOVER-031',
    'WP-P2-REFINE-032',
    'WP-P2-REG-023',
    'WP-P2-REL-009',
    'WP-P2-RELUI-012',
    'WP-P2-RTM-019',
    'WP-P2-RTM-022',
    'WP-P2-SCAN-011',
    'WP-P2-SCAN-012',
    'WP-P2-SEARCH-006',
    'WP-P2-SEARCH-017',
    'WP-P2-SLAUI-016',
    'WP-P2-SLO-008',
    'WP-P2-STAB-029',
    'WP-P2-TKT-001',
    'WP-P2-UI-035',
    'WP-P2-UISTATE-018',
    'WP-P2-UISTATE-020',
    'WP-P2-UX-028',
    'WP-P2-UX-036',
    'WP-P2-UX-037',
    'WP-P2-UX-038',
    'WP-P2-UX-039',
    'WP-P2-UX-040',
    'WP-P3-KNW-001',
    'WP-P3-LINK-003',
    'WP-P4-CAT-001',
    'WP-P4-LOCAL-010',
    'WP-P6-AST-001',
    'WP-P6-CSV-002',
    'WP-P7-CHG-001',
  ]);
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] !== rulesPath || rulesFixture.mode === 'live')
        return Reflect.apply(actual.readFileSync, actual, args);
      const bytes = Reflect.apply(actual.readFileSync, actual, [
        historicalRulesPath,
        ...args.slice(1),
      ]);
      if (rulesFixture.mode !== 'tampered') return bytes;
      const change = '\n# unit-only modified historical rules\n';
      return typeof bytes === 'string'
        ? bytes + change
        : Buffer.concat([bytes, Buffer.from(change)]);
    }) as typeof actual.readFileSync,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      const entries = Reflect.apply(actual.readdirSync, actual, args);
      if (
        !evidenceFixture.live &&
        args[0] === evidenceRoot &&
        typeof args[1] === 'object' &&
        args[1]?.withFileTypes === true
      )
        return (entries as Dirent[]).filter((entry) => approvedNames.has(entry.name));
      return entries;
    }) as typeof actual.readdirSync,
  };
});
beforeEach(() => {
  evidenceFixture.live = false;
  rulesFixture.mode = 'historical';
});
afterEach(() => {
  evidenceFixture.live = false;
  rulesFixture.mode = 'historical';
});

const corpus = () =>
  readFile(new URL('../../evidence/WP-P2-PERF-053/20261006-approval/corpus.json', import.meta.url));
const complete = {
  completed: true,
  equivalent: true,
  protocolCompleted: true,
  catalogComplete: true,
  indexProofComplete: true,
  authorizationAdoption: false,
  adoptionEstablished: false,
};
const definition = { recipe: 'unit', privateRows: ['private-fixture-marker'] };
const definitionSha256 = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
function dependencies(result: Record<string, unknown> = complete) {
  const saved: string[] = [];
  const cleanup = vi.fn(async () => ({ success: true }));
  const runtime = {
    meta: { password: 'private-runtime-marker', seed: [{ body: 'private-ticket-marker' }] },
    prepareStaticFixture: vi.fn(async () => ({ definitionSha256 })),
    withStaticReadOnly: vi.fn(),
    buildTicketListQuery: vi.fn(),
    cleanup,
  };
  return {
    saved,
    cleanup,
    runtime,
    prepareOutput: vi.fn(async () => '/tmp/solvi-static-unit'),
    readCorpus: corpus,
    fixtureDefinition: () => definition,
    createRuntime: vi.fn(async () => runtime),
    analyzeSearchStatic: vi.fn(async () => result),
    writeReport: vi.fn(async (_path: string, bytes: string) => {
      saved.push(bytes);
    }),
    onProgress: vi.fn(),
    quiet: true,
  };
}

describe('WP053 bounded CLI', () => {
  it('rejects the current formatted root rules before creating a database or analyzing', async () => {
    rulesFixture.mode = 'live';
    const deps = dependencies();
    const report = await executeSearchStatic({}, deps);
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('STATIC_SOURCE_MISMATCH');
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
  });
  it('rejects modified historical rules before creating a database or analyzing', async () => {
    rulesFixture.mode = 'tampered';
    const deps = dependencies();
    const report = await executeSearchStatic({}, deps);
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('STATIC_SOURCE_MISMATCH');
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
    expect(deps.saved.join('')).not.toContain('unit-only modified historical rules');
  });
  it('rejects the live inventory with later evidence before creating a database', async () => {
    evidenceFixture.live = true;
    const deps = dependencies();
    const report = await executeSearchStatic({}, deps);
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('STATIC_SOURCE_MISMATCH');
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
  });
  it('refuses target URLs, profiles, budgets, duplicate/missing values before resource creation', async () => {
    for (const args of [
      ['--url', 'postgres://private'],
      ['--profile', 'growth'],
      ['--budget', '1'],
      ['--output'],
      ['--output', 'one', '--output', 'two'],
      ['--help', '--exercise-cleanup'],
    ])
      expect(() => parseSearchStaticArgs(args)).toThrow();
    const deps = dependencies();
    await expect(executeSearchStatic({ output: '' }, deps)).rejects.toThrow('OUTPUT_INVALID');
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(parseSearchStaticArgs([])).toEqual({});
    expect(parseSearchStaticArgs(['--exercise-cleanup'])).toEqual({ 'exercise-cleanup': true });
  });
  it('refuses changed corpus bytes before DB creation and persists a safe failure', async () => {
    const deps = {
      ...dependencies(),
      readCorpus: async () => Buffer.from('private-corpus-marker'),
    };
    const report = await executeSearchStatic({}, deps);
    expect(report.success).toBe(false);
    expect(report.failureCode).toBe('STATIC_CORPUS_MISMATCH');
    expect(deps.createRuntime).not.toHaveBeenCalled();
    expect(deps.saved.join('')).not.toContain('private-corpus-marker');
  });
  it('requires index/catalog proof, leaves adoption false, and closes resources before publishing', async () => {
    for (const result of [
      complete,
      { ...complete, indexProofComplete: false },
      { ...complete, catalogComplete: false },
      { ...complete, authorizationAdoption: true },
    ]) {
      const deps = dependencies(result);
      const report = await executeSearchStatic({}, deps);
      expect(report.success).toBe(result === complete);
      expect(report.adoptionEstablished).toBe(false);
      expect(deps.cleanup).toHaveBeenCalledOnce();
      expect(deps.cleanup.mock.invocationCallOrder[0]).toBeLessThan(
        deps.writeReport.mock.invocationCallOrder.at(-1)!,
      );
      expect(deps.saved.join('')).not.toMatch(
        /private-runtime-marker|private-ticket-marker|private-fixture-marker/,
      );
    }
  });
  it('cleans a deliberate failure after preparing the owned frozen fixture', async () => {
    const deps = dependencies();
    const report = await executeSearchStatic({ 'exercise-cleanup': true }, deps);
    expect(report.failureCode).toBe('EXPECTED_CLEANUP_EXERCISE');
    expect(report.cleanup?.success).toBe(true);
    expect(deps.runtime.prepareStaticFixture).toHaveBeenCalledOnce();
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });
  it('binds private fixture bytes before DB creation and rejects changed preparation', async () => {
    const deps = dependencies();
    deps.runtime.prepareStaticFixture.mockResolvedValueOnce({ definitionSha256: '0'.repeat(64) });
    const report = await executeSearchStatic({}, deps);
    expect(deps.writeReport.mock.invocationCallOrder[0]).toBeLessThan(
      deps.createRuntime.mock.invocationCallOrder[0],
    );
    expect(report.failureCode).toBe('STATIC_DEFINITION_MISMATCH');
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(deps.saved.join('')).not.toContain('private-fixture-marker');
  });
  it('refuses an API start stage in the database-only factory', async () => {
    const deps = {
      ...dependencies(),
      createRuntime: vi.fn(async (options: { onProgress: (stage: string) => void }) => {
        options.onProgress('start-api');
        throw new Error('unreachable');
      }),
    };
    const report = await executeSearchStatic({}, deps);
    expect(report.failureCode).toBe('STATIC_API_START_FORBIDDEN');
    expect(deps.analyzeSearchStatic).not.toHaveBeenCalled();
  });
  it('persists only a fixed code after an unexpected child error and still closes DB', async () => {
    const deps = {
      ...dependencies(),
      analyzeSearchStatic: vi.fn(async () => {
        throw new Error('private-error-marker');
      }),
    };
    const report = await executeSearchStatic({}, deps);
    expect(report.failureCode).toBe('STATIC_PROOF_FAILED');
    expect(deps.saved.join('')).not.toContain('private-error-marker');
    expect(deps.cleanup).toHaveBeenCalledOnce();
  });
  it('SIGTERM interrupts proof and cannot become a successful report', async () => {
    const deps = {
      ...dependencies(),
      analyzeSearchStatic: vi.fn(async () => {
        process.emit('SIGTERM');
        return complete;
      }),
    };
    const before = process.listenerCount('SIGTERM');
    const report = await executeSearchStatic({}, deps);
    expect(report.success).toBe(false);
    expect(report.interrupted).toBe(true);
    expect(report.failureCode).toBe('STATIC_INTERRUPTED');
    expect(deps.cleanup).toHaveBeenCalledOnce();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
  it('preserves Next.js dynamic route source hashes but rejects parent/absolute paths', async () => {
    const route = 'apps/web/src/app/ops/[id]/page.tsx';
    for (const path of [route, 'apps/web/../private', '/private/absolute']) {
      const deps = dependencies();
      const files = [{ path, sha256: 'a'.repeat(64) }];
      Object.assign(deps.runtime.meta, {
        sourceFiles: files,
        sourceManifestSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      });
      await executeSearchStatic({}, deps);
      const report = JSON.parse(deps.saved.at(-1)!);
      expect(report.runtime.sourceInventoryVerified === true).toBe(path === route);
      if (path === route) expect(report.runtime.sourceFiles).toEqual(files);
      else expect(report.runtime.sourceFiles).toBeUndefined();
    }
  });
});
