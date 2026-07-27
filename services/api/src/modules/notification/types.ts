/**
 * ディスパッチャとの契約。
 * 通知サービスが Worker のクラスへ直接依存すると、
 * API → Worker の依存が生まれて禁止依存検査に引っかかる。
 * 必要な形だけをここで定義する。
 */
export interface OutboxRecordLike {
  id: string;
  organizationId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}
