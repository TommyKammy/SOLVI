'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { safeReturnTo, withReturnTo } from '../lib/navigation';

function LinkWithContext({
  href,
  children,
  className,
  back = false,
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  back?: boolean;
}) {
  const path = usePathname(),
    params = useSearchParams();
  const from = safeReturnTo(params.get('returnTo'));
  return (
    <Link
      className={className}
      href={
        back
          ? (from ?? href)
          : withReturnTo(href, path + (params.size ? '?' + params.toString() : ''))
      }
    >
      {back && from && typeof children === 'string' && !children.includes('キャンセル')
        ? '元の画面へ戻る'
        : children}
    </Link>
  );
}
export function ContextLink(props: {
  href: string;
  children: React.ReactNode;
  className?: string;
  back?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <Link href={props.href} className={props.className}>
          {props.children}
        </Link>
      }
    >
      <LinkWithContext {...props} />
    </Suspense>
  );
}
/** Server Actionにも、閲覧元を渡す。入力本文・認証情報はURLに載せない。 */
export function ReturnToField({ current = false }: { current?: boolean }) {
  const [from, setFrom] = useState('');
  useEffect(
    () =>
      setFrom(
        safeReturnTo(
          current
            ? window.location.pathname + window.location.search
            : new URLSearchParams(window.location.search).get('returnTo'),
        ) ?? '',
      ),
    [current],
  );
  return <input type="hidden" name="returnTo" value={from} />;
}
