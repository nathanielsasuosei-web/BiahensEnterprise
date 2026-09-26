'use strict';
/* Convenience wrapper: wipes and rebuilds the whole demo dataset. */
process.argv.push('--fresh');
const { main } = require('./seed');
main();
process.exit(0);
