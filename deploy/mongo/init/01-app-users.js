/*
 * The two APIs' database users, one per environment (P18.7-T3, ADR-0152, ADR-0155).
 *
 * The mongo image runs this once, on the first start against an empty /data/db, as the root user it
 * has just created from MONGO_INITDB_ROOT_USERNAME / _PASSWORD. It never runs again: an existing data
 * directory skips every init script, so changing this file changes nothing on a VM already serving.
 *
 * Staging and production share this one MongoDB (ADR-0155). What keeps them apart here is that each API
 * connects as its own user, created in its own database with `readWrite` on that database and nothing
 * else: production's on `agencyboost`, staging's on `agencyboost_staging`. Staging's API, and the
 * staging seed's `--reset`, run with staging's credentials, so they cannot read or write production's
 * database. bin/lib.sh `assert_db_scope` checks those roles before every deploy and every seed.
 *
 * The passwords come from env/mongo.env (Secret Manager `mongo-root`). Each is also in MONGODB_URI
 * inside `api-env-<env>`; see deploy/env/*.env.example.
 */
const users = [
  { db: 'agencyboost', user: process.env.MONGO_PROD_USERNAME, pwd: process.env.MONGO_PROD_PASSWORD },
  { db: 'agencyboost_staging', user: process.env.MONGO_STAGING_USERNAME, pwd: process.env.MONGO_STAGING_PASSWORD },
];

for (const { db: name, user, pwd } of users) {
  if (!user || !pwd) {
    throw new Error(`the user for ${name} is missing from env/mongo.env (MONGO_PROD_* / MONGO_STAGING_*)`);
  }
}
if (users[0].user === users[1].user) {
  throw new Error('MONGO_PROD_USERNAME and MONGO_STAGING_USERNAME must differ');
}

for (const { db: name, user, pwd } of users) {
  db.getSiblingDB(name).createUser({ user, pwd, roles: [{ role: 'readWrite', db: name }] });
  print(`created ${user} with readWrite on ${name} only`);
}
