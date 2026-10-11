import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { lockTimeoutOption } from "@/api/lib/pool-options";
import config from "@/config";

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    ...lockTimeoutOption(),
  }),
});

export default prisma;
