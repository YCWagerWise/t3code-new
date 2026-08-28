import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spec = readFileSync(join(here, "noop-commands-16.spec.ts"), "utf8");
const actual = new Set([...spec.matchAll(/command:\s*"([^"]+)"/g)].map((match) => match[1]));
const expected = [
  "thread.create",
  "thread.delete",
  "thread.archive",
  "thread.unarchive",
  "thread.settle",
  "thread.unsettle",
  "thread.snooze",
  "thread.unsnooze",
  "thread.pin",
  "thread.unpin",
  "thread.pin.reorder",
  "thread.runtime-mode.set",
  "thread.interaction-mode.set",
  "thread.session.set",
  "thread.activity.append",
  "project.create",
  "project.delete",
];

for (const command of expected) {
  if (!actual.has(command)) throw new Error(`missing noop-command e2e case for ${command}`);
}
if (actual.size !== expected.length) {
  throw new Error(`unexpected noop-command e2e case count ${actual.size}`);
}
console.log(`noop-commands-16.spec.ts covers ${actual.size} command cases`);
