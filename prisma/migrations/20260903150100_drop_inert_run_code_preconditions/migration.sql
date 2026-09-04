-- A precondition (#101) is keyed by TOOL NAME, and the seam that applies it is deliberately
-- source-agnostic: one map reaches native, HTTP, code, document, MCP and toolpack tools, because
-- they have already been merged into one name-unique list by the time it runs (graph/prepare.ts,
-- and the note above `emptyMap` in modules/agents/tool-preconditions.ts).
--
-- `run_code` stops being a tool name this release owns. The rule keyed to it is therefore about to
-- name nothing, and an inert rule is worse than no rule: the console cannot show it (the editor
-- lists guardable names, and after this release `run_code` is not one), so it sits in the settings
-- bag where nobody can read it or remove it.
--
-- What it must NOT do is delete a rule that still guards something. Only a NATIVE name passes the
-- write boundary (`isGuardableToolName`), but an agent IMPORT copies a settings bag verbatim, and
-- the runtime honours a non-native key when the name matches a tool that exists -- deliberately,
-- and documented where that reader lives. So a bundle can carry a rule keyed `run_code` for an HTTP
-- tool of that name, and the migration one window earlier (20260903120000) moved exactly such tools
-- to `<name>_N`, with the one before this (20260903150000) putting them back. Deleting the key
-- unconditionally would hand those tools back their name without the condition they were imported
-- with: callable, ungated, and no line anywhere saying a guard was dropped (round 32).
--
-- So the question is asked of the state AFTER the restore, which is why this runs after it: does
-- anything in this tenant still answer to `run_code`? If it does, the rule keeps guarding it and
-- stays; if nothing does, the rule names nothing and goes. The direction of the doubt is deliberate:
-- a rule kept alive is a refusal an operator can see happening, and a rule deleted is a guard that
-- silently stops existing.
--
-- "Answers to" is the name the MODEL sees, not the stored spelling, for the reason the restore
-- spells out: names were only canonicalized on write by the PR this ships in, so a database can
-- hold `Run_Code` or `run__code`, and `sanitizeToolName` derives `run_code` from each. The
-- derivation is the one both earlier migrations used, copied rather than referenced because a
-- migration is frozen by design and `pg_temp` does not outlive the session that made it.
--
-- The two DB-backed kinds are asked; an MCP or toolpack tool exposing the name keeps the key by
-- default, which is the same safe direction. Data migration over FORCE RLS tables: lifted for the
-- statement on every table it writes AND reads, restored after (.claude/rules/prisma.md). The write
-- is idempotent: a second run matches no row.

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

ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" NO FORCE ROW LEVEL SECURITY;

UPDATE "agents" a
   SET "settings" = jsonb_set(
         a."settings",
         '{toolPreconditions}',
         (a."settings" -> 'toolPreconditions') - 'run_code'),
       "updated_at" = NOW()
 WHERE jsonb_typeof(a."settings" -> 'toolPreconditions') = 'object'
   AND (a."settings" -> 'toolPreconditions') ? 'run_code'
   AND NOT EXISTS (
     SELECT 1 FROM "tool_definitions" t
      WHERE t.tenant_id = a.tenant_id
        AND pg_temp.console_tool_name(t.name) = 'run_code'
   )
   AND NOT EXISTS (
     SELECT 1 FROM "code_tool_definitions" c
      WHERE c.tenant_id = a.tenant_id
        AND pg_temp.console_tool_name(c.name) = 'run_code'
   );

ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
