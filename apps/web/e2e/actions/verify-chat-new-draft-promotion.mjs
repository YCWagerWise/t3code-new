import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const spec = readFileSync(join(here, "chat-new-draft-promotion.spec.ts"), "utf8");
const keybindings = readFileSync(join(root, "packages/shared/src/keybindings.ts"), "utf8");

const configured = [...keybindings.matchAll(/\{\s*key:\s*"([^"]+)",\s*command:\s*"([^"]+)",\s*when:\s*"([^"]+)"\s*\}/g)]
  .filter((match) => match[2] === "chat.new" || match[2] === "chat.newLocal")
  .map((match) => ({ key: match[1], command: match[2], when: match[3] }))
  .sort((a, b) => `${a.command}:${a.key}`.localeCompare(`${b.command}:${b.key}`));

const expected = [
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
];

if (JSON.stringify(configured) !== JSON.stringify(expected)) {
  throw new Error(`unexpected chat.new keybinding config: ${JSON.stringify(configured)}`);
}

for (const { key, command, when } of expected) {
  if (!spec.includes(`command: "${command}"`) || !spec.includes(`shortcut: "${key}"`)) {
    throw new Error(`missing draft-promotion case for ${command}/${key}`);
  }
  if (!spec.includes(`not: "terminalFocus"`)) {
    throw new Error(`missing ${when} guard in draft-promotion spec`);
  }
}

for (const required of [
  "route becomes /draft/<uuid>",
  "thread.turn.start carrying bootstrap.createThread",
  "draft promotes to a durable thread row",
  "reload keeps the thread and its user message",
  'runtimeMode: "full-access"',
]) {
  if (!spec.includes(required)) throw new Error(`draft-promotion spec missing ${required}`);
}

console.log("chat-new-draft-promotion.spec.ts covers chat.new x2 and chat.newLocal draft promotion");
