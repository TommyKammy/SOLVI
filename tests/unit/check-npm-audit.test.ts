import { describe, expect, it } from 'vitest';
import { evaluateAudit } from '../../tools/check_npm_audit.mjs';

const GHSA = 'GHSA-fc5q-39xc-vjpf';
const exception = {
  id: GHSA,
  package: 'picomatch',
  range: '<=4.0.7',
  expires: '2026-12-18',
  reason: 'test',
};

function advisory(id: string, name: string, severity: string, range: string) {
  return {
    source: 1,
    name,
    title: `${name} issue`,
    url: `https://github.com/advisories/${id}`,
    severity,
    range,
  };
}

function report(...advisories: ReturnType<typeof advisory>[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const a of advisories) {
    vulnerabilities[a.name] = { name: a.name, severity: a.severity, via: [a] };
  }
  // 推移的な参照(文字列)は数えない
  if (advisories.length > 0) {
    vulnerabilities['vitest'] = { name: 'vitest', severity: 'high', via: [advisories[0].name] };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const empty = report();
const picomatchHigh = advisory(GHSA, 'picomatch', 'high', '<=4.0.7');

describe('evaluateAudit', () => {
  it('Critical/High が無ければ合格する', () => {
    const r = evaluateAudit({ full: empty, prod: empty, exceptions: [], today: '2026-11-18' });
    expect(r).toEqual({ ok: true, failures: [], allowed: [] });
  });

  it('例外に無い High は失敗する', () => {
    const r = evaluateAudit({
      full: report(picomatchHigh),
      prod: empty,
      exceptions: [],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain(GHSA);
  });

  it('期限内で影響範囲が一致する開発依存の例外は許可する', () => {
    const r = evaluateAudit({
      full: report(picomatchHigh),
      prod: empty,
      exceptions: [exception],
      today: '2026-12-18',
    });
    expect(r.ok).toBe(true);
    expect(r.allowed).toHaveLength(1);
  });

  it('期限を過ぎた例外は失敗する', () => {
    const r = evaluateAudit({
      full: report(picomatchHigh),
      prod: empty,
      exceptions: [exception],
      today: '2026-12-19',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('期限');
  });

  it('本番依存の High は例外があっても失敗する', () => {
    const r = evaluateAudit({
      full: report(picomatchHigh),
      prod: report(picomatchHigh),
      exceptions: [exception],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.startsWith('本番依存'))).toBe(true);
  });

  it('影響範囲が変わったら(修正版が出たら)例外は無効になる', () => {
    const r = evaluateAudit({
      full: report(advisory(GHSA, 'picomatch', 'high', '<4.0.8')),
      prod: empty,
      exceptions: [exception],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('影響範囲');
  });

  it('監査結果に現れない例外が残っていたら失敗する', () => {
    const r = evaluateAudit({
      full: empty,
      prod: empty,
      exceptions: [exception],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('削除');
  });

  it('Moderate は例外なしで合格する', () => {
    const moderate = advisory('GHSA-g3hv-75wg-m249', 'minimatch', 'moderate', '>=7.0.0 <11.0.1');
    const r = evaluateAudit({
      full: report(moderate),
      prod: report(moderate),
      exceptions: [],
      today: '2026-11-18',
    });
    expect(r.ok).toBe(true);
  });

  it('npm audit の出力を解釈できなければ例外を投げる(fail closed)', () => {
    expect(() =>
      evaluateAudit({ full: {}, prod: empty, exceptions: [], today: '2026-11-18' }),
    ).toThrow();
  });
});
