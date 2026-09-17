// Verificador #658 — sonda do teto da espera: um holder que RENOVA e nunca termina, e um segundo
// invoke pedindo `markTurnOwning(..., { waitForTurn: true })`. Registra, a cada segundo, o que a
// linha de claim diz, para mostrar contra o que o teto esta sendo medido.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight } from "@/graph/inflight";
import { markTurnOwning, type ThreadOwner } from "@/graph/thread-claim";

const tenantId = BigInt(process.env.V_TENANT as string);
const instanceId = BigInt(process.env.V_INSTANCE as string);
const contactInboxId = Number(process.env.V_CONTACT_INBOX as string);
const capMs = Number(process.env.V_CAP_MS ?? "400000");

const appDb = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.TEST_APP_DATABASE_URL as string,
  }),
});
const suDb = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.MIGRATION_DATABASE_URL as string,
  }),
});

const owner: ThreadOwner = {
  tenantId,
  instanceId,
  contactInboxId,
  graphThreadId: contactInboxThreadId(tenantId, instanceId, contactInboxId),
};

// O PRIMEIRO turno: pega o hold (com renovacao do lease ligada) e nunca solta.
const holder = await markTurnOwning(owner, appDb);
// Tira a marca do Map do processo, para que a espera abaixo dependa SO da linha, como se fosse
// outra replica.
clearTurnInFlight(owner.graphThreadId);
console.log(
  `HOLDER epoch=${holder.epoch} heldBefore=${holder.heldBefore} at=${Date.now()}`,
);

const t0 = Date.now();
const sampler = setInterval(() => {
  void suDb.$queryRaw<
    { turn_holders: number; turn_held_until: Date | null }[]
  >`SELECT turn_holders, turn_held_until FROM agent_threads
      WHERE tenant_id = ${tenantId} AND chatwoot_instance_id = ${instanceId}
        AND contact_inbox_id = ${contactInboxId}`.then((rows) => {
    const r = rows[0];
    console.log(
      `SAMPLE t=${Date.now() - t0} holders=${r?.turn_holders} lease=${r?.turn_held_until?.toISOString()}`,
    );
  });
}, 1_000);
sampler.unref?.();

const cap = setTimeout(() => {
  console.log(`CAP t=${Date.now() - t0} — a espera nao terminou dentro do teto do cenario`);
  process.exit(3);
}, capMs);

try {
  const waiter = await markTurnOwning(owner, appDb, { waitForTurn: true });
  console.log(
    `WAITER RETURNED t=${Date.now() - t0} epoch=${waiter.epoch} heldBefore=${waiter.heldBefore}`,
  );
} catch (e) {
  console.log(
    `WAITER THREW t=${Date.now() - t0} msg=${e instanceof Error ? e.message : String(e)}`,
  );
}
clearTimeout(cap);
clearInterval(sampler);
process.exit(0);
