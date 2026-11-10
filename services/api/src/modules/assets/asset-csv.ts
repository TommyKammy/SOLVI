import { Problems } from '@solvi/shared';

/** Bounded RFC4180-style text parser. Never evaluates cells or spreadsheet formulas. */
export function parseAssetCsv(text: string) {
  const fail = (message: string): never => {
    throw Problems.validation([{ field: 'csv', message }]);
  };
  if (Buffer.byteLength(text, 'utf8') > 24 * 1024) fail('CSVはUTF-8で24KiBまでです');
  if (text.includes('\0') || text.includes('\uFFFD'))
    fail('UTF-8のCSVテキストを貼り付けてください');
  const input = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [],
    cell = '',
    mode: 'plain' | 'quoted' | 'closed' = 'plain';
  const endCell = () => {
    row.push(cell);
    cell = '';
    mode = 'plain';
  };
  const endRow = () => {
    endCell();
    records.push(row);
    row = [];
    if (records.length > 101) fail('データ行は100行までです');
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (mode === 'quoted') {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else mode = 'closed';
      } else cell += ch;
    } else if (ch === ',') endCell();
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      endRow();
    } else if (ch === '"' && mode === 'plain' && cell === '') mode = 'quoted';
    else if (mode === 'closed' || ch === '"') fail('引用符の位置が不正です');
    else cell += ch;
    if (row.length > 40) fail('列は40列までです');
  }
  if (mode === 'quoted') fail('閉じられていない引用符があります');
  if (cell || row.length || mode === 'closed') endRow();
  const headers = (records.shift() ?? []).map((h) => h.trim());
  if (!headers.length || headers.some((h) => !h || h.length > 120) || headers.length > 40)
    fail('見出しは空でない120文字以内、40列以内にしてください');
  if (new Set(headers).size !== headers.length) fail('同じ見出しが複数あります');
  if (!records.length) fail('データ行が必要です');
  return { headers, rows: records };
}
