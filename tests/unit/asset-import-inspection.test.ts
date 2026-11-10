// FR-AST-002, NFR-UX-002, NFR-UX-003, NFR-UX-004: display-only inspection; synthetic props do not prove authorization or CSV writes.
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, requireSession, type AssetImportDetail } from '../../apps/web/src/lib/api';
import {
  AssetImportInspection,
  visibleImportRows,
  type AssetImportInspectionRow,
} from '../../apps/web/src/components/AssetImportInspection';
import Page from '../../apps/web/src/app/assets/imports/[id]/page';

vi.mock('../../apps/web/src/lib/api', () => ({
  api: { assetImportDetail: vi.fn() },
  requireSession: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  usePathname: () => '/assets/imports/11111111-1111-1111-1111-111111111111',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) =>
    createElement('a', { href }, children),
}));
vi.mock('../../apps/web/src/components/AssetCsvForms', () => ({
  ApplyAssetCsvForm: ({ id, planHash, count }: { id: string; planHash: string; count: number }) =>
    createElement('form', {
      'data-id': id,
      'data-plan-hash': planHash,
      'data-normal-count': count,
    }),
}));
vi.mock('../../apps/web/src/components/AssetImportInspection', async () => {
  const actual = await vi.importActual<
    typeof import('../../apps/web/src/components/AssetImportInspection')
  >('../../apps/web/src/components/AssetImportInspection');
  return {
    ...actual,
    AssetImportInspection: vi.fn(
      (props: React.ComponentProps<typeof actual.AssetImportInspection>) =>
        createElement(actual.AssetImportInspection, props),
    ),
  };
});
const id = '11111111-1111-1111-1111-111111111111';
const inputSentinel = 'SYNTHETIC_PRIVATE_INPUT_084';
const emailSentinel = 'SYNTHETIC_PRIVATE_EMAIL_084';
const nestedSentinel = 'SYNTHETIC_UNDISPLAYED_CHANGE_084';
const originalAsset = '22222222-2222-2222-2222-222222222222';
const savedAsset = '33333333-3333-3333-3333-333333333333';
function fixture(): AssetImportDetail {
  return {
    id,
    sourceKey: 'synthetic',
    contentHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    createdAt: '2026-10-10T00:00:00Z',
    creatorName: '合成作成者',
    canManage: true,
    receipt: null,
    plan: {
      headers: ['externalId', 'assetTag'],
      mapping: { name: '名前' },
      reason: '合成確認',
      counts: { add: 1, update: 1, unchanged: 1, error: 1 },
      rows: (['add', 'update', 'unchanged', 'error'] as const).map((operation, index) => ({
        row: index + 2,
        externalId: ['Id.One', 'ID-Two', 'plain[3]', 'last'][index],
        assetTag: ['ASSET-A', 'asset-b', 'TAG[3]', 'ERROR'][index],
        operation,
        assetId:
          index === 1 ? originalAsset : index === 2 ? '44444444-4444-4444-4444-444444444444' : null,
        expectedVersion: index === 1 || index === 2 ? 7 : null,
        identityExists: index === 2,
        match: index === 1 ? 'asset_tag' : index === 2 ? 'external_id' : 'new',
        input: { nested: { sentinel: inputSentinel } },
        assignedEmail: emailSentinel,
        issues: operation === 'error' ? ['隔離理由'] : [],
        changes:
          operation === 'unchanged' || operation === 'error'
            ? []
            : [
                {
                  field: 'name',
                  label: '名前',
                  before: null,
                  after: '合成名',
                  privateNote: nestedSentinel,
                },
                { field: 'location', label: '設置場所', before: '', after: null },
                { field: 'kind', label: '種類', before: '0', after: '' },
                {
                  field: 'note',
                  label: '注記',
                  before: '一行\n二行',
                  after: '<script>合成</script>',
                },
              ],
      })),
    },
  };
}
async function page(detail = fixture()) {
  vi.mocked(api.assetImportDetail).mockResolvedValue({ ok: true, data: detail });
  return renderToStaticMarkup(
    await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
  );
}
function displayedRows(): AssetImportInspectionRow[] {
  return vi.mocked(AssetImportInspection).mock.calls.at(-1)![0].rows as AssetImportInspectionRow[];
}
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(AssetImportInspection).mockClear();
  vi.mocked(requireSession).mockResolvedValue({} as Awaited<ReturnType<typeof requireSession>>);
});
afterEach(() => vi.unstubAllGlobals());
describe('server display projection and unchanged Apply contract', () => {
  it('copies only displayed row and nested change keys without private fields', async () => {
    const html = await page(),
      rows = displayedRows();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'row',
          'externalId',
          'assetTag',
          'operation',
          'assetId',
          'expectedVersion',
          'match',
          'issues',
          'changes',
        ].sort(),
      );
      for (const change of row.changes)
        expect(Object.keys(change).sort()).toEqual(['field', 'label', 'before', 'after'].sort());
    }
    for (const sentinel of [inputSentinel, emailSentinel, nestedSentinel]) {
      expect(JSON.stringify(rows)).not.toContain(sentinel);
      expect(html).not.toContain(sentinel);
      expect(visibleImportRows(rows, 'all', sentinel)).toHaveLength(0);
    }
    expect(rows[1].changes[3]).toEqual({
      field: 'note',
      label: '注記',
      before: '一行\n二行',
      after: '<script>合成</script>',
    });
  });
  it('prefers the receipt saved asset link and preserves original row order', async () => {
    const detail = fixture();
    detail.receipt = {
      appliedAt: '2026-10-10T01:00:00Z',
      actorName: '合成担当者',
      result: {
        added: 1,
        updated: 1,
        unchanged: 1,
        skipped: 1,
        assets: [
          { row: 2, id: savedAsset, version: 1 },
          { row: 3, id: originalAsset, version: 8 },
          { row: 4, id: '44444444-4444-4444-4444-444444444444', version: 7 },
        ],
      },
    };
    const html = await page(detail);
    expect(displayedRows().map((row) => row.row)).toEqual([2, 3, 4, 5]);
    expect(displayedRows()[0].assetId).toBe(savedAsset);
    expect(html).toContain('/assets/' + savedAsset);
    expect(html).not.toContain('data-normal-count');
  });
  it.each([true, false])(
    'keeps full normal count and original hash, canManage=%s',
    async (canManage) => {
      const detail = { ...fixture(), canManage },
        html = await page(detail);
      expect(vi.mocked(AssetImportInspection).mock.calls[0][0].normalCount).toBe(3);
      expect(html.includes('data-normal-count="3"')).toBe(canManage);
      if (canManage) {
        expect(html).toContain('data-id="' + id + '"');
        expect(html).toContain('data-plan-hash="' + detail.planHash + '"');
      }
    },
  );
  it('keeps zero-normal-row guidance and no Apply independent of inspection', async () => {
    const detail = fixture();
    detail.plan.rows = [detail.plan.rows[3]];
    detail.plan.counts = { add: 0, update: 0, unchanged: 0, error: 1 };
    const html = await page(detail);
    expect(html).not.toContain('data-normal-count');
    expect(html).toContain('正常行がありません。CSVを修正し再プレビューしてください。');
    expect(vi.mocked(AssetImportInspection).mock.calls[0][0].normalCount).toBe(0);
  });
  it.each([403, 404])(
    'retains protected refusal %s without exposing inspection props',
    async (status) => {
      vi.mocked(api.assetImportDetail).mockResolvedValue({
        ok: false,
        problem: { status, title: '合成拒否' },
      });
      await expect(
        Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }),
      ).rejects.toThrow('NEXT_NOT_FOUND');
      expect(AssetImportInspection).not.toHaveBeenCalled();
    },
  );
});
describe('literal display filtering without mutation', () => {
  let rows: AssetImportInspectionRow[];
  beforeEach(async () => {
    await page();
    rows = displayedRows();
  });
  it.each([
    ['all', [2, 3, 4, 5]],
    ['add', [2]],
    ['update', [3]],
    ['unchanged', [4]],
    ['error', [5]],
  ] as const)('filters %s in source order', (operation, expected) => {
    expect(visibleImportRows(rows, operation, '').map((row) => row.row)).toEqual(expected);
  });
  it.each([
    ['id-two', [3]],
    ['ASSET-b', [3]],
    ['[3]', [4]],
    ['.', [2]],
    ['^', []],
    [' ', []],
    ['ID-Two ', []],
    ['合成名', []],
  ])('matches literal identifier query %s', (search, expected) => {
    expect(visibleImportRows(rows, 'all', search as string).map((row) => row.row)).toEqual(
      expected,
    );
  });
  it('combines criteria and clears to all rows without mutating source DTO', () => {
    const before = JSON.stringify(rows);
    expect(visibleImportRows(rows, 'add', 'asset-b')).toHaveLength(0);
    expect(visibleImportRows(rows, 'update', 'asset-B').map((row) => row.row)).toEqual([3]);
    expect(visibleImportRows(rows, 'all', '')).toEqual(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it('supports 100 mixed rows and excludes hidden values from search', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({ ...rows[i % 4], row: i + 2 }));
    expect(visibleImportRows(hundred, 'all', '')).toHaveLength(100);
    expect(visibleImportRows(hundred, 'error', '')).toHaveLength(25);
    expect(visibleImportRows(hundred, 'all', emailSentinel)).toHaveLength(0);
  });
});
describe('real inspection markup', () => {
  it('labels before and after, separates null and empty, preserves newlines and escapes HTML', async () => {
    const html = await page();
    expect(html).toContain('<dt>変更前</dt>');
    expect(html).toContain('<dt>変更後</dt>');
    expect(html).toContain('<dd>（なし）</dd>');
    expect(html).toContain('<dd>（空欄）</dd>');
    expect(html).toContain('<dd>0</dd>');
    expect(html).toContain('一行\n二行');
    expect(html).toContain('&lt;script&gt;合成&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('初回の資産タグ一致: この資産へ外部IDを対応付けます。');
    expect(html).toContain('（確認時の版7）');
    expect(html).toContain('隔離理由');
    expect(html).toContain('資産の内容・版を変更しません。');
    expect(html).toContain('<details open="">');
  });
  it('uses labeled non-submit controls, selected state, total count and semantic table region', async () => {
    const html = await page();
    expect(html).toContain('aria-label="判定で表示を絞り込む"');
    expect(html.match(/type="button"/g)).toHaveLength(6);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('type="search"');
    expect(html).toContain('表示4行 / 全4行');
    expect(html).toContain('確定時の対象は正常3行すべてです。');
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
  });
});
