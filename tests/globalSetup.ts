// @ts-expect-error plain .mjs script without types
import { migrate } from "../scripts/migrate.mjs";

/** Brings the test database to the latest schema before any test runs. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/enw_test";
  if (!url.includes("enw_test")) throw new Error(`Refusing to run tests against ${url}`);
  await migrate(url, () => {});
}
