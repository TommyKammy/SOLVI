/**
 * 添付ファイルの受け入れ判定(FR-TKT-005 / NFR-SEC-005 / 脅威 T-15)。
 *
 * 許可リスト方式にする。拒否リストは、新しい実行形式が出るたびに漏れる側へ倒れる。
 * 「知らない形式は受け取らない」ほうが、業務上の不便より安全側である。
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MiB

/** 拡張子 → 許可するMIMEタイプ。両方が一致しない限り受け付けない。 */
const ALLOWED: Record<string, readonly string[]> = {
  // 文書
  pdf: ['application/pdf'],
  txt: ['text/plain'],
  csv: ['text/csv', 'application/csv'],
  log: ['text/plain'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  // 画面キャプチャ(問い合わせで最も多い)
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  webp: ['image/webp'],
  heic: ['image/heic'],
  // ログ一式
  zip: ['application/zip', 'application/x-zip-compressed'],
};

export type AttachmentRejectionCode =
  | 'empty_file_name'
  | 'no_extension'
  | 'extension_not_allowed'
  | 'content_type_mismatch'
  | 'size_zero'
  | 'size_exceeded'
  | 'path_traversal';

export interface AttachmentValidationResult {
  ok: boolean;
  code?: AttachmentRejectionCode;
  message?: string;
  /** 正規化済みのファイル名(表示用)。ディレクトリ成分を落としたもの。 */
  safeFileName?: string;
}

/**
 * ファイル名からディレクトリ成分を落とす。
 * `../../etc/passwd` のような値が表示やダウンロード名に混ざらないようにする。
 * オブジェクトキーには使わない(キーはランダム値)ため、これは表示用の正規化である。
 */
export function sanitizeFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  // 制御文字を除去。ファイル名に改行が入ると、ログや通知の見え方を操作できる。
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
}

export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function validateAttachment(input: {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): AttachmentValidationResult {
  const safeFileName = sanitizeFileName(input.fileName);

  if (safeFileName.length === 0) {
    return { ok: false, code: 'empty_file_name', message: 'ファイル名が不正です' };
  }
  if (safeFileName !== input.fileName.trim()) {
    // ディレクトリ成分や制御文字が含まれていた。受け付けず、利用者に付け直させる。
    return {
      ok: false,
      code: 'path_traversal',
      message: 'ファイル名に使用できない文字が含まれています',
    };
  }

  const ext = extensionOf(safeFileName);
  if (!ext) {
    return { ok: false, code: 'no_extension', message: '拡張子のないファイルは添付できません' };
  }

  const allowedTypes = ALLOWED[ext];
  if (!allowedTypes) {
    return {
      ok: false,
      code: 'extension_not_allowed',
      message: `.${ext} のファイルは添付できません`,
    };
  }

  // 拡張子とMIMEの両方が一致することを求める。
  // 片方だけの検査は、拡張子を偽装した実行ファイルを通してしまう。
  const contentType = input.contentType.split(';')[0]!.trim().toLowerCase();
  if (!allowedTypes.includes(contentType)) {
    return {
      ok: false,
      code: 'content_type_mismatch',
      message: 'ファイルの種類が拡張子と一致しません',
    };
  }

  if (input.sizeBytes <= 0) {
    return { ok: false, code: 'size_zero', message: '空のファイルは添付できません' };
  }
  if (input.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: 'size_exceeded',
      message: `ファイルサイズが上限(${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB)を超えています`,
    };
  }

  return { ok: true, safeFileName };
}

/** 検査対象の拡張子一覧(テストとドキュメント生成に使う) */
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);
