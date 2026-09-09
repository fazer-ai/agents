-- `assign_label` became `set_labels` (issue #568): the tool no longer adds one label, it writes the
-- whole set the model asks for, and a name that says "add" would lie about a call that removes.
--
-- Three moves, and the last two are the ones a rename of a native usually does not need. They exist
-- because the OLD name is stored in a tenant's own rows, and every reader of those rows drops what
-- it does not recognise: silently, with a 200, and with the capability simply gone.
--
-- 1. TENANT TOOLS NAMED `set_labels`. Same reason as every other file of this name (see
--    20260903120000): the assembly reserves every native name granted or not
--    (src/graph/tools/unique-names.ts, #457), so a tenant row carrying the new name would stop
--    reaching the model the moment this migration's code ships. Moved to the first free
--    `<name>_N` in its own tenant, with the label following the name where the console would
--    derive the old one from it, and one audit line per moved row plus one per agent whose system
--    prompt names the tool. `tests/prisma/native-tool-names-renamed-by-migration.test.ts` asks for
--    this file by name.
--
--    BOTH TABLES, and the free-name search asks both too. HTTP tools and CODE tools are ONE
--    namespace to the model (code-tools/service.ts checks a new name against both) and both reach
--    `dropDuplicateToolNames`, so a code tool named `set_labels` is dropped by the same
--    reservation, and a candidate `set_labels_2` free among HTTP tools can be taken by a code tool.
--    The files of this name that predate `code_tool_definitions` (20260903140100) had only one
--    table to scan; this one has two.
--
-- 2. The GRANT. `agent_tool_selections` with source NATIVE holds the exact allowlist
--    (src/graph/tools/assemble.ts: an explicit row means EXACTLY this set, fail-closed), so an
--    agent granted `assign_label` and nothing else would come up with no label tool at all — not
--    an error anywhere, just an agent that stopped labelling. Only rows that do not ALREADY carry
--    the new name are touched, so the array cannot end up with it twice.
--
-- 3. The GUIDANCE. `settings.toolGuidance` is keyed by native tool name and `readToolGuidance`
--    drops every key that is not in the catalog, so the operator's "when to use this" note would
--    vanish from the description on the next turn with nothing to show it ever existed. Moved only
--    when the new key is absent, for the same reason as the grant.
--
-- 4. The PRECONDITION. `settings.toolPreconditions` is keyed by tool name too, and it is the one
--    entry here whose loss is not a lost capability but a lost GUARD: `readToolPreconditions` keeps
--    whatever name it finds and `applyToolPreconditions` matches by tool name, so a rule left under
--    the old name simply stops matching and the tool the operator fenced runs unfenced, with the
--    editor still showing the rule. The write side is stricter than the reader and would refuse the
--    next save outright (`isGuardableToolName` checks the KEY against the native catalog), so an
--    unmoved key also bricks settings saves for that agent. Same two-step as the guidance.
--
-- FORCE ROW LEVEL SECURITY binds the table owner too, so an UPDATE here would reach zero rows and
-- report success. Lifted on the four tables for the file and put back (.claude/rules/prisma.md).
--
-- ONE TRANSACTION, because the lift above is exactly the invariant `.claude/rules/prisma.md` names:
-- `migrate deploy` runs the file OUTSIDE a transaction, so a failure between the lift and the
-- restore leaves four tables no longer binding their own owner to the tenant policy, with the
-- migration marked applied and nothing in the log. `BEGIN`/`COMMIT` inside the `.sql` is honoured.
--
-- `console_tool_name` is copied VERBATIM from 20260903120000, translate table and all, because it
-- has to answer what the console's `normalizeToolName` answers: the console submits
-- `normalizeToolName(label)` as the name on every save, so a moved row whose label still derives
-- the reserved name can never be saved from there again. A simplified version would get every
-- diacritic wrong, which is exactly the case rounds 21 and 22 of PR #485 were about.
CREATE OR REPLACE FUNCTION pg_temp.console_tool_name(label text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT coalesce(
    nullif(
      left(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(translate(label, 'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳḀḁḂḃḄḅḆḇḈḉḊḋḌḍḎḏḐḑḒḓḔḕḖḗḘḙḚḛḜḝḞḟḠḡḢḣḤḥḦḧḨḩḪḫḬḭḮḯḰḱḲḳḴḵḶḷḸḹḺḻḼḽḾḿṀṁṂṃṄṅṆṇṈṉṊṋṌṍṎṏṐṑṒṓṔṕṖṗṘṙṚṛṜṝṞṟṠṡṢṣṤṥṦṧṨṩṪṫṬṭṮṯṰṱṲṳṴṵṶṷṸṹṺṻṼṽṾṿẀẁẂẃẄẅẆẇẈẉẊẋẌẍẎẏẐẑẒẓẔẕẖẗẘẙẠạẢảẤấẦầẨẩẪẫẬậẮắẰằẲẳẴẵẶặẸẹẺẻẼẽẾếỀềỂểỄễỆệỈỉỊịỌọỎỏỐốỒồỔổỖỗỘộỚớỜờỞởỠỡỢợỤụỦủỨứỪừỬửỮữỰựỲỳỴỵỶỷỸỹKÅ^`¨¯´·¸ʰʱʲʳʴʵʶʷʸʹʺʻʼʽʾʿˀˁ˂˃˄˅ˆˇˈˉˊˋˌˍˎˏːˑ˒˓˔˕˖˗˘˙˚˛˜˝˞˟ˠˡˢˣˤ˥˦˧˨˩˪˫ˬ˭ˮ˯˰˱˲˳˴˵˶˷˸˹˺˻˼˽˾˿̴̵̶̷̸̡̢̧̨̛̖̗̘̙̜̝̞̟̠̣̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓͔͕͖̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̏̐̑̒̓̔̽̾̿̀́͂̓̈́͆͊͋͌͐͑͒͗̕̚͟͢͝͞͠͡ͅʹ͵ͺ΄΅·҃҄҅҆҇ՙְֱֲֳִֵֶַָׇֹֺֻּֽֿׁׂًٌٍَُِّْ֑֖֛֢֣֤֥֦֧֪ׅ֚֭֮֒֓֔֕֗֘֙֜֝֞֟֠֡֨֩֫֬֯ׄٗ٘۟۠ۥۦ۪ܱܴܷܸܹܻܼܾ݂݄݆݈۫۬ܰܲܳܵܶܺܽܿ݀݁݃݅݇݉݊ަާިީުޫެޭޮޯް߲߫߬߭߮߯߰߱߳ߴߵ࢙࢚࢛࠘࠙࢘࢜࢝࢞࢟ࣉ़्ࣰࣱࣲ࣏࣐࣑࣒ࣣࣦࣩ࣭࣮࣯ࣶࣹࣺ॒࣊࣋࣌࣍࣎ࣤࣥࣧࣨ࣪࣫࣬ࣳࣴࣵࣷࣸࣻࣼࣽࣾ॑॓॔ॱ়਼઼্੍્૽૾૿଼୍୕఼಼்్್഻഼്්ฺ็่้๊๋์๎຺່້໊໋໌༹༘༙༵༷༾༿့྄္်࿆ྂྃ྆྇ၣၤၩၪၫၬၭႇႈႉႊႋႌႍႏႚႛ᜔᜕᜴፝፞፟៉៊់៌៍៎៏័៑្៓᩠᤻᩿᪵᪶᪷᪸᪹᪺᪽᤹៝᤺᩵᩶᩷᩸᩹᩺᩻᩼᪰᪱᪲᪳᪴᪻᪼᪾᫃᫄᫊᫁᫂᫅᫆᫇᫈᫉᫋᫏᫐᫑᫒᫓᫔᫕᫖᫗᫘᫙᫚᫛᫜᫝᫠᫡᫢᫣᫤᫥᫦᫧᫨᫩᫪᫫᬴᯦᭄᮪᮫᯲᯳᭬᭫᭭᭮᭯᭰᭱᭲᭳ᰶ᰷ᱸᱹᱺᱻᱼᱽ᳐᳑᳒᳓᳔᳕᳖᳗᳘᳙᳜᳝᳞᳟᳚᳛᳠᳡᳢᳣᳤᳥᳦᳧᳨᳭᳴᳷᳸᳹ᴬᴭᴮᴯᴰᴱᴲᴳᴴᴵᴶᴷᴸᴹᴺᴻᴼᴽᴾᴿᵀᵁᵂᵃᵄᵅᵆᵇᵈᵉᵊᵋᵌᵍᵎᵏᵐᵑᵒᵓᵔᵕᵖᵗᵘᵙᵚᵛᵜᵝᵞᵟᵠᵡᵢᵣᵤᵥᵦᵧᵨᵩᵪᶛᶜᶝᶞᶟᶠᶡᶢᶣᶤᶥᶦᶧᶨᶩᶪᶫᶬᶭᶮᶯᶰᶱᶲᶳᶴᶵᶶᶷᶸᶹᶺᶻᶼᶽᶾ᷎᷺᷊᷏᷹᷽᷿᷷᷸᷄᷅᷆᷇᷈᷉᷋᷌᷵᷻᷾᷶᷼᷍᾽᾿῀῁῍῎῏῝῞῟῭΅`´῾⳯⳰⳱ⸯ゙゚〪〭〮〯〫〬゛゜ー꙯꙼꙽ꙿꚜꚝ꛰꛱꜀꜁꜂꜃꜄꜅꜆꜇꜈꜉꜊꜋꜌꜍꜎꜏꜐꜑꜒꜓꜔꜕꜖ꜗꜘꜙꜚꜛꜜꜝꜞꜟ꜠꜡ꞈ꞉꞊꟱ꟸꟹ꠆꠬꣄꤫꤬꤭꣠꣡꣢꣣꣤꣥꣦꣧꣨꣩꣪꣫꣬꣭꣮꣯꣰꣱꤮꦳꥓꧀ꧥꩻꩼꩽ꪿ꫀ꫁ꫂ꫶꭛ꭜꭝꭞꭟꭩ꭪꭫꯬꯭ﬞ︧︨︩︪︫︬︭︠︡︢︣︤︥︦︮︯＾｀ｰﾞﾟ￣𐋠𐞀𐞁𐞂𐞃𐞄𐞅𐞇𐞈𐞉𐞊𐞋𐞌𐞍𐞎𐞏𐞐𐞑𐞒𐞓𐞔𐞕𐞖𐞗𐞘𐞙𐞚𐞛𐞜𐞝𐞞𐞟𐞠𐞡𐞢𐞣𐞤𐞥𐞦𐞧𐞨𐞩𐞪𐞫𐞬𐞭𐞮𐞯𐞰𐞲𐞳𐞴𐞵𐞶𐞷𐞸𐞹𐞺𐨹𐨿𐨺𐫦𐨸𐫥𐴢𐴣𐴤𐴥𐴦𐴧𐵎𐵩𐵪𐵫𐵬𐵭𐻺𑂺𑅳𑇊𑁆𑁰𑂹𑄳𑄴𑇀𐻽𐻾𐻿𐽆𐽇𐽋𐽍𐽎𐽏𐽐𐾃𐾅𐽈𐽉𐽊𐽌𐾂𐾄𑇋𑇌𑈶𑋩𑌻𑌼𑈵𑋪𑍍𑏎𑏏𑏐𑍦𑍧𑍨𑍩𑍪𑍫𑍬𑍰𑍱𑍲𑍳𑍴𑏒𑏓𑏡𑏢𑑆𑓃𑗀𑚷𑠺𑥃𑵂𑑂𑓂𑖿𑘿𑚶𑜫𑠹𑤽𑤾𑧠𑨴𑩇𑪙𑰿𑵄𑵅𑶗𑷙𑽁𑽂𑽚𓑇𓑈𓑉𓑊𓑋𓑌𓑍𓑎𓑏𓑐𓑑𓑒𓑓𓑔𓑕𖫰𖫱𖫲𖫳𖫴𖄯𖬰𖬱𖬲𖬳𖬴𖬵𖬶𖵫𖵬𖾏𖾐𖾑𖾒𖾓𖾔𖾕𖾖𖾗𖾘𖾙𖾚𖾛𖾜𖾝𖾞𖾟𖿰𖿱𚿰𚿱𚿲𚿳𚿵𚿶𚿷𚿸𚿹𚿺𚿻𚿽𚿾𜼀𜼁𜼂𜼃𜼄𜼅𜼆𜼇𜼈𜼉𜼊𜼋𜼌𜼍𜼎𜼏𜼐𜼑𜼒𜼓𜼔𜼕𜼖𜼗𜼘𜼙𜼚𜼛𜼜𜼝𜼞𜼟𜼠𜼡𜼢𜼣𜼤𜼥𜼦𜼧𜼨𜼩𜼪𜼫𜼬𜼭𜼰𜼱𜼲𜼳𜼴𜼵𜼶𜼷𜼸𜼹𜼺𜼻𜼼𜼽𜼾𜼿𜽀𜽁𜽂𜽃𜽄𜽅𜽆𝅧𝅨𝅩𝅮𝅯𝅰𝅱𝅲𝅻𝅼𝅽𝅾𝅿𝆀𝆁𝆂𝆊𝆋𝅭𝆅𝆆𝆇𝆈𝆉𝆪𝆫𝆬𝆭𞀰𞀱𞀲𞀳𞀴𞀵𞀶𞀷𞀸𞀹𞀺𞀻𞀼𞀽𞀾𞀿𞁀𞁁𞁂𞁃𞁄𞁅𞁆𞁇𞁈𞁉𞁊𞁋𞁌𞁍𞁎𞁏𞁐𞁑𞁒𞁓𞁔𞁕𞁖𞁗𞁘𞁙𞁚𞁛𞁜𞁝𞁞𞁟𞁠𞁡𞁢𞁣𞁤𞁥𞁦𞁧𞁨𞁩𞁪𞁫𞁬𞁭𞥊𞗯𞣐𞣑𞣒𞣓𞣔𞣕𞣖𞄰𞄱𞄲𞄳𞄴𞄵𞄶𞊮𞋬𞋭𞋮𞋯𞗮𞥄𞥅𞥆𞥈𞥉', 'aaaaaaceeeeiiiinooooouuuuyaaaaaaceeeeiiiinooooouuuuyyaaaaaaccccccccddeeeeeeeeeegggggggghhiiiiiiiiijjkkllllllnnnnnnoooooorrrrrrssssssssttttuuuuuuuuuuuuwwyyyzzzzzzoouuaaiioouuuuuuuuuuaaaaggkkoooojggnnaaaaaaeeeeiiiioooorrrruuuusstthhaaeeooooooooyyaabbbbbbccddddddddddeeeeeeeeeeffgghhhhhhhhhhiiiikkkkkkllllllllmmmmmmnnnnnnnnoooooooopppprrrrrrrrssssssssssttttttttuuuuuuuuuuvvvvwwwwwwwwwwxxxxyyzzzzzzhtwyaaaaaaaaaaaaaaaaaaaaaaaaeeeeeeeeeeeeeeeeiiiioooooooooooooooooooooooouuuuuuuuuuuuuuyyyyyyyyka')),
              '[^a-z0-9_-]', '_', 'g'),
            '_+', '_', 'g'),
          '^_+|_+$', '', 'g'),
        64),
      ''),
    'tool')
$fn$;

BEGIN;

ALTER TABLE "tool_definitions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_selections" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r RECORD;
  ag RECORD;
  candidate TEXT;
  new_label TEXT;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT 'http' AS src, id, tenant_id, name, label FROM "tool_definitions" WHERE name IN ('set_labels')
    UNION ALL
    SELECT 'code' AS src, id, tenant_id, name, label FROM "code_tool_definitions" WHERE name IN ('set_labels')
    ORDER BY src, id
  LOOP
    n := 2;
    LOOP
      candidate := r.name || '_' || n;
      -- ...FREE IN BOTH TABLES. One namespace reaches the model, so a candidate that only clears
      -- the table being scanned lands on the other one's row and neither survives assembly.
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "tool_definitions" WHERE tenant_id = r.tenant_id AND name = candidate
      ) AND NOT EXISTS (
        SELECT 1 FROM "code_tool_definitions" WHERE tenant_id = r.tenant_id AND name = candidate
      );
      n := n + 1;
    END LOOP;
    new_label := CASE
      WHEN pg_temp.console_tool_name(r.label) <> r.name THEN r.label
      WHEN length(r.label || ' ' || n) > 200 THEN candidate
      ELSE r.label || ' ' || n
    END;
    IF r.src = 'http' THEN
      UPDATE "tool_definitions" SET name = candidate, label = new_label, updated_at = NOW() WHERE id = r.id;
    ELSE
      UPDATE "code_tool_definitions" SET name = candidate, label = new_label, updated_at = NOW() WHERE id = r.id;
    END IF;
    -- The target carries the KIND, because the two tables have independent id sequences and
    -- `tool:7` would otherwise name two different tools.
    INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
    VALUES (
      r.tenant_id, NULL, 'system', 'tool.renamed_by_upgrade',
      CASE WHEN r.src = 'http' THEN 'tool:' ELSE 'code_tool:' END || r.id,
      jsonb_build_object('name', r.name, 'label', r.label), jsonb_build_object('name', candidate, 'label', new_label), NOW()
    );
    -- strpos, not LIKE: the underscore in the name is a LIKE wildcard.
    FOR ag IN
      SELECT id FROM "agents"
      WHERE tenant_id = r.tenant_id AND strpos(system_prompt, r.name) > 0
      ORDER BY id
    LOOP
      INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
      VALUES (
        r.tenant_id, NULL, 'system', 'agent.prompt_names_renamed_tool', 'agent:' || ag.id,
        NULL, jsonb_build_object('tool', r.name, 'renamed', candidate), NOW()
      );
    END LOOP;
  END LOOP;
END $$;

-- The grant. array_replace would also work, but the guard against a row already carrying the new
-- name is what keeps the allowlist from listing it twice.
UPDATE "agent_tool_selections"
SET enabled_tools = array_replace(enabled_tools, 'assign_label', 'set_labels'),
    updated_at = NOW()
WHERE source = 'NATIVE'
  AND 'assign_label' = ANY(enabled_tools)
  AND NOT ('set_labels' = ANY(enabled_tools));

-- ...and the row that carries BOTH (an operator who granted the HTTP tool renamed above under the
-- native's name): drop the old one rather than duplicating the new.
UPDATE "agent_tool_selections"
SET enabled_tools = array_remove(enabled_tools, 'assign_label'),
    updated_at = NOW()
WHERE source = 'NATIVE'
  AND 'assign_label' = ANY(enabled_tools)
  AND 'set_labels' = ANY(enabled_tools);

-- The guidance note, keyed by tool name inside the settings bag. `settings` is JSONB and NOT NULL,
-- so the only guard needed is that `toolGuidance` is an object: a row where it is a string, a list
-- or absent has no key to move, and `#>` on a non-object would yield NULL and blank the column.
UPDATE "agents"
SET settings = jsonb_set(
      settings #- '{toolGuidance,assign_label}',
      '{toolGuidance,set_labels}',
      settings #> '{toolGuidance,assign_label}'
    ),
    updated_at = NOW()
WHERE jsonb_typeof(settings -> 'toolGuidance') = 'object'
  AND jsonb_exists(settings -> 'toolGuidance', 'assign_label')
  AND NOT jsonb_exists(settings -> 'toolGuidance', 'set_labels');

-- Both keys present: the new one is the operator's most recent word, so the old one just goes.
UPDATE "agents"
SET settings = settings #- '{toolGuidance,assign_label}',
    updated_at = NOW()
WHERE jsonb_typeof(settings -> 'toolGuidance') = 'object'
  AND jsonb_exists(settings -> 'toolGuidance', 'assign_label');

-- The precondition, same shape and same two steps. Not a duplicate of the block above for the sake
-- of symmetry: this is a different key with a different failure. A guidance note left behind is a
-- hint that stops appearing; a PRECONDITION left behind is a tool the operator fenced that now runs
-- unfenced, and the editor keeps showing the fence.
UPDATE "agents"
SET settings = jsonb_set(
      settings #- '{toolPreconditions,assign_label}',
      '{toolPreconditions,set_labels}',
      settings #> '{toolPreconditions,assign_label}'
    ),
    updated_at = NOW()
WHERE jsonb_typeof(settings -> 'toolPreconditions') = 'object'
  AND jsonb_exists(settings -> 'toolPreconditions', 'assign_label')
  AND NOT jsonb_exists(settings -> 'toolPreconditions', 'set_labels');

UPDATE "agents"
SET settings = settings #- '{toolPreconditions,assign_label}',
    updated_at = NOW()
WHERE jsonb_typeof(settings -> 'toolPreconditions') = 'object'
  AND jsonb_exists(settings -> 'toolPreconditions', 'assign_label');

ALTER TABLE "agent_tool_selections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;

COMMIT;
