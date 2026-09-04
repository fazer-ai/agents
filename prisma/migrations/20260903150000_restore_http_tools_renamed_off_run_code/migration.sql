-- `run_code` stopped being a native tool in this release: no native takes code from the model any
-- more (issue #363, and the PR that removes it). The migration one window earlier
-- (20260903120000_rename_http_tools_named_after_natives) moved every HTTP tool named after a native
-- out of the way, `run_code` among them, because a row under a native's name never reaches the
-- model. That reason is gone for this one name, and a name an operator chose should not stay moved
-- because of a tool that no longer exists.
--
-- The move is undone from the AUDIT TRAIL the rename itself wrote, not by guessing: a row is
-- restored only when a `tool.renamed_by_upgrade` line says this migration moved it off `run_code`,
-- and only while the row still carries exactly the name and label that line left it with. A tool an
-- operator has renamed or relabelled since is theirs, and is not touched; a tenant that has taken
-- `run_code` in the meantime (an HTTP tool, or a code tool of the new kind) keeps what it has.
--
-- The restore writes its own audit line, symmetric with the move: an upgrade that changes an
-- exposed name is exactly what an operator has to be able to read afterwards, in both directions.
-- What it cannot fix is a PROMPT edited to say `run_code_2` in the meantime; the trail is the list.
--
-- "Has the tenant taken the name" is asked of the name the MODEL sees, not of the stored spelling.
-- Names were only canonicalized on write by the PR this migration ships in, so a database reaching
-- it can hold `Run_Code` or `run__code` from before: legal then, and `sanitizeToolName` derives
-- `run_code` from each of them at assembly. An exact comparison reads those as free, restores on
-- top of them, and leaves two rows answering to one name, where the assembly drops whichever comes
-- second and neither can be saved from the console again. The derivation below is the one the
-- earlier migration used, copied rather than referenced because a migration is frozen by design and
-- `pg_temp` does not outlive the session that created it.
--
-- RLS: a data migration lifts FORCE on every forced table it writes AND reads, and restores it
-- (.claude/rules/prisma.md, tests/prisma/migration-rls-bypass.test.ts).

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

WITH moved AS (
  SELECT
    a.id AS audit_id,
    a.tenant_id,
    split_part(a.target, ':', 2)::bigint AS tool_id,
    a."before" ->> 'name' AS old_name,
    a."before" ->> 'label' AS old_label,
    a."after" ->> 'name' AS new_name,
    a."after" ->> 'label' AS new_label
  FROM "audit_logs" a
  WHERE a.action = 'tool.renamed_by_upgrade'
    AND a.target LIKE 'tool:%'
    AND a."before" ->> 'name' = 'run_code'
), restorable AS (
  SELECT m.*
  FROM moved m
  JOIN "tool_definitions" t ON t.id = m.tool_id
  WHERE t.tenant_id = m.tenant_id
    AND t.name = m.new_name
    AND t.label = m.new_label
    AND NOT EXISTS (
      SELECT 1 FROM "tool_definitions" o
      WHERE o.tenant_id = m.tenant_id
        AND o.id <> m.tool_id
        AND pg_temp.console_tool_name(o.name) = m.old_name
    )
    AND NOT EXISTS (
      SELECT 1 FROM "code_tool_definitions" c
      WHERE c.tenant_id = m.tenant_id
        AND pg_temp.console_tool_name(c.name) = m.old_name
    )
), restored AS (
  UPDATE "tool_definitions" t
  SET name = r.old_name, label = r.old_label, updated_at = NOW()
  FROM restorable r
  WHERE t.id = r.tool_id
  RETURNING t.id, r.tenant_id, r.old_name, r.old_label, r.new_name, r.new_label
)
INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
SELECT
  restored.tenant_id, NULL, 'system', 'tool.renamed_by_upgrade', 'tool:' || restored.id,
  jsonb_build_object('name', restored.new_name, 'label', restored.new_label),
  jsonb_build_object('name', restored.old_name, 'label', restored.old_label),
  NOW()
FROM restored;

ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
