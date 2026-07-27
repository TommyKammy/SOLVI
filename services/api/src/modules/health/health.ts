import type { Database } from '../../common/db/pool.js';
import type { Logger } from '@solvi/shared';

export interface DependencyStatus {
  name: string;
  status: 'up' | 'down';
  detail?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'not_ready';
  dependencies: DependencyStatus[];
  checkedAt: string;
}

/**
 * healthz: プロセスが生きているか(依存先を見ない)。再起動の判断に使う。
 * readyz : 依存先を含めて要求を受けられるか。ロードバランサの投入判断に使う。
 *
 * 両者を分ける理由: DB障害時にプロセスまで再起動されると、復旧後の立ち上がりが遅くなり、
 * 障害を長引かせる。生存と受付可否は別の判断である。
 */
export class HealthService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly version: string,
  ) {}

  liveness(): { status: 'ok'; service: string; version: string } {
    return { status: 'ok', service: 'api', version: this.version };
  }

  async readiness(): Promise<ReadinessReport> {
    const dependencies: DependencyStatus[] = [];

    try {
      await this.db.ping();
      dependencies.push({ name: 'postgres', status: 'up' });
    } catch (error) {
      this.logger.error('readiness check failed: postgres', error);
      dependencies.push({
        name: 'postgres',
        status: 'down',
        // 例外メッセージには接続文字列が含まれうるため、そのまま返さない
        detail: 'connection failed',
      });
    }

    const down = dependencies.filter((d) => d.status === 'down');
    return {
      // PostgreSQL は業務状態の正本(ADR-0003)であり、落ちていれば受付不可
      status: down.length === 0 ? 'ready' : 'not_ready',
      dependencies,
      checkedAt: new Date().toISOString(),
    };
  }
}
