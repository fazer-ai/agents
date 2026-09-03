-- An HTTP tool named after a native tool never reaches the model: the assembly reserves every
-- native name, granted or not (src/graph/tools/unique-names.ts, #457), and drops the other claimant
-- with a flow-log line as the only trace. The service now refuses such a name where it is typed and
-- the import renames a bundled tool that carries one; this moves the rows written before either
-- check existed, to the first free `<name>_N` in their own tenant. The grant references the row by
-- id and follows it. The label follows the name where the console would derive the old name from
-- it: the console submits `normalizeToolName(label)` as the name on every save (the label is its
-- single source of truth), so a moved row whose label still derived the reserved name could never
-- be saved again from there (round 20). "Run code" becomes "Run code 3" for `run_code_3`; a label
-- that never derived the name is the operator's own and does not move. The derivation is the
-- console's `normalizeToolName`, step for step: its NFD-and-strip-\p{Diacritic} step is a translate
-- table generated from the runtime's own Unicode over every code point (scripts/tool-name-translate-table.ts): each
-- one whose NFD, minus the diacritics, is a single ASCII letter maps to that letter lowercased
-- (490 of them: the Latin blocks, and the lookalikes such as U+212B ANGSTROM SIGN, round 22), and
-- each \p{Diacritic} that is not a letter or a digit is deleted (1,248: the combining marks for a
-- label spelled decomposed, and the spacing ones such as ^ and `), then the ASCII case fold, the
-- non-name characters to "_", the collapse, the trim, the cap at 64, "tool" for nothing left. A
-- temporary function, so the test can ask it the console's answer on every character of the table
-- and on every code point of the first two planes (round 21).
--
-- A label the suffix would push past the authoring limit (200) becomes the new name itself, which
-- derives to itself; appended, it would lock the row out of the console the other way (round 22).
--
-- What the rename cannot follow is a PROMPT that names the tool: after this, "chame run_code" reaches
-- the native, or a name no tool answers to. So the move is written to the audit trail under the
-- system actor — one line per moved row, and one per agent of that tenant whose system prompt
-- contains the old name — which is the operator's list of what to edit, and the only durable record
-- of an upgrade's own change.
--
-- The list is the catalog at the time of writing (src/graph/tools/catalog.ts); a name added later
-- ships with its own file of this name, which
-- tests/prisma/native-tool-names-renamed-by-migration.test.ts asks for.
--
-- FORCE ROW LEVEL SECURITY binds the table owner too, so the owner's UPDATE and INSERT would reach
-- zero rows and report success — and so would the SELECT over "agents" that decides which audit
-- lines to write (round 19: the rename landed, the lines did not). Lifted on the three tables for
-- the file and put back (.claude/rules/prisma.md).
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
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r RECORD;
  ag RECORD;
  candidate TEXT;
  new_label TEXT;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT id, tenant_id, name, label
    FROM "tool_definitions"
    WHERE name IN (
      'handoff_to_human', 'private_note', 'set_custom_attribute', 'assign_label',
      'resolve_conversation', 'kanban_move_card', 'update_kanban_task', 'set_voice_preference',
      'react_to_message', 'send_image', 'skip_reply', 'calculator', 'get_current_time', 'run_code'
    )
    ORDER BY id
  LOOP
    n := 2;
    LOOP
      candidate := r.name || '_' || n;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "tool_definitions" WHERE tenant_id = r.tenant_id AND name = candidate
      );
      n := n + 1;
    END LOOP;
    new_label := CASE
      WHEN pg_temp.console_tool_name(r.label) <> r.name THEN r.label
      WHEN length(r.label || ' ' || n) > 200 THEN candidate
      ELSE r.label || ' ' || n
    END;
    UPDATE "tool_definitions" SET name = candidate, label = new_label, updated_at = NOW() WHERE id = r.id;
    INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
    VALUES (
      r.tenant_id, NULL, 'system', 'tool.renamed_by_upgrade', 'tool:' || r.id,
      jsonb_build_object('name', r.name, 'label', r.label), jsonb_build_object('name', candidate, 'label', new_label), NOW()
    );
    -- strpos, not LIKE: the underscore in every one of these names is a LIKE wildcard.
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

ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
