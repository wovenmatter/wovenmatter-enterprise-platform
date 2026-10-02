#!/usr/bin/env node
import { backgroundCommand } from "./background.js";
try {
  process.stdout.write(await backgroundCommand(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "Background request failed") +
      "\n",
  );
  process.exitCode = 1;
}
