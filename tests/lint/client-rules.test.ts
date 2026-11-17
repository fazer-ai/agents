import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// NOTE: The i18n and client plugins in biome-plugins/, through the real Biome (another fazer.ai app:
// no-t-rename let `const { t: tr } = useTranslation()` through, and nothing failed). Probes are
// written under tests/lint, never into src/, where the suite's source sweeps would read a probe that
// this file deletes under them in a parallel run. biome.jsonc applies each rule to a stand-in here:
// `client/` for the client tree, `api/` for the API tree and the top of `pages/` for the pages
// directory. A pages subdirectory stands for outside require-page-container, and `none/` for where
// none of them apply. One Biome process lints them all and the hits are counted per file and per
// rule, so a probe that trips an unrelated rule fails too.

const ROOT = join(import.meta.dir, "../..");
const RUN = `tests/lint/.probe-client-rules-${process.pid}`;
const CLIENT = `${RUN}/client`;
const API = `${RUN}/api`;
const PAGES = `${RUN}/pages`;
const SUBPAGES = `${PAGES}/sub`;
const OUTSIDE = `${RUN}/none`;

const RULES = [
  "tRename",
  "translateRename",
  "dynamicT",
  "dynamicTranslate",
  "modal",
  "publicEnv",
  "pageContainer",
  "other",
] as const;
type Rule = (typeof RULES)[number];
type Hits = Record<Rule, number>;
const NONE = Object.fromEntries(RULES.map((r) => [r, 0])) as Hits;

function ruleOf(message: string): Rule {
  if (message.includes("named `translate`")) return "translateRename";
  if (
    message.includes("only see calls named `t`") ||
    message.startsWith("Destructure directly") ||
    message.startsWith("Don't import `useTranslation`") ||
    message.startsWith("Call `t` from")
  )
    return "tRename";
  if (message.startsWith("Dynamic i18n key"))
    return message.includes("i18next-parser.api.config.cjs")
      ? "dynamicTranslate"
      : "dynamicT";
  if (message.includes("`*Modal`")) return "modal";
  if (message.includes("process.env.BUN_PUBLIC_")) return "publicEnv";
  if (message.startsWith("Page components must render inside"))
    return "pageContainer";
  return "other";
}

const HOOK = `import { useTranslation } from "react-i18next";\n`;
const hook = (line: string) =>
  `${HOOK}export function useX() {\n  ${line}\n}\n`;

// Name -> [body, expected hits]. An empty object means the sample must pass every rule.
const T_RENAME: Record<string, [string, Partial<Hits>]> = {
  "rename.tsx": [hook(`const { t: tr } = useTranslation();`), { tRename: 1 }],
  "rename-with-i18n.tsx": [
    hook(`const { t: tr, i18n } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-second-with-ns.tsx": [
    hook(`const { i18n, t: tr } = useTranslation("ns");`),
    { tRename: 1 },
  ],
  "rename-let.tsx": [hook(`let { t: tr } = useTranslation();`), { tRename: 1 }],
  "rename-default.tsx": [
    hook(`const { t: tr = (k: string) => k } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-quoted.tsx": [
    hook(`const { "t": tr } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-single-quoted.tsx": [
    hook(`const { 't': tr } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-computed.tsx": [
    hook(`const { ["t"]: tr } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-multiline.tsx": [
    hook(
      `const {\n    i18n,\n    t: translateFn,\n  } = useTranslation("common", { keyPrefix: "x" });`,
    ),
    { tRename: 1 },
  ],
  "rename-through-i18n.tsx": [
    hook(`const { i18n: { t: tr } } = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-member-hook.tsx": [
    `import * as i18next from "react-i18next";\nexport function useX() {\n  const { t: tr } = i18next.useTranslation();\n}\n`,
    { tRename: 1 },
  ],
  "array-rename.tsx": [hook(`const [tr] = useTranslation();`), { tRename: 1 }],
  "array-rest.tsx": [
    hook(`const [...all] = useTranslation();`),
    { tRename: 1 },
  ],
  "whole-value.tsx": [hook(`const i18n = useTranslation();`), { tRename: 1 }],
  "alias-beside-inner-t-parameter.tsx": [
    `${HOOK}export function useX() {\n  const { t } = useTranslation();\n  return t("a");\n}\nexport class Holder {\n  constructor() {\n    const tr = t;\n    [1].map((t) => t);\n    console.log(tr);\n  }\n}\ndeclare const t: (key: string) => string;\n`,
    { tRename: 1 },
  ],
  "string-index-of-call.tsx": [
    hook(`const tr = useTranslation()["t"];`),
    { tRename: 1 },
  ],
  "alias-with-t-in-parameter-type.tsx": [
    `${HOOK}export function useX(props: { t: number }) {\n  const { t } = useTranslation();\n  const tr = t;\n  return [props, tr];\n}\n`,
    { tRename: 1 },
  ],
  "member-of-call.tsx": [
    hook(`const tr = useTranslation().t;`),
    { tRename: 1 },
  ],
  "index-of-call.tsx": [
    hook(`const tr = useTranslation()[0];`),
    { tRename: 1 },
  ],
  "hook-import-renamed.tsx": [
    `import { useTranslation as useI18n } from "react-i18next";\nexport function useX() {\n  const { t } = useI18n();\n  return t("a");\n}\n`,
    { tRename: 1 },
  ],
  "assign-array-rest.tsx": [
    hook(`let all;\n  [...all] = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-type-arguments.tsx": [
    hook(`const { t: tr } = useTranslation<"ns">();`),
    { tRename: 1 },
  ],
  "rename-optional-call.tsx": [
    hook(`const { t: tr } = useTranslation?.();`),
    { tRename: 1 },
  ],
  "rename-optional-member.tsx": [
    `import * as i18next from "react-i18next";\nexport function useX() {\n  const { t: tr } = i18next?.useTranslation();\n}\n`,
    { tRename: 1 },
  ],
  "alias-first-declarator.tsx": [
    hook(`const { t } = useTranslation();\n  const tr = t,\n    label = "x";`),
    { tRename: 1 },
  ],
  "alias-second-declarator.tsx": [
    hook(`const { t } = useTranslation();\n  const label = "x",\n    tr = t;`),
    { tRename: 1 },
  ],
  "assign-rename.tsx": [
    hook(`let tr;\n  ({ t: tr } = useTranslation());`),
    { tRename: 1 },
  ],
  "assign-array-rename.tsx": [
    hook(`let tr;\n  [tr] = useTranslation();`),
    { tRename: 1 },
  ],
  "assign-whole-value.tsx": [
    hook(`let i18n;\n  i18n = useTranslation();`),
    { tRename: 1 },
  ],
  "array-hole-i18n-rename.tsx": [
    hook(`const [, { t: tr }, ready] = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-through-tuple-index.tsx": [
    hook(`const { 1: { t: tr } } = useTranslation();`),
    { tRename: 1 },
  ],
  "array-i18n-rename.tsx": [
    hook(`const [t, { t: tr }] = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-tuple-index.tsx": [
    hook(`const { 0: tr } = useTranslation();`),
    { tRename: 1 },
  ],
  "whole-value-unicode.tsx": [
    hook(`const tá = useTranslation();`),
    { tRename: 1 },
  ],
  "array-rename-unicode.tsx": [
    hook(`const [tá] = useTranslation();`),
    { tRename: 1 },
  ],
  "rename-commented.tsx": [
    hook(`const { t: /* note */ tr } = useTranslation();`),
    { tRename: 1 },
  ],
  "array-rename-commented.tsx": [
    hook(`const [/* note */ tr] = useTranslation();`),
    { tRename: 1 },
  ],
  "array-rename-dollar.tsx": [
    hook(`const [t$] = useTranslation();`),
    { tRename: 1 },
  ],
  "alias.tsx": [
    hook(`const { t } = useTranslation();\n  const tr = t;`),
    { tRename: 1 },
  ],
  "shorthand.tsx": [hook(`const { t } = useTranslation();`), {}],
  "shorthand-with-i18n-ns.tsx": [
    hook(`const { t, i18n } = useTranslation("ns");`),
    {},
  ],
  "t-colon-t.tsx": [hook(`const { t: t } = useTranslation();`), {}],
  "quoted-t-colon-t.tsx": [hook(`const { "t": t } = useTranslation();`), {}],
  "computed-t-colon-t.tsx": [
    hook(`const { ["t"]: t } = useTranslation();`),
    {},
  ],
  "t-colon-t-default.tsx": [
    hook(`const { t: t = (k: string) => k } = useTranslation();`),
    {},
  ],
  "without-t.tsx": [hook(`const { i18n, ready } = useTranslation();`), {}],
  "array-t.tsx": [hook(`const [t, i18n] = useTranslation();`), {}],
  "array-hole.tsx": [hook(`const [, i18n] = useTranslation();`), {}],
  "alias-of-rest-and-setter-parameters.tsx": [
    `${HOOK}export function useX() {\n  const { t } = useTranslation();\n  return t("a");\n}\nexport function tuple(...t: number[]) {\n  const values = t;\n  return values;\n}\nexport class Box {\n  set value(t: number) {\n    const next = t;\n    console.log(next);\n  }\n}\n`,
    {},
  ],
  "alias-of-constructor-parameter.tsx": [
    `${HOOK}export function useX() {\n  const { t } = useTranslation();\n  return t("a");\n}\nexport class Holder {\n  constructor(t: { id: number }) {\n    const toast = t;\n    console.log(toast);\n  }\n}\n`,
    {},
  ],
  "alias-of-parameter-after-function-type.tsx": [
    `${HOOK}export function useX() {\n  const { t } = useTranslation();\n  return t("a");\n}\nexport function pick(callback: () => void, t: { id: number }) {\n  const item = t;\n  callback();\n  return item.id;\n}\nexport const pickArrow = (callback: () => void, t: { id: number }) => {\n  const item = t;\n  callback();\n  return item.id;\n};\n`,
    {},
  ],
  "alias-of-generic-arrow-parameter.tsx": [
    hook(
      `const { t } = useTranslation();\n  const identity = <T,>(t: T) => {\n    const value = t;\n    return value;\n  };\n  return identity;`,
    ),
    {},
  ],
  "alias-of-callback-parameter.tsx": [
    hook(
      `const { t } = useTranslation();\n  return [{ id: 1 }].map((t) => {\n    const toast = t;\n    return toast.id;\n  });`,
    ),
    {},
  ],
  "alias-of-destructured-parameter.tsx": [
    hook(
      `const { t } = useTranslation();\n  const rows = [{ t: 1 }].map(({ t }) => {\n    const value = t;\n    return value;\n  });\n  return [rows, [[1]].map(([t]) => {\n    const first = t;\n    return first;\n  })];`,
    ),
    {},
  ],
  "alias-beside-renamed-destructured-parameter.tsx": [
    hook(
      `const { t } = useTranslation();\n  return [{ t: 1 }].map(({ t: count }) => {\n    const tr = t;\n    return [count, tr("a")];\n  });`,
    ),
    { tRename: 1 },
  ],
  "alias-of-function-parameter.tsx": [
    `${HOOK}export function useX() {\n  const { t } = useTranslation();\n  return t("a");\n}\nfunction pick(index: number, t: { id: number }) {\n  const item = t;\n  return item.id + index;\n}\n`,
    {},
  ],
  "hook-type-import-renamed.tsx": [
    `import type { useTranslation as UseTranslation } from "react-i18next";\nexport type R = ReturnType<typeof UseTranslation>;\n`,
    {},
  ],
  "hook-type-specifier-renamed.tsx": [
    `import { type useTranslation as UseTranslation } from "react-i18next";\nexport type R = ReturnType<typeof UseTranslation>;\n`,
    {},
  ],
  "member-of-call-t.tsx": [hook(`const t = useTranslation().t;`), {}],
  "language-of-call.tsx": [
    hook(`const language = useTranslation().i18n.language;`),
    {},
  ],
  "hook-result-passed-on.tsx": [
    `${HOOK}declare function wrap(x: unknown): [unknown];\nexport function useX() {\n  const [tr] = wrap(useTranslation());\n}\n`,
    {},
  ],
  "assign-shorthand.tsx": [hook(`let t;\n  ({ t } = useTranslation());`), {}],
  "array-first-t-fields.tsx": [
    hook(`const [{ t: field }] = useTranslation();`),
    {},
  ],
  "t-fields-after-hook.tsx": [
    hook(`const { t } = useTranslation();\n  const { name } = t;`),
    {},
  ],
  "array-t-fields.tsx": [
    hook(`const [{ name: functionName }] = useTranslation();`),
    {},
  ],
  "t-fields.tsx": [
    hook(`const { t: { name: functionName } } = useTranslation();`),
    {},
  ],
  "array-i18n-deep-t.tsx": [
    hook(
      `const [t, { options: { resources: { en: { translation: { t: title } } } } }] = useTranslation();`,
    ),
    {},
  ],
  "array-i18n-language.tsx": [
    hook(`const [t, { language }] = useTranslation();`),
    {},
  ],
  "nested-index-not-t.tsx": [
    hook(`const { i18n: { languages: { 0: language } } } = useTranslation();`),
    {},
  ],
  "i18n-index-not-t.tsx": [
    hook(`const { i18n: { 0: x } } = useTranslation();`),
    {},
  ],
  "tuple-index-t.tsx": [hook(`const { 0: t } = useTranslation();`), {}],
  "alias-without-hook.tsx": [
    `export function position(t: number) {\n  const time = t;\n  return time;\n}\n`,
    {},
  ],
  "t-colon-t-commented.tsx": [
    hook(`const { t: /* note */ t } = useTranslation();`),
    {},
  ],
  "array-t-commented.tsx": [
    hook(`const [t /* note */] = useTranslation();`),
    {},
  ],
  "array-t-default.tsx": [
    hook(`const [t = (k: string) => k] = useTranslation();`),
    {},
  ],
  "other-hook.tsx": [
    `declare function useOther(): { t: unknown };\nexport function useX() {\n  const { t: tr } = useOther();\n}\n`,
    {},
  ],
  "i18n-member-t.tsx": [
    hook(`const { i18n } = useTranslation();\n  return i18n.t("a");`),
    { tRename: 1 },
  ],
  "i18n-member-t-alias.tsx": [
    hook(
      `const { i18n } = useTranslation();\n  const tr = i18n.t;\n  return tr("a");`,
    ),
    { tRename: 1 },
  ],
  "i18n-computed-t.tsx": [
    hook(`const { i18n } = useTranslation();\n  return i18n["t"]("a");`),
    { tRename: 1 },
  ],
  "i18n-destructure-rename.tsx": [
    hook(
      `const { i18n } = useTranslation();\n  const { t: tr } = i18n;\n  return tr("a");`,
    ),
    { tRename: 1 },
  ],
  "i18n-destructure-other.tsx": [
    hook(
      `const { t, i18n } = useTranslation();\n  const { language } = i18n;\n  return [t("a"), language];`,
    ),
    {},
  ],
  "i18n-member-language.tsx": [
    hook(
      `const { t, i18n } = useTranslation();\n  return [t("a"), i18n.language];`,
    ),
    {},
  ],
  "i18n-module-call.tsx": [
    `import i18n from "@/client/lib/i18n";\nexport const a = i18n.t("a");\n`,
    { tRename: 1 },
  ],
  "i18n-module-alias.tsx": [
    `import i18n from "@/client/lib/i18n";\nconst tr = i18n.t;\nexport const a = tr("a");\n`,
    { tRename: 1 },
  ],
  "i18n-module-destructure-rename.tsx": [
    `import i18n from "@/client/lib/i18n";\nconst { t: tr } = i18n;\nexport const a = tr("a");\n`,
    { tRename: 1 },
  ],
  "i18next-module-call.tsx": [
    `import i18next from "i18next";\nexport const a = i18next.t("a");\n`,
    { tRename: 1 },
  ],
  "i18n-module-language.tsx": [
    `import i18n from "@/client/lib/i18n";\nexport const a = [i18n.language, i18n.changeLanguage];\n`,
    {},
  ],
  "t-from-parameter.tsx": [
    `import type { TFunction } from "i18next";\nexport const label = (t: TFunction) => t("a");\n`,
    {},
  ],
  "typed-rename.tsx": [
    hook(`const { t: tr }: { t: (key: string) => string } = useTranslation();`),
    { tRename: 1 },
  ],
  "typed-whole-value.tsx": [
    hook(`const i18n: ReturnType<typeof useTranslation> = useTranslation();`),
    { tRename: 1 },
  ],
  "typed-member-of-call.tsx": [
    hook(`const tr: (key: string) => string = useTranslation().t;`),
    { tRename: 1 },
  ],
  "typed-alias.tsx": [
    hook(
      `const { t } = useTranslation();\n  const tr: typeof t = t;\n  return tr("a");`,
    ),
    { tRename: 1 },
  ],
};

const CLIENT_SAMPLES: Record<string, [string, Partial<Hits>]> = {
  ...T_RENAME,
  "dynamic-identifier.tsx": [
    hook(`const { t } = useTranslation();\n  const k = "a";\n  return t(k);`),
    { dynamicT: 1 },
  ],
  "dynamic-template.tsx": [
    hook(
      `const { t } = useTranslation();\n  const x = "b";\n  return t(\`a.\${x}\`);`,
    ),
    { dynamicT: 1 },
  ],
  "dynamic-concat.tsx": [
    hook(
      `const { t } = useTranslation();\n  const x = "b";\n  return t("a." + x);`,
    ),
    { dynamicT: 1 },
  ],
  "literal-key.tsx": [
    hook(`const { t } = useTranslation();\n  return t("a.b", "Default");`),
    {},
  ],
  "modal-and.tsx": [
    `export const X = ({ open }: { open: boolean }) => <div>{open && <FooModal />}</div>;\n`,
    { modal: 1 },
  ],
  "modal-and-children.tsx": [
    `export const X = ({ open }: { open: boolean }) => <div>{open && <FooModal>x</FooModal>}</div>;\n`,
    { modal: 1 },
  ],
  "modal-ternary.tsx": [
    `export const X = ({ open }: { open: boolean }) => <div>{open ? <FooModal /> : null}</div>;\n`,
    { modal: 1 },
  ],
  "modal-inverted.tsx": [
    `export const X = ({ open }: { open: boolean }) => <div>{open ? null : <FooModal />}</div>;\n`,
    { modal: 1 },
  ],
  "modal-always.tsx": [
    `export const X = ({ m }: { m: unknown }) => <div><FooModal modal={m} /></div>;\n`,
    {},
  ],
  "tooltip-and.tsx": [
    `export const X = ({ open }: { open: boolean }) => <div>{open && <Tooltip />}</div>;\n`,
    {},
  ],
  "public-env.tsx": [
    `export const a = process.env.BUN_PUBLIC_API_URL;\n`,
    { publicEnv: 1 },
  ],
  "node-env.tsx": [`export const a = process.env.NODE_ENV;\n`, {}],
  // NOTE: the page rule is scoped to the top of the pages directory, so a bare page here passes.
  "page-outside-pages.tsx": [
    `export function ProbePage() {\n  return <div />;\n}\n`,
    {},
  ],
};

const TRANSLATE = `import { translate } from "@/api/lib/i18n";\n`;
const API_SAMPLES: Record<string, [string, Partial<Hits>]> = {
  "import-rename.ts": [
    `import { translate as tr } from "@/api/lib/i18n";\nexport const a = tr("x");\n`,
    { translateRename: 1 },
  ],
  "import-rename-second.ts": [
    `import { currentLocale, translate as tr } from "@/api/lib/i18n";\nexport const a = tr("x", currentLocale());\n`,
    { translateRename: 1 },
  ],
  "alias.ts": [
    `${TRANSLATE}const tr = translate;\nexport const a = tr("x");\n`,
    { translateRename: 1 },
  ],
  "import-rename-relative.ts": [
    `import { translate as tr } from "../lib/i18n";\nexport const a = tr("x");\n`,
    { translateRename: 1 },
  ],
  "import-rename-after-other.ts": [
    `import { currentLocale as loc, translate as tr } from "@/api/lib/i18n";\nexport const a = tr("x", loc());\n`,
    { translateRename: 1 },
  ],
  "type-only-import.ts": [
    `import type { translate as Translate } from "@/api/lib/i18n";\nexport type T = typeof Translate;\n`,
    {},
  ],
  "type-specifier.ts": [
    `import { currentLocale, type translate as Translate } from "@/api/lib/i18n";\nexport type T = typeof Translate;\nexport const l = currentLocale();\n`,
    {},
  ],
  "import-named-type-rename.ts": [
    `import { translate as typeTr } from "@/api/lib/i18n";\nexport const a = typeTr("x");\n`,
    { translateRename: 1 },
  ],
  "alias-after-type-import.ts": [
    `import type { translate } from "@/api/lib/i18n";\nexport function wrap(translate: () => string) {\n  const tr = translate;\n  return tr();\n}\n`,
    {},
  ],
  "alias-after-type-specifier.ts": [
    `import { currentLocale, type translate } from "@/api/lib/i18n";\nexport function wrap(translate: () => string) {\n  const tr = translate;\n  return tr() + currentLocale();\n}\n`,
    {},
  ],
  "translate-fields.ts": [
    `${TRANSLATE}const { length } = translate;\nexport const a = length;\n`,
    {},
  ],
  "alias-second-declarator.ts": [
    `${TRANSLATE}const label = "x",\n  tr = translate;\nexport const a = tr(label);\n`,
    { translateRename: 1 },
  ],
  "alias-of-shadowing-parameter.ts": [
    `${TRANSLATE}export function adapt(translate: (key: string) => string) {\n  const tr = translate;\n  return tr("x");\n}\n`,
    {},
  ],
  "alias-of-shadowing-parameter-after-function-type.ts": [
    `${TRANSLATE}export function adapt(callback: () => void, translate: (key: string) => string) {\n  const tr = translate;\n  callback();\n  return tr("x");\n}\n`,
    {},
  ],
  "alias-with-translate-in-parameter-type.ts": [
    `${TRANSLATE}export function adapt(props: { translate: number }) {\n  const tr = translate;\n  return [props, tr("x")];\n}\n`,
    { translateRename: 1 },
  ],
  "alias-of-destructured-parameter.ts": [
    `${TRANSLATE}export function adapt({ translate }: { translate: (key: string) => string }) {\n  const tr = translate;\n  return tr("x");\n}\n`,
    {},
  ],
  "alias-of-constructor-parameter.ts": [
    `${TRANSLATE}export class Renderer {\n  constructor(private translate: (key: string) => string) {\n    const tr = translate;\n    console.log(tr("x"));\n  }\n}\n`,
    {},
  ],
  "alias-of-setter-parameter.ts": [
    `${TRANSLATE}export class Renderer {\n  set translator(translate: (key: string) => string) {\n    const tr = translate;\n    console.log(tr("x"));\n  }\n}\n`,
    {},
  ],
  "alias-beside-inner-translate-parameter.ts": [
    `${TRANSLATE}export class Renderer {\n  constructor() {\n    const tr = translate;\n    [""].map((translate: string) => translate.trim());\n    console.log(tr("x"));\n  }\n}\n`,
    { translateRename: 1 },
  ],
  "other-module-rename.ts": [
    `import { translate as move } from "./geometry";\nexport const a = move(1);\n`,
    {},
  ],
  "other-module-alias.ts": [
    `import { translate } from "./geometry";\nconst move = translate;\nexport const a = move(1);\n`,
    {},
  ],
  "import-plain.ts": [`${TRANSLATE}export const a = translate("x");\n`, {}],
  "import-as-itself.ts": [
    `import { translate as translate } from "@/api/lib/i18n";\nexport const a = translate("x");\n`,
    {},
  ],
  "dynamic-key.ts": [
    `${TRANSLATE}const k = "x";\nexport const a = translate(k);\n`,
    { dynamicTranslate: 1 },
  ],
  // NOTE: the client's `t` rules do not reach the API tree.
  "t-rename-in-api.ts": [
    `${HOOK}export function useX() {\n  const { t: tr } = useTranslation();\n}\n`,
    {},
  ],
  "alias-after-self-named-import.ts": [
    `import { translate as translate } from "@/api/lib/i18n";\nconst tr = translate;\nexport const a = tr("x");\n`,
    { translateRename: 1 },
  ],
  "typed-alias.ts": [
    `${TRANSLATE}const tr: typeof translate = translate;\nexport const a = tr("x");\n`,
    { translateRename: 1 },
  ],
};

const PAGE_SAMPLES: Record<string, [string, Partial<Hits>]> = {
  "bare.tsx": [
    `export function ProbePage() {\n  return <div />;\n}\n`,
    { pageContainer: 1 },
  ],
  "wrapped.tsx": [
    `import { PageContainer } from "@/client/components";\nexport function ProbePage() {\n  return <PageContainer><div /></PageContainer>;\n}\n`,
    {},
  ],
  "self-closing.tsx": [
    `import { PageContainer } from "@/client/components";\nexport function ProbePage() {\n  return <PageContainer />;\n}\n`,
    {},
  ],
};

// A `debugger` statement, which the run below also reports, proves tests/ is linted at all,
// so the zeros next to it are not the zeros of a file Biome never opened.
const CANARY = "canary.ts";
const CANARY_BODY = ["debug", "ger;\n"].join("");

const expected: Record<string, Partial<Hits>> = {};
const files: Record<string, string> = {};
const place = (path: string, [body, hits]: [string, Partial<Hits>]) => {
  files[path] = body;
  expected[path] = hits;
};
for (const [name, sample] of Object.entries(CLIENT_SAMPLES))
  place(`${CLIENT}/${name}`, sample);
for (const [name, sample] of Object.entries(API_SAMPLES))
  place(`${API}/${name}`, sample);
for (const [name, sample] of Object.entries(PAGE_SAMPLES)) {
  place(`${PAGES}/${name}`, sample);
  place(`${SUBPAGES}/${name}`, [sample[0], {}]);
}
const ALL = { ...CLIENT_SAMPLES, ...API_SAMPLES, ...PAGE_SAMPLES };
for (const [name, [body]] of Object.entries(ALL)) {
  // A page sample and a client sample can share a name; the prefix keeps both.
  const prefix = name in PAGE_SAMPLES ? "page-" : "";
  place(`${OUTSIDE}/${prefix}${name}`, [body, {}]);
}
files[`${OUTSIDE}/${CANARY}`] = CANARY_BODY;

let hits: Map<string, Hits>;
let stderr: string;

beforeAll(() => {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(ROOT, path, ".."), { recursive: true });
    writeFileSync(join(ROOT, path), body);
  }
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      "biome",
      "lint",
      "--only=plugin",
      "--only=suspicious/noDebugger",
      "--max-diagnostics=none",
      "--reporter=github",
      ...Object.keys(files),
    ],
    cwd: ROOT,
  });
  stderr = run.stderr.toString();
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2] || !line.startsWith("::error title=")) continue;
    const file = m[1].startsWith(ROOT) ? m[1].slice(ROOT.length + 1) : m[1];
    const h = hits.get(file) ?? { ...NONE };
    h[line.startsWith("::error title=plugin,") ? ruleOf(m[2]) : "other"]++;
    hits.set(file, h);
  }
});

afterAll(() => {
  rmSync(join(ROOT, RUN), { recursive: true, force: true });
});

const of = (path: string): Hits => hits.get(path) ?? NONE;

test("every plugin loads", () => {
  expect(stderr).not.toContain("loading of plugins");
  expect(stderr).not.toContain("errored");
});

describe.each([
  ["the client tree", CLIENT, CLIENT_SAMPLES],
  ["the API tree", API, API_SAMPLES],
])("in %s", (_, dir, samples) => {
  test.each(Object.keys(samples))("%s", (name) => {
    expect(of(`${dir}/${name}`)).toEqual({
      ...NONE,
      ...expected[`${dir}/${name}`],
    });
  });
});

describe("require-page-container", () => {
  test.each(Object.keys(PAGE_SAMPLES))("at the top of pages: %s", (name) => {
    const path = `${PAGES}/${name}`;
    expect(of(path)).toEqual({ ...NONE, ...expected[path] });
  });

  test.each(Object.keys(PAGE_SAMPLES))(
    "in a pages subdirectory: %s",
    (name) => {
      expect(of(`${SUBPAGES}/${name}`)).toEqual(NONE);
    },
  );
});

test("every refused sample is reported by its own rule", () => {
  const refused = Object.entries(expected).filter(
    ([, h]) => Object.keys(h).length > 0,
  );
  expect(refused.length).toBeGreaterThan(0);
  for (const [path, h] of refused)
    expect({ path, hits: of(path) }).toEqual({ path, hits: { ...NONE, ...h } });
});

test("outside the stand-ins none of these rules apply", () => {
  expect(of(`${OUTSIDE}/${CANARY}`).other).toBe(1);
  for (const path of Object.keys(files).filter(
    (p) => p.startsWith(`${OUTSIDE}/`) && !p.endsWith(CANARY),
  ))
    expect({ path, hits: of(path) }).toEqual({ path, hits: NONE });
});
