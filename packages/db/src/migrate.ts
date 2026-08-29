import { migrateLibsql } from "./libsql.ts";

const url = process.env.DATABASE_URL ?? "file:./data/app.db";
await migrateLibsql(url);
console.log("migrated", url);
