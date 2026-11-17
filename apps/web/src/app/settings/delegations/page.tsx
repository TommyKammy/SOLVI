import Link from 'next/link';
import { Fragment } from 'react';
import {
  api,
  requireSession,
  type ApprovalDelegationCandidate,
  type ApprovalDelegationItem,
} from '../../../lib/api';
import { isOrgAdmin } from '../../../lib/navigation';
import { formatDateTime } from '../../../lib/labels';
import {
  delegationCreatedText,
  delegationRevocable,
  delegationRevokedText,
  delegationStateLabel,
  delegationStateNote,
  findDelegation,
  jstDateTimeInput,
} from '../../../lib/approval-delegation';
import { createDelegationAction, revokeDelegationAction } from './actions';
import { TableRegion } from '../../../components/TableRegion';
import { DelegationCreateForm, DelegationRevokeForm } from './DelegationForms';

export const dynamic = 'force-dynamic';

/**
 * 承認の委任(代理承認)の画面 (WP-P4-APR-020 §6.7 / ADR-0025 §1・§2・§5)。
 *
 * 置き場所は `/settings/delegations`。この画面は「自分宛ての承認を誰に任せるか」という
 * **利用者ごとの設定**であり、承認者でない利用者も上長として承認が来ることがあるため、
 * すべての認証済みの利用者が開ける。`/settings` は両方のシェル(エージェント/サポート)と
 * 戻り先の検証で既に扱われており、`/ops/approvals`(組織管理者だけの承認ルール)とは
 * 権限も対象も異なる。通知のリンク先もこの画面に合わせている。
 *
 * 認可・期間・重なり・代理者の資格・状態の導出はAPIが持つ。この画面は表示だけを行う。
 * 成功の表示は、URLの値ではなく一覧に実在する記録から組み立てる(WP-P4-APR-018 の教訓)。
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const raw = await searchParams;
  const scope = { userId: session.userId, organizationId: session.organizationId };

  const listResult = await api.approvalDelegations();
  if (!listResult.ok) {
    return (
      <main id="main" className="shell">
        <h1>承認の委任</h1>
        <section className="error-summary" role="alert">
          <h2>
            {listResult.problem.status === 401
              ? 'ログイン状態を確認できませんでした'
              : listResult.problem.status === 403
                ? '承認の委任を表示できません'
                : '承認の委任を読み込めませんでした'}
          </h2>
          <p>
            {listResult.problem.status === 401
              ? 'ログインし直してから、この画面を開き直してください。'
              : '保存済みの委任を確認できないため、作成・取消の操作は表示していません。時間をおいて再度お試しください。'}
          </p>
          <p>
            <a href="/settings/delegations">同じ画面で再取得する</a>
            {' · '}
            <Link href="/portal">ポータルへ戻る</Link>
          </p>
        </section>
      </main>
    );
  }

  const rows = listResult.data.items;
  // 候補が読めないときは作成のフォームを出さない(fail closed)。
  const candidatesResult = await api.approvalDelegationCandidates();
  const candidates: ApprovalDelegationCandidate[] | null = candidatesResult.ok
    ? candidatesResult.data.items
    : null;

  const mine = rows.filter((item) => item.relation === 'delegator');
  const received = rows.filter((item) => item.relation === 'delegate');
  const others = rows.filter((item) => item.relation === 'admin');
  // 組織の一覧は org_admin に出す。platform_admin はAPIが `admin` の行を返すため、
  // 行がある場合も出す(画面のロール判定だけで API の判断を打ち消さない)。
  const showOrganization = isOrgAdmin(session) || others.length > 0;

  const text = (key: string) => (typeof raw[key] === 'string' ? raw[key] : '');
  const createdItem = findDelegation(rows, text('created'));
  const createdNotice =
    createdItem && createdItem.relation === 'delegator' ? delegationCreatedText(createdItem) : null;
  const declinedItem = findDelegation(rows, text('declined'));
  const declinedNotice =
    declinedItem && declinedItem.relation === 'delegate'
      ? delegationRevokedText(declinedItem, 'declined')
      : null;
  const revokedItem = findDelegation(rows, text('revoked'));
  const revokedNotice =
    revokedItem && revokedItem.relation !== 'delegate'
      ? delegationRevokedText(revokedItem, 'revoked')
      : null;
  const notice = createdNotice ?? declinedNotice ?? revokedNotice;

  return (
    <main id="main" className="shell directory-shell">
      <div className="directory-heading">
        <div>
          <p className="eyebrow">自分の設定</p>
          <h1>承認の委任（代理承認）</h1>
          <p>
            休暇などで自分が承認できない期間に、自分宛ての承認を別の人へ任せられます。委任できるのは自分宛ての承認だけです。
          </p>
        </div>
        <div className="directory-heading-actions">
          <Link className="directory-cta secondary" href="/requests?view=approvals">
            自分が判断する承認待ち
          </Link>
        </div>
      </div>

      {notice && (
        <div className="notice directory-notice" id="delegation-notice" role="status" tabIndex={-1}>
          <p>{notice}</p>
        </div>
      )}

      <section className="directory-panel" aria-labelledby="delegation-about-title">
        <h2 id="delegation-about-title">委任の範囲と期間</h2>
        <ul>
          <li>委任の範囲は、自分宛ての承認のすべてです。カタログ項目ごとの指定はできません。</li>
          <li>期間は最長30日です。延長するときは、新しい委任を作成してください。</li>
          <li>
            委任の期間中も、自分で承認・却下できます。委任は権限の追加であり、移転ではありません。
          </li>
          <li>委任を取り消しても、代理で承認済みのステップは有効のままです。</li>
          <li>代理者になれるのは同時に1人です。同じ期間に重なる委任は作成できません。</li>
          <li>代理者になれるのは、承認者の役割を持つ有効な所属の利用者だけです。</li>
        </ul>
        <p className="hint">
          状態は「{delegationStateLabel('scheduled')}」「{delegationStateLabel('active')}」 「
          {delegationStateLabel('ended')}」「{delegationStateLabel('revoked')}」 「
          {delegationStateLabel('delegate_ineligible')}」のほか、値を確認できない場合は 「
          {delegationStateLabel('unknown')}」と表示します。有効とは扱いません。
        </p>
        <p className="hint">
          確認時点: {formatDateTime(listResult.data.asOf)} ·{' '}
          <a href="/settings/delegations">一覧を読み直す</a>
        </p>
      </section>

      <section
        className="directory-panel"
        id="delegation-mine"
        aria-labelledby="delegation-mine-title"
      >
        <h2 id="delegation-mine-title">自分が任せている委任</h2>
        {mine.length === 0 ? (
          <p className="empty">まだ委任していません。下の「委任を作成」から作成できます。</p>
        ) : (
          <TableRegion className="directory-table-wrap" label="自分が任せている委任">
            <table className="directory-table">
              <caption>自分が任せている委任</caption>
              <thead>
                <tr>
                  <th scope="col">代理者</th>
                  <th scope="col">開始</th>
                  <th scope="col">終了</th>
                  <th scope="col">状態</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((item) => (
                  <DelegationRows
                    key={item.id}
                    item={item}
                    scope={scope}
                    who={item.delegateName}
                    label="代理者"
                    kind="revoked"
                  />
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}

        <h3 id="delegation-create-title">委任を作成</h3>
        {candidates === null ? (
          <p className="hint" role="alert">
            代理者の候補を読み込めませんでした。保存済みの委任は表示しています。時間をおいて画面を開き直してください。
          </p>
        ) : candidates.length === 0 ? (
          <p className="hint" role="alert">
            代理者にできるのは、承認者の役割を持つ有効な利用者だけです。該当する人がいません。組織の管理者に役割の付与を依頼してください。
          </p>
        ) : (
          <DelegationCreateForm
            action={createDelegationAction.bind(null, scope)}
            candidates={candidates}
            defaultStart={jstDateTimeInput(new Date())}
          />
        )}
      </section>

      <section
        className="directory-panel"
        id="delegation-received"
        aria-labelledby="delegation-received-title"
      >
        <h2 id="delegation-received-title">自分が任されている委任</h2>
        {received.length === 0 ? (
          <p className="empty">自分が代理者になっている委任はありません。</p>
        ) : (
          <TableRegion className="directory-table-wrap" label="自分が任されている委任">
            <table className="directory-table">
              <caption>自分が任されている委任</caption>
              <thead>
                <tr>
                  <th scope="col">委任者</th>
                  <th scope="col">開始</th>
                  <th scope="col">終了</th>
                  <th scope="col">状態</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {received.map((item) => (
                  <DelegationRows
                    key={item.id}
                    item={item}
                    scope={scope}
                    who={item.delegatorName}
                    label="委任者"
                    kind="declined"
                  />
                ))}
              </tbody>
            </table>
          </TableRegion>
        )}
      </section>

      {showOrganization && (
        <section
          className="directory-panel"
          id="delegation-organization"
          aria-labelledby="delegation-organization-title"
        >
          <h2 id="delegation-organization-title">組織のすべての委任</h2>
          <p className="hint">
            組織管理者として、組織の委任をすべて表示します。自分が関係する委任の取消は、上の一覧から行えます。他人の委任の取消は、一覧の下の欄から行えます。
          </p>
          {rows.length === 0 ? (
            <p className="empty">この組織には、まだ委任がありません。</p>
          ) : (
            <TableRegion className="directory-table-wrap" label="組織のすべての委任">
              <table className="directory-table">
                <caption>組織のすべての委任</caption>
                <thead>
                  <tr>
                    <th scope="col">委任者</th>
                    <th scope="col">代理者</th>
                    <th scope="col">開始</th>
                    <th scope="col">終了</th>
                    <th scope="col">状態</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => (
                    <tr key={item.id} data-delegation-id={item.id} data-relation={item.relation}>
                      <td data-label="委任者">{item.delegatorName}</td>
                      <td data-label="代理者">{item.delegateName}</td>
                      <td data-label="開始">{formatDateTime(item.startsAt)}</td>
                      <td data-label="終了">{formatDateTime(item.endsAt)}</td>
                      <DelegationStateCell state={item.state} />
                      <td data-label="操作">
                        {item.relation === 'admin' && delegationRevocable(item.state)
                          ? '取消'
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )}
          {others
            .filter((item) => delegationRevocable(item.state))
            .map((item) => (
              <DelegationRevokeForm
                key={item.id}
                action={revokeDelegationAction.bind(null, scope, item.id, 'revoked')}
                kind="revoked"
                summary={`委任を取り消す（${item.delegatorName} → ${item.delegateName}）`}
                who={item.delegateName}
              />
            ))}
        </section>
      )}
    </main>
  );
}

/**
 * 状態の欄。**「代理者が資格なし」のときだけ**、その理由を行の中に添える
 * (常設の説明に出さない。WP-P4-APR-020 段階C の指摘)。
 */
function DelegationStateCell({ state }: { state: string }) {
  const note = delegationStateNote(state);
  return (
    <td data-label="状態">
      {delegationStateLabel(state)}
      {note && (
        <span className="hint" style={{ display: 'block' }}>
          {note}
        </span>
      )}
    </td>
  );
}

/**
 * 委任の1行と、取り消し(辞退)の欄。狭い画面でもフォームをセルに押し込まないよう、
 * 申請の再割当と同じく行の直後に全列をまたぐ行として出す。
 */
function DelegationRows({
  item,
  scope,
  who,
  label,
  kind,
}: {
  item: ApprovalDelegationItem;
  scope: { userId: string; organizationId: string | null };
  who: string;
  label: string;
  kind: 'revoked' | 'declined';
}) {
  const revocable = delegationRevocable(item.state);
  return (
    <Fragment>
      <tr data-delegation-id={item.id} data-relation={item.relation}>
        <td data-label={label}>{who}</td>
        <td data-label="開始">{formatDateTime(item.startsAt)}</td>
        <td data-label="終了">{formatDateTime(item.endsAt)}</td>
        <DelegationStateCell state={item.state} />
        <td data-label="操作">{revocable ? (kind === 'declined' ? '辞退' : '取消') : '—'}</td>
      </tr>
      {revocable && (
        <tr>
          <td
            colSpan={5}
            data-label={kind === 'declined' ? '辞退' : '取消'}
            style={{ paddingTop: 0 }}
          >
            <DelegationRevokeForm
              action={revokeDelegationAction.bind(null, scope, item.id, kind)}
              kind={kind}
              summary={
                kind === 'declined' ? `委任を辞退する（${who}）` : `委任を取り消す（${who}）`
              }
              who={who}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
