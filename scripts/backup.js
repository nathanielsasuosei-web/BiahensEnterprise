'use strict';
require('../src/config/production').assertRuntime();
const db = require('../src/db/bootstrap').bootstrap();
require('../src/services/backups').create().then(result => {
  console.log(`Verified SQLite backup created: ${result.file} (${result.size} bytes).`);
  console.log('Copy it AND the uploads directory to encrypted off-server storage. This command does not upload backups.');
}).catch(() => {
  console.error('Backup failed. No successful backup has been reported; inspect server storage and database health.');
  process.exitCode = 1;
}).finally(() => db.close());
