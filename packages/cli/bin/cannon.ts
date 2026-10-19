#!/usr/bin/env ts-node

import { red } from 'chalk';
import cli from '../src';
import { exitAfterFlush } from '../src/util/exit-after-flush';

cli
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
