#!/usr/bin/env -S node --enable-source-maps --max-old-space-size=8192

const { red } = require('chalk');
const cli = require('../dist/src');
const { exitAfterFlush } = require('../dist/src/util/exit-after-flush');

cli.default
  .parseAsync()
  .then(() => {
    exitAfterFlush();
  })
  .catch((err) => {
    if (err.message) {
      err.message = red(err.message);
    }

    //eslint-disable-next-line no-console
    console.error(err);

    exitAfterFlush(process.exitCode || 1);
  });
