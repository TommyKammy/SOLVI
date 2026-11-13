import type pg from 'pg';
import { z } from 'zod';
import { Problems } from '@solvi/shared';
import { approvalRuleStepsSchema } from '@solvi/shared/catalog';
import { requireRole } from '../../common/authz/authz.js';
import type { AuthenticatedRequest } from '../auth/auth.routes.js';
import { ApprovalRuleService } from './approval-rule.service.js';

/**
 * 承認ルール管理・有効化設定・経路プレビュー (WP-P4-APR-015 段階A)。
 *
 * 全エンドポイントは `org_admin` だけ。入力は閉じた DTO で検証し、
 * `organization_id` などの混入は値を見る前に 400 にする。
 */

const uuid = z.string().uuid();
const code = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/,
    'コードは英小文字から始まる64文字以内の英小文字・数字・ハイフンにしてください',
  );
const name = z
  .string()
  .trim()
  .min(1, 'ルール名を入力してください')
  .max(200, 'ルール名は200文字以内にしてください');

const createSchema = z.object({ code, name, steps: approvalRuleStepsSchema }).strict();
const reviseSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    steps: approvalRuleStepsSchema,
    name: name.optional(),
  })
  .strict();
const settingsSchema = z.object({ enabled: z.boolean() }).strict();
const previewSchema = z
  .object({
    requesterId: uuid,
    itemId: uuid.optional(),
    ruleId: uuid.optional(),
    approverId: uuid.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.itemId) === Boolean(value.ruleId))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['itemId'],
        message: 'カタログ項目または承認ルールのどちらか一方を指定してください',
      });
  });

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw Problems.validation(
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    );
  return result.data;
}

/** `highRisk` は WP-P4-APR-017 で判定基準が確定するまで保存しない(fail closed / WP §6.1)。 */
function rejectHighRisk(value: unknown): void {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value as Record<string, unknown>, 'highRisk')
  )
    throw Problems.validation([
      { field: 'highRisk', message: '高リスクの指定はまだ保存できません' },
    ]);
}

export class ApprovalRuleController {
  constructor(
    private readonly pool: pg.Pool,
    private readonly enabled: boolean,
  ) {}

  private async run<T>(
    auth: AuthenticatedRequest,
    fn: (service: ApprovalRuleService) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    if (!this.enabled) throw Problems.notFound('承認ルール');
    requireRole(auth.authz, 'org_admin');
    const client = await this.pool.connect();
    try {
      await client.query(
        options.readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_org',
        auth.authz.organizationId,
      ]);
      const result = await fn(new ApprovalRuleService(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(auth: AuthenticatedRequest) {
    const items = await this.run(auth, (service) => service.list(auth.authz), { readOnly: true });
    return { status: 200, body: { items } };
  }

  async create(auth: AuthenticatedRequest, value: unknown) {
    rejectHighRisk(value);
    const input = parse(createSchema, value);
    const rule = await this.run(auth, (service) => service.create(auth.authz, input));
    return { status: 201, body: { rule } };
  }

  async revise(auth: AuthenticatedRequest, ruleId: string, value: unknown) {
    rejectHighRisk(value);
    const input = parse(reviseSchema, value);
    const rule = await this.run(auth, (service) =>
      service.revise(auth.authz, parse(uuid, ruleId), input),
    );
    return { status: 200, body: { rule } };
  }

  async deactivate(auth: AuthenticatedRequest, ruleId: string) {
    const rule = await this.run(auth, (service) =>
      service.deactivate(auth.authz, parse(uuid, ruleId)),
    );
    return { status: 200, body: { rule } };
  }

  async history(auth: AuthenticatedRequest, ruleId: string) {
    const items = await this.run(
      auth,
      (service) => service.history(auth.authz, parse(uuid, ruleId)),
      {
        readOnly: true,
      },
    );
    return { status: 200, body: { items } };
  }

  async settings(auth: AuthenticatedRequest) {
    const setting = await this.run(auth, (service) => service.settings(auth.authz), {
      readOnly: true,
    });
    return { status: 200, body: { setting } };
  }

  async updateSettings(auth: AuthenticatedRequest, value: unknown) {
    const input = parse(settingsSchema, value);
    const setting = await this.run(auth, (service) =>
      service.setRouting(auth.authz, input.enabled),
    );
    return { status: 200, body: { setting } };
  }

  async preview(auth: AuthenticatedRequest, value: unknown) {
    const input = parse(previewSchema, value);
    const result = await this.run(auth, (service) => service.preview(auth.authz, input));
    return { status: 200, body: result };
  }

  async unresolved(auth: AuthenticatedRequest, ruleId: string) {
    const result = await this.run(
      auth,
      (service) => service.unresolved(auth.authz, parse(uuid, ruleId)),
      {
        readOnly: true,
      },
    );
    return { status: 200, body: result };
  }
}
