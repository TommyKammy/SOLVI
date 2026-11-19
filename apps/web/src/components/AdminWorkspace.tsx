import React from 'react';
import Link from 'next/link';

export function AdminBackLink() {
  return (
    <Link className="support-back" href="/ops/admin">
      管理ホームへ戻る
    </Link>
  );
}

function AdminPermissionNotice({ canOpenHome }: { canOpenHome: boolean }) {
  return (
    <section className="admin-permission" role="alert">
      <p>この画面を表示する権限がありません。組織の管理者へご連絡ください。</p>
      <div className="form-actions">
        {canOpenHome && <Link href="/ops/admin">管理ホームへ戻る</Link>}
        <Link href="/portal">利用者ポータルへ戻る</Link>
      </div>
    </section>
  );
}

export function AdminDenied({ title, canOpenHome }: { title: string; canOpenHome: boolean }) {
  return (
    <main id="main" className="shell admin-workspace">
      <h1>{title}</h1>
      <AdminPermissionNotice canOpenHome={canOpenHome} />
    </main>
  );
}
