// Step body placeholders: `{{name}}` is the lead's display name, `{{product}}`
// its highest-scored catalog match (empty when the lead matched nothing) and
// `{{platform}}` where the post was found. An unknown token is left verbatim so
// a typo reads as a typo in the outbox instead of silently dropping a word.

export interface NurtureTemplateVars {
  name: string;
  product: string | null;
  platform: string;
}

const TOKEN = /\{\{\s*([a-zA-Z_]+)\s*\}\}/g;

export function renderNurtureTemplate(
  template: string,
  vars: NurtureTemplateVars,
): string {
  return template.replace(TOKEN, (raw, key: string) => {
    switch (key) {
      case "name":
        return vars.name;
      case "product":
        return vars.product ?? "";
      case "platform":
        return vars.platform;
      default:
        return raw;
    }
  });
}
