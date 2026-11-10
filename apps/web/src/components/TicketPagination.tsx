import Link from 'next/link';

export function TicketPagination({
  basePath,
  query,
  cursor,
  total,
  pageSize,
  page,
}: {
  basePath: string;
  query: URLSearchParams;
  cursor: { createdAt: string; id: string } | null;
  total: number;
  pageSize: number;
  page: number;
}) {
  const first = new URLSearchParams(query);
  first.delete('cursorCreatedAt');
  first.delete('cursorId');
  first.delete('page');
  const next = new URLSearchParams(query);
  if (cursor) {
    next.set('cursorCreatedAt', cursor.createdAt);
    next.set('cursorId', cursor.id);
  }
  next.set('page', String(page + 1));
  const url = (params: URLSearchParams) => `${basePath}${params.size ? `?${params}` : ''}`;
  return (
    <nav className="pagination" aria-label="問い合わせのページ">
      <span>
        {page} ページ目 / 全 {total} 件
      </span>
      {page > 1 && <Link href={url(first)}>最初のページへ</Link>}
      {cursor && page * pageSize < total && <Link href={url(next)}>次のページへ →</Link>}
    </nav>
  );
}

export function pageNumber(raw: string | string[] | undefined): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
