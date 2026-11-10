import { describe, expect, it } from 'vitest';
import {
  catalogDefinitionSchema,
  catalogRequestFieldVisibility,
  getVisibleCatalogFields,
  validateCatalogFieldValues,
  validateCatalogRequestInputs,
} from '../../packages/shared/src/catalog';
import { catalogTemplates, templateDefinition } from '../../apps/web/src/lib/catalog-templates';

const approver = '11111111-1111-4111-8111-111111111111';
const definition = (code: string) =>
  catalogDefinitionSchema.parse(
    templateDefinition(
      catalogTemplates.find((template) => template.code === code)!,
      approver,
    ),
  );

describe('flexible service examples', () => {
  it.each(catalogTemplates.map((template) => [template.code]))(
    '%s is a usable definition',
    (code) => {
      expect(definition(code).approval?.approverId).toBe(approver);
    },
  );

  it('hardware requests collect selected items and delivery details without a reason or duration', () => {
    const hardware = definition('local-hardware-bundle');
    expect(catalogRequestFieldVisibility(hardware)).toEqual({ reason: false, duration: false });
    expect(validateCatalogRequestInputs(hardware, {})).toEqual({ inputs: {}, errors: [] });
    const values = {
      hardware_items: ['ノートPC', 'モニター'],
      pc_type: 'Windows',
      monitor_size: '標準サイズ',
      employee_name: '合成利用者',
      department: 'テスト部門',
      start_date: '2026-12-01',
      delivery_method: '配送',
      delivery_address: '合成配送先',
      delivery_date: '2026-12-02',
      simulation_confirm: true,
    };
    expect(validateCatalogFieldValues(hardware, values)).toEqual({ values, errors: [] });
    const changed = validateCatalogFieldValues(hardware, {
      ...values,
      hardware_items: ['キーボード'],
      delivery_method: '社内窓口',
    });
    expect(changed.errors).toEqual([]);
    expect(changed.values).not.toHaveProperty('pc_type');
    expect(changed.values).not.toHaveProperty('monitor_size');
    expect(changed.values).not.toHaveProperty('delivery_address');
  });

  it('hardware choices require only the details of the selected items', () => {
    const hardware = definition('local-hardware-bundle');
    const required = validateCatalogFieldValues(hardware, { hardware_items: ['ノートPC'] }).errors;
    expect(required.some((error) => error.field === 'values.pc_type')).toBe(true);
    expect(required.some((error) => error.field === 'values.monitor_size')).toBe(false);
    expect(required.some((error) => error.field === 'values.hardware_items')).toBe(false);
    expect(
      validateCatalogFieldValues(hardware, {}).errors.some(
        (error) => error.field === 'values.hardware_items',
      ),
    ).toBe(true);
  });

  it('security request types reveal their own questions and keep the shared reason', () => {
    const security = definition('local-security-exception');
    expect(catalogRequestFieldVisibility(security)).toEqual({ reason: true, duration: false });
    expect(validateCatalogRequestInputs(security, {}).errors.map((error) => error.field)).toEqual([
      'reason',
    ]);
    const visible = (type: string) =>
      getVisibleCatalogFields(security.fields!, { exception_type: type }).map((field) => field.key);
    expect(visible('Webサイトのブロック解除')).toEqual([
      'exception_type',
      'blocked_url',
      'blocked_date',
      'simulation_confirm',
    ]);
    expect(visible('USB機器の利用')).toEqual([
      'exception_type',
      'usb_device',
      'simulation_confirm',
    ]);
    expect(visible('会議の録画')).toEqual(['exception_type', 'meeting_date', 'simulation_confirm']);
  });

  it.each(['local-contractor-account', 'local-box-request', 'local-pc-loan'])(
    '%s keeps its existing common fields',
    (code) => {
      const existing = definition(code);
      expect(existing).not.toHaveProperty('requestFields');
      expect(catalogRequestFieldVisibility(existing)).toEqual({ reason: true, duration: true });
    },
  );
});
