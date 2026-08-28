import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const srcRoots = ["apps/web/src/components", "apps/web/src/routes"];
const e2eRoot = join(root, "apps/web/e2e");
const outputPath = join(e2eRoot, "action-inventory.json");
const handlerAttrs = new Set([
  "onClick",
  "onDoubleClick",
  "onPointerDown",
  "onMouseDown",
  "onSubmit",
  "onSelect",
  "onChange",
  "onKeyDown",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function attrsOf(openingTag) {
  const attrs = new Map();
  for (const match of openingTag.matchAll(/\s([A-Za-z_$][\w$:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g)) {
    attrs.set(match[1], match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function openingTags(text) {
  const tags = [];
  for (const match of text.matchAll(/<([A-Z_a-z][\w.]*)\b[^<>]*(?:\{[^{}]*\}[^<>]*)*>/g)) {
    if (match[0].startsWith("</")) continue;
    tags.push({ tag: match[1], raw: match[0], index: match.index ?? 0 });
  }
  return tags;
}

function coverageSpecs() {
  if (!existsSync(e2eRoot)) return new Map();
  const specs = walk(e2eRoot).filter((file) => /\.(spec|test)\.(ts|tsx|mjs|js)$/.test(file));
  const byKey = new Map();
  for (const file of specs) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:data-testid|testId|action):\s*["'`]([^"'`]+)["'`]/g)) {
      const key = match[1];
      const list = byKey.get(key) ?? [];
      list.push(relative(root, file));
      byKey.set(key, list);
    }
  }
  return byKey;
}

const coveredByKey = coverageSpecs();
const rows = [];

for (const srcRoot of srcRoots) {
  for (const file of walk(join(root, srcRoot))) {
    const text = readFileSync(file, "utf8");
    const relFile = relative(root, file);
    const seenStructural = new Set();
    for (const node of openingTags(text)) {
      const attrs = attrsOf(node.raw);
      const actions = [...handlerAttrs].filter((attr) => attrs.has(attr));
      if (actions.length === 0) continue;
      const testId = attrs.get("data-testid") ?? null;
      const line = lineAt(text, node.index);
      const key = testId ?? `${relFile}:${line}:${node.tag}:${actions.join("+")}`;
      seenStructural.add(`${line}:${actions.join("+")}`);
      const specs = testId ? (coveredByKey.get(testId) ?? []) : [];
      rows.push({
        file: relFile,
        line,
        tag: node.tag,
        action: actions.join("+"),
        testId,
        status: specs.length > 0 ? "covered" : "UNCOVERED",
        reason: specs.length > 0 ? null : testId ? "no e2e spec references this data-testid" : "missing stable data-testid",
        specs,
        key,
      });
    }
    text.split("\n").forEach((lineText, index) => {
      const actions = [...handlerAttrs].filter((attr) => lineText.includes(`${attr}=`));
      if (actions.length === 0) return;
      const line = index + 1;
      if (seenStructural.has(`${line}:${actions.join("+")}`)) return;
      const testId = lineText.match(/data-testid\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
      const specs = testId ? (coveredByKey.get(testId) ?? []) : [];
      rows.push({
        file: relFile,
        line,
        tag: "unparsed-jsx",
        action: actions.join("+"),
        testId,
        status: specs.length > 0 ? "covered" : "UNCOVERED",
        reason: specs.length > 0 ? null : testId ? "no e2e spec references this data-testid" : "missing stable data-testid",
        specs,
        key: testId ?? `${relFile}:${line}:unparsed-jsx:${actions.join("+")}`,
      });
    });
  }
}

rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.action.localeCompare(b.action));
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify({ generatedBy: "scripts/e2e/action-inventory.mjs", rows }, null, 2)}\n`);

const uncovered = rows.filter((row) => row.status === "UNCOVERED");
const withTestId = rows.filter((row) => row.testId !== null);
console.log(`interactive rows: ${rows.length}`);
console.log(`rows with data-testid: ${withTestId.length}`);
console.log(`covered rows: ${rows.length - uncovered.length}`);
console.log(`uncovered rows: ${uncovered.length}`);
if (uncovered.length > 0) {
  for (const row of uncovered.slice(0, 20)) {
    console.log(`UNCOVERED ${row.file}:${row.line} ${row.tag} ${row.action} ${row.reason}`);
  }
  process.exit(1);
}
