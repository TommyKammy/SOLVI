/**
 * 外部システムへのアダプタ(Okta / Microsoft Graph)。
 *
 * ここに置くコードは services/executor からのみ利用する(ADR-0006)。
 * Core API と AI サービスはこのパッケージに依存してはならない ―
 * 依存が生まれた時点で特権境界が壊れる。禁止依存検査(TL-16)で強制する。
 *
 * 実装は WP-P4-OKTA-005 / WP-P4-ENTRA-006 で追加する。
 */
export const CONNECTORS_PLACEHOLDER = 'see WP-P4-OKTA-005';
