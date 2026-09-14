// WHAT CHATWOOT ITSELF WRITES WHEN A LABEL CHANGES (issue #642, review round 5).
//
// An activity row carries no structure for this: no sender, and `content_attributes` only on the
// activities that declare a type (a status change), never on a label change. So the only way to know
// that a row narrates a label change is the sentence, and the only way to read a sentence without
// guessing is the TEMPLATE it was rendered from — `conversations.activity.labels.added` and
// `.removed`, interpolated with the actor's name and with `labels.join(", ")`
// (`LabelActivityMessageHandler#create_label_change_activity`).
//
// Guessing at the POSITION instead is what the two rounds before this one kept paying for: "a run of
// known titles at the edge of the line" misses German and Turkish, which put the run in the middle
// ("Hans hat vip hinzugefügt"), and the quoted form it needed for Japanese accepts any other
// activity that happens to quote a value — a priority change, a group rename. The templates say
// where the labels are in every locale, and say it exactly.
//
// COPIED FROM THE FORK, `config/locales/*.yml` of fazer-ai/chatwoot, on 14/set/2026: 74 distinct
// strings across every locale it ships. A template that drifts stops matching, and a line nobody
// matches is simply not read — the same miss this block already chooses over inventing a decision,
// and never a false positive.
const LABEL_ACTIVITY_TEMPLATES: readonly string[] = [
  "%{user_name} %{labels} যোগ করেছেন", // bn.added
  "%{user_name} %{labels} সরিয়ে দিয়েছেন", // bn.removed
  "%{user_name} a ajouté %{labels}", // fr.added
  "%{user_name} a következő cimkéket adta hozzá: %{labels}", // hu.added
  "%{user_name} a supprimé %{labels}", // fr.removed
  "%{user_name} acrescentou %{labels}", // pt.added
  "%{user_name} added %{labels}", // am.added, az.added, bg.added, en.added (+16)
  "%{user_name} adicionou %{labels}", // pt_BR.added
  "%{user_name} adăugat %{labels}", // ro.added
  "%{user_name} agregó %{labels}", // es.added
  "%{user_name} dodal %{labels}", // sl.added
  "%{user_name} dodał/a %{labels}", // pl.added
  "%{user_name} eliminat %{labels}", // ro.removed
  "%{user_name} eliminó a %{labels}", // es.removed
  "%{user_name} fjernede %{labels}", // da.removed
  "%{user_name} fjernet %{labels}", // no.removed
  "%{user_name} ha afegit %{labels}", // ca.added
  "%{user_name} ha aggiunto %{labels}", // it.added
  "%{user_name} ha eliminat %{labels}", // ca.removed
  "%{user_name} ha rimosso %{labels}", // it.removed
  "%{user_name} har lagt till %{labels}", // sv.added
  "%{user_name} hat %{labels} entfernt", // de.removed
  "%{user_name} hat %{labels} hinzugefügt", // de.added
  "%{user_name} je dodao %{labels}", // sr.added
  "%{user_name} je uklonio %{labels}", // sr.removed
  "%{user_name} la til %{labels}", // no.added
  "%{user_name} leszedte a következő cimkéket %{labels}", // hu.removed
  "%{user_name} lisäsi tunnisteet %{labels}", // fi.added
  "%{user_name} menambahkan %{labels}", // id.added
  "%{user_name} menghapus %{labels}", // id.removed
  "%{user_name} noņēma %{labels}", // lv.removed
  "%{user_name} odebral/a %{labels}", // cs.removed
  "%{user_name} odobral %{labels}", // sk.removed
  "%{user_name} odstranil %{labels}", // sl.removed
  "%{user_name} odstranil/a %{labels}", // cs.added
  "%{user_name} pašalino %{labels}", // lt.removed
  "%{user_name} pievienoja %{labels}", // lv.added
  "%{user_name} poisti tunnisteet %{labels}", // fi.removed
  "%{user_name} pridal %{labels}", // sk.added
  "%{user_name} pridėjo %{labels}", // lt.added
  "%{user_name} removed %{labels}", // am.removed, az.removed, bg.removed, en.removed (+16)
  "%{user_name} removeu %{labels}", // pt_BR.removed
  "%{user_name} removeu a %{labels}", // pt.removed
  "%{user_name} thêm %{labels}", // vi.added
  "%{user_name} tilføjede %{labels}", // da.added
  "%{user_name} tog bort %{labels}", // sv.removed
  "%{user_name} usunął/a %{labels}", // pl.removed
  "%{user_name} xoá %{labels}", // vi.removed
  "%{user_name} видалив %{labels}", // uk.removed
  "%{user_name} добавил %{labels}", // ru.added
  "%{user_name} додав %{labels}", // uk.added
  "%{user_name} удалил %{labels}", // ru.removed
  "%{user_name} הוסיף %{labels}", // he.added
  "%{user_name} הסיר %{labels}", // he.removed
  "%{user_name} أزال %{labels}", // ar.removed
  "%{user_name} أضاف %{labels}", // ar.added
  "%{user_name} ले %{labels} थपे", // ne.added
  "%{user_name} ले %{labels} हटाए", // ne.removed
  '%{user_name} がラベル "%{labels}" を削除しました', // ja.removed
  '%{user_name} がラベル "%{labels}" を追加しました', // ja.added
  "%{user_name} 新增了 %{labels}", // zh_TW.added
  "%{user_name} 添加 %{labels}", // zh.added, zh_CN.added
  "%{user_name} 移除 %{labels}", // zh.removed, zh_CN.removed
  "%{user_name} 移除了 %{labels}", // zh_TW.removed
  "%{user_name}, %{labels} ekledi", // tr.added
  "%{user_name}, %{labels} kaldırdı", // tr.removed
  "%{user_name}، %{labels} را اضافه کرد", // fa.added
  "%{user_name}، %{labels} را حذف کرد", // fa.removed
  "%{user_name}님이 %{labels}을(를) 제거했습니다", // ko.removed
  "%{user_name}님이 %{labels}을(를) 추가했습니다", // ko.added
  "Idinagdag ni %{user_name} ang %{labels}", // tl.added
  "Tinanggal ni %{user_name} ang %{labels}", // tl.removed
  "Ο %{user_name} αφαίρεσε τις ετικέτες %{labels}", // el.removed
  "Ο %{user_name} πρόσθεσε ετικέτες %{labels}", // el.added
];

// EVERY OTHER ACTIVITY SENTENCE A LABEL TEMPLATE WOULD ALSO PARSE (round 6), and no more than
// those: of the 760 non-label templates the fork ships, these 58 are the ones whose rendered text a
// label pattern matches — an SLA policy added ("Ana added SLA policy Gold" reads as the label "SLA
// policy Gold" on an account that has one), a priority removed, an assignment cleared, a WhatsApp
// group description removed. None of them sets `activity.type`, so the bag cannot tell them apart
// either. Asked FIRST, and a line that matches one is not a label change whatever it names.
//
// The list is computed, not curated: a non-label template is in it exactly when rendering it with
// any value produces a string one of the label patterns accepts.
const AMBIGUOUS_ACTIVITY_TEMPLATES: readonly string[] = [
  "%{author_name} removed the group description", // groups_update.description_removed
  "%{author_name} removeu a descrição do grupo", // groups_update.description_removed
  "%{user_name} SLA নীতি %{sla_name} যোগ করেছেন", // sla.added
  "%{user_name} a ajouté la politique de SLA %{sla_name}", // sla.added
  "%{user_name} a supprimé la politique de SLA %{sla_name}", // sla.removed
  "%{user_name} a supprimé la priorité", // priority.removed
  "%{user_name} added SLA policy %{sla_name}", // sla.added
  "%{user_name} adicionou política de SLA %{sla_name}", // sla.added
  "%{user_name} adicionou uma política de SLA %{sla_name}", // sla.added
  "%{user_name} agregó la política de SLA %{sla_name}", // sla.added
  "%{user_name} eliminat prioritatea", // priority.removed
  "%{user_name} fjernet tildelingen til samtalen", // assignee.removed
  "%{user_name} ha afegit la política de SLA %{sla_name}", // sla.added
  "%{user_name} ha aggiunto la policy SLA %{sla_name}", // sla.added
  "%{user_name} ha eliminat la política de SLA %{sla_name}", // sla.removed
  "%{user_name} ha eliminat la prioritat", // priority.removed
  "%{user_name} ha rimosso la policy SLA %{sla_name}", // sla.removed
  "%{user_name} ha rimosso la priorità", // priority.removed
  "%{user_name} hat SLA-Richtlinie %{sla_name} entfernt", // sla.removed
  "%{user_name} hat SLA-Richtlinie %{sla_name} hinzugefügt", // sla.added
  "%{user_name} hat die Priorität entfernt", // priority.removed
  "%{user_name} je dodal politiko SLA %{sla_name}", // sla.added
  "%{user_name} je odstranil politiko SLA %{sla_name}", // sla.removed
  "%{user_name} je odstranil prednost", // priority.removed
  "%{user_name} menghapus prioritasnya", // priority.removed
  "%{user_name} noņēma SLA politiku %{sla_name}", // sla.removed
  "%{user_name} noņēma piešķiršanu", // assignee.removed
  "%{user_name} noņēma piešķiršanu %{team_name}", // team.removed
  "%{user_name} noņēma prioritāti", // priority.removed
  "%{user_name} pašalino prioritetą", // priority.removed
  "%{user_name} pievienoja SLA politiku %{sla_name}", // sla.added
  "%{user_name} removed SLA policy %{sla_name}", // sla.removed
  "%{user_name} removed the priority", // priority.removed
  "%{user_name} removeu a política de SLA %{sla_name}", // sla.removed
  "%{user_name} removeu a política de SLA de %{sla_name}", // sla.removed
  "%{user_name} removeu a prioridade", // priority.removed
  "%{user_name} видалив політику SLA %{sla_name}", // sla.removed
  "%{user_name} видалив пріоритет", // priority.removed
  "%{user_name} добавил политику SLA %{sla_name}", // sla.added
  "%{user_name} додав політику SLA %{sla_name}", // sla.added
  "%{user_name} удалил политику SLA %{sla_name}", // sla.removed
  "%{user_name} удалил приоритет", // priority.removed
  "%{user_name} הוסיף מדיניות SLA %{sla_name}", // sla.added
  "%{user_name} הסיר את העדיפות", // priority.removed
  "%{user_name} הסיר מדיניות SLA %{sla_name}", // sla.removed
  "%{user_name} أزال الأولوية", // priority.removed
  "%{user_name} أزال سياسة مستوى الخدمة %{sla_name}", // sla.removed
  "%{user_name} أضاف سياسة مستوى الخدمة %{sla_name}", // sla.added
  "%{user_name} ले SLA नीति %{sla_name} हटाए", // sla.removed
  "%{user_name} ले प्राथमिकता हटाए", // priority.removed
  "%{user_name} 新增了 SLA 政策 %{sla_name}", // sla.added
  "%{user_name} 移除了 SLA 政策 %{sla_name}", // sla.removed
  "%{user_name} 移除了 SLA 策略 %{sla_name}", // sla.removed
  "%{user_name}, %{sla_name} adlı SLA politikasını kaldırdı", // sla.removed
  "%{user_name}님이 SLA 정책 %{sla_name}을(를) 제거했습니다", // sla.removed
  "%{user_name}님이 SLA 정책 %{sla_name}을(를) 추가했습니다", // sla.added
  "Idinagdag ni %{user_name} ang patakaran ng SLA na %{sla_name}", // sla.added
  "Samtale fjernet tildeling af %{user_name}", // assignee.removed
];

// `%{user_name}` and every other placeholder is somebody's name, which we never need; `%{labels}` is
// the run. Anchored at both ends, so a sentence that merely CONTAINS a template's words does not
// match it.
function compile(templates: readonly string[]): RegExp[] {
  return templates.map(
    (t) =>
      new RegExp(
        `^${t
          .split(/(%\{\w+\})/g)
          .map((part) =>
            part === "%{labels}"
              ? "(.+)"
              : /^%\{\w+\}$/.test(part)
                ? "(?:.+?)"
                : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("")}$`,
        "u",
      ),
  );
}

const LABEL_ACTIVITY_PATTERNS: readonly RegExp[] = compile(
  LABEL_ACTIVITY_TEMPLATES,
);
const AMBIGUOUS_ACTIVITY_PATTERNS: readonly RegExp[] = compile(
  AMBIGUOUS_ACTIVITY_TEMPLATES,
);

// The titles a label-change sentence names, or `null` when no template rendered this line. The
// SEPARATOR is Chatwoot's own `", "`, so a title containing a comma and a space is split here and
// then fails the catalog check below, which is a miss and not a wrong reading.
export function labelsNarrated(content: string): string[] | null {
  const line = content.trim();
  if (line.length === 0) return null;
  if (AMBIGUOUS_ACTIVITY_PATTERNS.some((re) => re.test(line))) return null;
  for (const re of LABEL_ACTIVITY_PATTERNS) {
    const m = line.match(re);
    if (m?.[1] === undefined) continue;
    const titles = m[1].split(", ").map((t) => t.trim());
    if (titles.every((t) => t.length > 0)) return titles;
  }
  return null;
}
