-- `open_case_in_inbox` is a new native tool (issue #700), and a native name is RESERVED: the assembly
-- drops any other tool that claims it, granted or not (src/graph/tools/unique-names.ts, #457). A
-- tenant's HTTP or code tool already named `open_case_in_inbox` would stop reaching the model the
-- moment this code ships, so it moves to the first free `<name>_N` in its own tenant, free in BOTH
-- tables because they are one namespace to the model. Same body as 20260909120000 (its first block;
-- the grant and guidance moves of that file were about a RENAMED native and do not apply to a new
-- one), including the console's `normalizeToolName` as `pg_temp.console_tool_name`, the label that
-- follows the name, the operator's rules that follow the row, and one audit line per moved row plus
-- one per agent whose system prompt names the tool.
-- `tests/prisma/native-tool-names-renamed-by-migration.test.ts` asks for this file by name.
--
-- FORCE ROW LEVEL SECURITY binds the table owner too, so the owner's writes would reach zero rows
-- and report success. Lifted on the tables this file writes or reads for the file and put back
-- (.claude/rules/prisma.md).
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
  -- HTTP FIRST, because that is the order the ASSEMBLY resolves a duplicate in (prepare.ts: native,
  -- document, http, code, mcp, toolpack, rag — first wins, `dropDuplicateToolNames`). The two
  -- tables are one namespace and each service refuses a name the other holds, but the pre-lock race
  -- under READ COMMITTED and an old bundle can both land two rows under one name (namespace.ts) —
  -- and for an agent granting both, the rule the operator wrote guarded the HTTP tool, because that
  -- is the one that reached the model. Walking CODE first moved the rule onto the loser and deleted
  -- the key, leaving the winner unguarded: a guard silently gone, which is the exact failure this
  -- whole block exists to prevent (review round 34).
  --
  -- Ordered in a SUBQUERY: a UNION's own ORDER BY takes output column names, not an expression over
  -- them, and the version that did aborted the deploy transaction rather than failing one statement.
  FOR r IN
    SELECT * FROM (
      SELECT 'http' AS src, id, tenant_id, name, label FROM "tool_definitions" WHERE name IN ('open_case_in_inbox')
      UNION ALL
      SELECT 'code' AS src, id, tenant_id, name, label FROM "code_tool_definitions" WHERE name IN ('open_case_in_inbox')
    ) dup
    ORDER BY CASE WHEN src = 'http' THEN 0 ELSE 1 END, id
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
    -- ...AND THE OPERATOR'S RULES FOLLOW THE ROW. `settings.toolPreconditions` and
    -- `settings.toolGuidance` are keyed by tool NAME, so a rule written for this custom tool stays
    -- on `open_case_in_inbox` while the tool answers as `open_case_in_inbox_N`. Left alone it does not merely go
    -- inert: `open_case_in_inbox` becomes a NATIVE name the moment this code ships, so the operator's rule
    -- silently re-attaches to a DIFFERENT tool — a guard moved onto something nobody guarded, and
    -- not even the unmatched-precondition warning to say so.
    --
    -- Only agents that GRANT this row, because for an agent that does not, `open_case_in_inbox` after this
    -- migration means the native tool and the rule is already about the right thing. The write
    -- boundary refuses a non-native precondition key (isGuardableToolName), so these bags arrive by
    -- agent IMPORT, which copies settings verbatim — the case tool-preconditions.ts names.
    FOR ag IN
      SELECT a.id
      FROM "agents" a
      JOIN "agent_tool_selections" sel
        ON sel.agent_id = a.id
       AND (
         (r.src = 'http' AND sel.tool_definition_id = r.id)
         OR (r.src = 'code' AND sel.code_tool_definition_id = r.id)
       )
      WHERE a.tenant_id = r.tenant_id
      ORDER BY a.id
    LOOP
      -- MOVE WHEN THE DESTINATION IS FREE, and REMOVE THE OLD KEY EITHER WAY. The two halves are
      -- separate statements on purpose: skipping the whole thing when the destination is already
      -- taken (a leftover `open_case_in_inbox_2` rule from an earlier import) leaves the custom tool's
      -- rule sitting on `open_case_in_inbox`, where the native would inherit it. A key that named a tool which no longer answers to it has to
      -- go whether or not its value found a new home.
      UPDATE "agents"
      SET settings = jsonb_set(
            settings,
            ARRAY['toolPreconditions', candidate],
            settings #> ARRAY['toolPreconditions', r.name]
          ),
          updated_at = NOW()
      WHERE id = ag.id
        AND jsonb_typeof(settings -> 'toolPreconditions') = 'object'
        AND jsonb_exists(settings -> 'toolPreconditions', r.name)
        AND NOT jsonb_exists(settings -> 'toolPreconditions', candidate);
      UPDATE "agents"
      SET settings = settings #- ARRAY['toolPreconditions', r.name],
          updated_at = NOW()
      WHERE id = ag.id
        AND jsonb_typeof(settings -> 'toolPreconditions') = 'object'
        AND jsonb_exists(settings -> 'toolPreconditions', r.name);
      UPDATE "agents"
      SET settings = jsonb_set(
            settings,
            ARRAY['toolGuidance', candidate],
            settings #> ARRAY['toolGuidance', r.name]
          ),
          updated_at = NOW()
      WHERE id = ag.id
        AND jsonb_typeof(settings -> 'toolGuidance') = 'object'
        AND jsonb_exists(settings -> 'toolGuidance', r.name)
        AND NOT jsonb_exists(settings -> 'toolGuidance', candidate);
      UPDATE "agents"
      SET settings = settings #- ARRAY['toolGuidance', r.name],
          updated_at = NOW()
      WHERE id = ag.id
        AND jsonb_typeof(settings -> 'toolGuidance') = 'object'
        AND jsonb_exists(settings -> 'toolGuidance', r.name);
    END LOOP;
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

ALTER TABLE "agent_tool_selections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
