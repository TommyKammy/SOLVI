import { redirect } from 'next/navigation';
import { requireSession } from '../lib/api';
import { navigationRoles } from '../lib/navigation';
export const dynamic = 'force-dynamic';
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const roles = navigationRoles(await requireSession());
  if (roles.inbox) redirect('/inbox');
  if (roles.auditor) redirect('/changes');
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['cursorCreatedAt', 'cursorId', 'page'])
    if (typeof params[key] === 'string') query.set(key, params[key]);
  redirect('/portal' + (query.size ? '?' + query.toString() : ''));
}
