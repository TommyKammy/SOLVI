import { Problems } from '@solvi/shared';

/**
 * 認可の主体はアプリケーション層である(ADR-0015)。
 * RLS は安全網であり、ここを省略してよい理由にはならない。
 *
 * 存在秘匿の既定: 権限がないリソースは 404 を返す(NFR-SEC-006 / 脅威 T-02)。
 * 403 を返すと「そのIDは存在する」ことを教えてしまう。
 * 例外は「対象の存在が既に明らかで、操作だけが許されない」場合に限る。
 */

export type RoleCode =
  | 'platform_admin'
  | 'platform_auditor'
  | 'org_admin'
  | 'agent'
  | 'approver'
  | 'auditor'
  | 'requester';

export interface RoleBinding {
  roleCode: RoleCode;
  organizationId: string | null;
  validFrom: Date;
  validUntil: Date | null;
}

export interface Principal {
  userId: string;
  status: 'active' | 'deactivated';
  bindings: RoleBinding[];
}

/** 認可判定の文脈。organizationId は「いま操作している組織」。 */
export interface AuthzContext {
  principal: Principal;
  organizationId: string;
  now?: Date;
}

function activeBindings(principal: Principal, now: Date): RoleBinding[] {
  return principal.bindings.filter(
    (b) => b.validFrom <= now && (b.validUntil === null || b.validUntil > now),
  );
}

/**
 * 指定Organization内で有効なロールを返す。
 * platform スコープのロールは組織に属さないため、どの組織の文脈でも有効。
 */
export function effectiveRoles(ctx: AuthzContext): Set<RoleCode> {
  const now = ctx.now ?? new Date();
  // 無効化されたユーザはいかなるロールも持たない(FR-IDM-007 / 脅威 T-05)
  if (ctx.principal.status !== 'active') return new Set();

  const roles = new Set<RoleCode>();
  for (const b of activeBindings(ctx.principal, now)) {
    if (b.organizationId === null || b.organizationId === ctx.organizationId) {
      roles.add(b.roleCode);
    }
  }
  return roles;
}

export function hasRole(ctx: AuthzContext, ...allowed: RoleCode[]): boolean {
  const roles = effectiveRoles(ctx);
  return allowed.some((r) => roles.has(r));
}

/** ロールを持たない場合に例外を投げる。存在秘匿が必要な場面では requireAccess を使う。 */
export function requireRole(ctx: AuthzContext, ...allowed: RoleCode[]): void {
  if (!hasRole(ctx, ...allowed)) {
    throw Problems.forbidden('必要な権限がありません');
  }
}

/**
 * オブジェクト単位の認可(NFR-SEC-006)。
 *
 * リソースの所属組織が文脈と一致しない、または閲覧権限がない場合は
 * **404 を返す**(存在を推測させない)。
 */
export interface OwnedResource {
  organizationId: string;
  /** 作成者・依頼者など、本人だけが見てよい場合に使う */
  ownerUserId?: string;
}

export interface AccessPolicy {
  /** このロールを持っていれば組織内の全件にアクセスできる */
  organizationWide: RoleCode[];
  /** 所有者本人にアクセスを許すか */
  allowOwner: boolean;
}

export function canAccess(
  ctx: AuthzContext,
  resource: OwnedResource,
  policy: AccessPolicy,
): boolean {
  // まず組織境界。ここが一致しない時点で、以降の判定を行わない。
  if (resource.organizationId !== ctx.organizationId) return false;

  if (hasRole(ctx, ...policy.organizationWide)) return true;
  if (policy.allowOwner && resource.ownerUserId === ctx.principal.userId) return true;
  return false;
}

/**
 * アクセスできない場合に 404 を投げる。
 * @param resourceLabel 利用者向けのラベル(「チケット」など)
 */
export function requireAccess(
  ctx: AuthzContext,
  resource: OwnedResource,
  policy: AccessPolicy,
  resourceLabel = 'リソース',
): void {
  if (!canAccess(ctx, resource, policy)) {
    throw Problems.notFound(resourceLabel);
  }
}

/**
 * platform_admin が他組織を操作するときの明示的な切替。
 * **呼び出し側は必ず監査イベントを記録すること**(02.18 §3 / 脅威 T-20)。
 * 切替を「気付かれずに行える」状態にしないため、専用の関数に分けている。
 */
export function assertCanSwitchOrganization(principal: Principal, now = new Date()): void {
  const isPlatform = activeBindings(principal, now).some(
    (b) => b.roleCode === 'platform_admin' || b.roleCode === 'platform_auditor',
  );
  if (principal.status !== 'active' || !isPlatform) {
    throw Problems.forbidden('組織を横断する操作は許可されていません');
  }
}
