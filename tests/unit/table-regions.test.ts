// NFR-UX-001/NFR-UX-002: wide tables stay keyboard-scrollable and named.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

const files = walk(join(process.cwd(), 'apps/web/src')).filter((file) => file.endsWith('.tsx'));
const tableFiles = files.filter((file) => readFileSync(file, 'utf8').includes('<table'));

describe('every table keeps its header context and keyboard scroll region', () => {
  it('finds the application tables', () => {
    expect(tableFiles.length).toBeGreaterThan(0);
  });

  it.each(tableFiles.map((file) => [file.replace(process.cwd() + '/', ''), file]))(
    '%s wraps each table in TableRegion and gives it a caption',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      const tables = (source.match(/<table\b/g) ?? []).length;
      const regions = (source.match(/<TableRegion\b/g) ?? []).length;
      const captions = (source.match(/<caption\b/g) ?? []).length;
      expect(regions, 'TableRegion count').toBe(tables);
      expect(captions, 'caption count').toBe(tables);
    },
  );
});

// WP-P2-UIX-046: the queue and inbox share one ruled table, and the queue's
// filter buttons use the same OPERATIONS_METRICS queries as the home counts.
describe('UI v2 ticket list and detail', () => {
  const web = (path: string) => readFileSync(join(process.cwd(), 'apps/web/src', path), 'utf8');

  it('uses the OPERATIONS_METRICS queries and exposes the pressed state', () => {
    const ops = web('app/ops/page.tsx');
    expect(ops).toContain('OPERATIONS_METRICS.map');
    expect(ops).toContain('operationsMetricQuery(metric.id, metricGroup)');
    expect(ops).toContain('aria-pressed={activeMetric === metric.id}');
    for (const heading of ['番号', '件名', '状態', '優先度', '担当グループ', '担当者', '解決期限'])
      expect(ops).toContain(`>${heading}<`);
  });

  it('keeps the inbox in one table with the shared columns and kind labels', () => {
    const inbox = web('app/inbox/page.tsx');
    expect((inbox.match(/<table\b/g) ?? []).length).toBe(1);
    expect(inbox).toContain('<TableRegion');
    for (const heading of ['番号', '件名', '種類', '状態', '期限'])
      expect(inbox).toContain(`>${heading}<`);
    expect(inbox).toContain("ticket: 'チケット'");
    expect(inbox).toContain("request_approval: '申請承認'");
    expect(inbox).toContain("change: '変更'");
  });

  it('keeps the submit-style routing form on the right and labels internal notes', () => {
    const detail = web('app/ops/[id]/page.tsx');
    expect(detail).toContain('<TicketRoutingForm');
    expect(detail).toContain('ticket-history');
    expect(detail).toContain('ticket-side');
    const thread = web('components/CommentThread.tsx');
    expect(thread).toContain('社内メモ（依頼者には表示されません）');
    expect(thread).toContain("'comment internal'");
    const routing = web('components/TicketRoutingForm.tsx');
    expect(routing).toContain('type="submit"');
    expect(routing).toContain('groups.map');
  });
});
