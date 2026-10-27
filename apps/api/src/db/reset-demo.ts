/**
 * Resets the demonstration data (spec s27/s28).
 *
 * Removes every record marked `DEMO-` and seeds a fresh, identical set. Real data is
 * untouched, because the marker is what identifies demonstration patients.
 *
 *   npm run demo:reset
 */
import { createDb } from './index.ts';
import { migrate, isEntryPoint } from './migrate.ts';
import { clearDemoData, seed } from './seed.ts';

if (isEntryPoint(import.meta.url)) {
  const db = await createDb();
  console.log(`Resetting demonstration data (${db.dialect})...`);

  await migrate(db, () => {});
  await clearDemoData(db);
  const summary = await seed(db);

  await db.close();

  console.log('');
  console.log('Demonstration data reset. All records are FICTIONAL.');
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log('Sign in with admin / nurse / officer / chw1..4, password DemoPass2026.');
}
