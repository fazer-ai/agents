-- O RECIBO DAS MORTES QUE JÁ FORAM ANUNCIADAS ANTES DE ELE EXISTIR (issue #737, review rodada 3).
--
-- A partir desta entrega, quem anuncia a morte de um job carimba `deadLetterAnnouncedFor` no payload
-- da linha, com a claim a que a morte pertenceu, e o revoke que apaga a linha usa esse carimbo para
-- saber se ainda deve o anúncio. Uma linha que já estava DEAD no dia do deploy foi anunciada pelo
-- despachante ANTIGO, que escrevia a linha de log e não tocava no payload: sem carimbo, o primeiro
-- `/reset` que a apagasse anunciaria a mesma morte de novo, e a mesma morte relatada duas vezes é
-- exatamente o que este trabalho existe para impedir.
--
-- Carimbar TODAS as linhas DEAD existentes, e não só as que sabidamente viraram linha de log, é a
-- leitura correta e não uma aproximação: o anúncio é um tiro só, no instante da morte, e uma linha
-- que ainda está aqui não foi apagada por ninguém, então o despachante antigo a releu e decidiu. Se
-- aquela decisão foi anunciar, o carimbo diz a verdade; se ela se perdeu (um throw engolido), a
-- oportunidade se perdeu com ela no dia, e ressuscitá-la meses depois pelo caminho do revoke seria
-- comportamento novo, não reparo.
--
-- `NO FORCE ROW LEVEL SECURITY` em volta, porque `scheduler_jobs` é FORCE-RLS e o dono da tabela é
-- sujeito à própria policy de tenant: sem isto o UPDATE decide sobre zero linhas e relata sucesso,
-- que é o modo de falhar mais caro que existe aqui (foi o que a migration de rename de ferramentas
-- fez com a varredura dela, PR #485 rodada 19: o rename entrou, as linhas de auditoria não).
--
-- Numa transação própria por duas razões que se somam: o arquivo LEVANTA o FORCE, e uma falha no
-- meio deixaria a tabela sem ele, ou seja, sem sujeitar o próprio dono à policy de tenant; e o
-- meio-aplicado do UPDATE não é "algumas linhas migradas", é a metade das mortes antigas devendo um
-- anúncio que elas não devem.
BEGIN;

ALTER TABLE "scheduler_jobs" NO FORCE ROW LEVEL SECURITY;

UPDATE "scheduler_jobs"
   SET payload = payload || jsonb_build_object('deadLetterAnnouncedFor', claim_seq::text)
 WHERE status = 'DEAD'
   AND payload->>'deadLetterAnnouncedFor' IS DISTINCT FROM claim_seq::text;

ALTER TABLE "scheduler_jobs" FORCE ROW LEVEL SECURITY;

COMMIT;
