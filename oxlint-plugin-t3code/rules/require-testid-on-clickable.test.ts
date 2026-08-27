import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/require-testid-on-clickable", {
  filename: "fixture.tsx",
});

describe("t3code/require-testid-on-clickable", () => {
  rule.valid(
    "allows a button that already carries a testid",
    `const el = <button type="button" data-testid="thread-send" onClick={send}>Send</button>;`,
  );

  rule.valid(
    "allows a clickable element with no handler at all",
    `const el = <button type="button">Inert</button>;`,
  );

  rule.valid(
    "allows a layout div with a delegated handler",
    `const el = <div className="flex" onClick={onBackdrop}>content</div>;`,
  );

  rule.valid(
    "allows a component that does not forward props to the DOM",
    `const el = <SettingResetButton onClick={reset} />;`,
  );

  rule.valid(
    "allows an element whose attributes come from a spread",
    `const el = <button type="button" onClick={send} {...rest} />;`,
  );

  rule.valid(
    "allows a forwarding component that carries a testid",
    `const el = <Button data-testid="composer-stop" onClick={stop}>Stop</Button>;`,
  );

  rule.invalid(
    "reports an intrinsic button with a handler and no testid",
    `const el = <button type="button" onClick={send}>Send</button>;`,
    (output) => {
      assert.match(output, /data-testid/);
    },
  );

  rule.invalid(
    "reports the Button component, which forwards props to a real button",
    `const el = <Button onClick={stop}>Stop</Button>;`,
    (output) => {
      assert.match(output, /<Button>/);
    },
  );

  rule.invalid(
    "reports an anchor with a handler and no testid",
    `const el = <a href="#" onClick={open}>Open</a>;`,
  );
});
