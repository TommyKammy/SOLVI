/** Additive, idempotent installation into the existing acme/beta local fixtures. */
import { installTemplates, loginSynthetic } from './catalog_templates.mjs';
const admin = await loginSynthetic('org_admin', process.env.SOLVI_TEMPLATE_ORG ?? 'acme');
console.log(
  JSON.stringify(
    { simulation: true, organization: admin.org, templates: await installTemplates(admin) },
    null,
    2,
  ),
);
