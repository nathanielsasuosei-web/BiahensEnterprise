'use strict';
require('../src/db/bootstrap').bootstrap();
const db = require('../src/db');
const notifications = require('../src/services/notifications');

notifications.flush({ limit: 100 }).then(results => {
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  console.log('Delivery attempts:', counts);
}).catch(error => {
  console.error('Notification worker failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.close());
