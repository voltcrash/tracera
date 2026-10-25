import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { z } from "zod";
import { enableD1ReadReplication } from "./d1-read-replication";

async function main() {
  const environment = z.enum(["production", "staging"]).parse(process.argv[2]);
  const name = environment === "production" ? "wrangler.production.json" : "wrangler.jsonc";
  const config = z
    .object({
      account_id: z.string().min(1),
      d1_databases: z.array(
        z.object({
          binding: z.string(),
          database_id: z.uuid(),
          database_name: z.string().min(1),
        }),
      ),
    })
    .parse(
      experimental_readRawConfig({ config: fileURLToPath(new URL(`../${name}`, import.meta.url)) })
        .rawConfig,
    );
  const databases = config.d1_databases.filter(({ binding }) => binding === "DB");
  if (databases.length !== 1) throw new Error("Expected exactly one D1 DB binding");
  const database = databases[0]!;
  await enableD1ReadReplication({
    accountId: config.account_id,
    databaseId: database.database_id,
    databaseName: database.database_name,
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  });
  console.log(`D1 read replication enabled: ${database.database_name}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "D1 read replication setup failed");
  process.exitCode = 1;
});
