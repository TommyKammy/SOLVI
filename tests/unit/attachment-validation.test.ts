/**
 * 添付の受け入れ判定(TL-16 / FR-TKT-005 / 脅威 T-15)。
 * 許可リスト方式が「知らない形式を通さない」側に倒れていることを確認する。
 */
import { describe, it, expect } from 'vitest';
import {
  validateAttachment,
  sanitizeFileName,
  extensionOf,
  ALLOWED_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
} from '../../packages/shared/src/attachment/validation.js';

describe('拡張子とMIMEの整合', () => {
  it('許可された組合せを受け付ける', () => {
    expect(
      validateAttachment({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 10 }).ok,
    ).toBe(true);
    expect(
      validateAttachment({ fileName: 'a.png', contentType: 'image/png', sizeBytes: 10 }).ok,
    ).toBe(true);
    // charset 付きの Content-Type も許容する
    expect(
      validateAttachment({
        fileName: 'a.txt',
        contentType: 'text/plain; charset=utf-8',
        sizeBytes: 10,
      }).ok,
    ).toBe(true);
  });

  it('拡張子を偽装した実行ファイルを拒否する', () => {
    const result = validateAttachment({
      fileName: 'photo.png',
      contentType: 'application/x-msdownload',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('content_type_mismatch');
  });

  it('MIMEを偽装した実行ファイルを拒否する', () => {
    const result = validateAttachment({
      fileName: 'malware.exe',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('extension_not_allowed');
  });

  it.each([
    'exe',
    'bat',
    'cmd',
    'sh',
    'ps1',
    'js',
    'mjs',
    'vbs',
    'jar',
    'msi',
    'html',
    'htm',
    'svg',
    'app',
    'dmg',
    'scr',
    'com',
    'dll',
    'so',
  ])('実行・スクリプト形式 .%s を許可しない', (ext) => {
    expect(ALLOWED_EXTENSIONS).not.toContain(ext);
  });

  it('SVGを許可しない(スクリプトを埋め込めるため)', () => {
    const result = validateAttachment({
      fileName: 'icon.svg',
      contentType: 'image/svg+xml',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
  });
});

describe('ファイル名の扱い', () => {
  it('ディレクトリ成分を含むファイル名を拒否する', () => {
    for (const name of ['../../etc/passwd', '/etc/shadow', 'C:\\Windows\\system32\\a.pdf']) {
      const result = validateAttachment({
        fileName: name,
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('制御文字を含むファイル名を拒否する', () => {
    const result = validateAttachment({
      fileName: 'report\n.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('path_traversal');
  });

  it('sanitizeFileName がディレクトリ成分を落とす', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\tmp\\a.pdf')).toBe('a.pdf');
  });

  it('日本語ファイル名を受け付ける', () => {
    const result = validateAttachment({
      fileName: '障害報告書.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.safeFileName).toBe('障害報告書.pdf');
  });

  it('拡張子がないファイルを拒否する', () => {
    expect(
      validateAttachment({ fileName: 'README', contentType: 'text/plain', sizeBytes: 10 }).code,
    ).toBe('no_extension');
    expect(extensionOf('README')).toBeNull();
    expect(extensionOf('.gitignore')).toBeNull(); // 先頭ドットのみは拡張子として扱わない
  });

  it('二重拡張子は最後のものが判定対象になる', () => {
    // report.pdf.exe が pdf として通らないこと
    const result = validateAttachment({
      fileName: 'report.pdf.exe',
      contentType: 'application/pdf',
      sizeBytes: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('extension_not_allowed');
  });
});

describe('サイズ', () => {
  it('上限ちょうどは受け付ける(境界値)', () => {
    expect(
      validateAttachment({
        fileName: 'a.pdf',
        contentType: 'application/pdf',
        sizeBytes: MAX_ATTACHMENT_BYTES,
      }).ok,
    ).toBe(true);
  });

  it('上限+1は拒否する', () => {
    const result = validateAttachment({
      fileName: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: MAX_ATTACHMENT_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('size_exceeded');
  });

  it('サイズ0を拒否する', () => {
    expect(
      validateAttachment({ fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 0 }).code,
    ).toBe('size_zero');
  });
});
