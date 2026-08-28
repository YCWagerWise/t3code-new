/**
 * E2E actions 023-024: `chat.new` and `chat.newLocal`.
 *
 * This is the draft-promotion path named in the channel stop condition. A
 * passing browser runner must not stop at a successful optimistic route change:
 * the draft has to promote into a durable backend thread and survive reload.
 */

export type ChatNewDraftPromotionCase = {
  readonly id: number;
  readonly command: "chat.new" | "chat.newLocal";
  readonly shortcut: "mod+n" | "mod+shift+o" | "mod+shift+n";
  readonly whenAst: { readonly not: "terminalFocus" };
  readonly fixture: {
    readonly prompt: string;
    readonly bootstrap: {
      readonly type: "bootstrap.createThread";
      readonly runtimeMode: "full-access";
      readonly interactionMode: "normal";
    };
  };
  readonly assertions: readonly [
    "route becomes /draft/<uuid>",
    "typing plus Enter dispatches thread.turn.start carrying bootstrap.createThread",
    "draft promotes to a durable thread row",
    "reload keeps the thread and its user message",
  ];
};

export const chatNewDraftPromotionCases: readonly ChatNewDraftPromotionCase[] = [
  {
    id: 23,
    command: "chat.new",
    shortcut: "mod+n",
    whenAst: { not: "terminalFocus" },
    fixture: {
      prompt: "draft promotion via chat.new primary shortcut",
      bootstrap: {
        type: "bootstrap.createThread",
        runtimeMode: "full-access",
        interactionMode: "normal",
      },
    },
    assertions: [
      "route becomes /draft/<uuid>",
      "typing plus Enter dispatches thread.turn.start carrying bootstrap.createThread",
      "draft promotes to a durable thread row",
      "reload keeps the thread and its user message",
    ],
  },
  {
    id: 23,
    command: "chat.new",
    shortcut: "mod+shift+o",
    whenAst: { not: "terminalFocus" },
    fixture: {
      prompt: "draft promotion via chat.new alternate shortcut",
      bootstrap: {
        type: "bootstrap.createThread",
        runtimeMode: "full-access",
        interactionMode: "normal",
      },
    },
    assertions: [
      "route becomes /draft/<uuid>",
      "typing plus Enter dispatches thread.turn.start carrying bootstrap.createThread",
      "draft promotes to a durable thread row",
      "reload keeps the thread and its user message",
    ],
  },
  {
    id: 24,
    command: "chat.newLocal",
    shortcut: "mod+shift+n",
    whenAst: { not: "terminalFocus" },
    fixture: {
      prompt: "draft promotion via chat.newLocal shortcut",
      bootstrap: {
        type: "bootstrap.createThread",
        runtimeMode: "full-access",
        interactionMode: "normal",
      },
    },
    assertions: [
      "route becomes /draft/<uuid>",
      "typing plus Enter dispatches thread.turn.start carrying bootstrap.createThread",
      "draft promotes to a durable thread row",
      "reload keeps the thread and its user message",
    ],
  },
];

export function assertChatNewDraftPromotionCoverage(
  cases: readonly ChatNewDraftPromotionCase[] = chatNewDraftPromotionCases,
) {
  const byCommand = new Map<string, Set<string>>();
  for (const testCase of cases) {
    const shortcuts = byCommand.get(testCase.command) ?? new Set<string>();
    shortcuts.add(testCase.shortcut);
    byCommand.set(testCase.command, shortcuts);
    if (testCase.whenAst.not !== "terminalFocus") {
      throw new Error(`${testCase.command}/${testCase.shortcut} lost !terminalFocus`);
    }
    if (testCase.fixture.bootstrap.runtimeMode !== "full-access") {
      throw new Error(`${testCase.command}/${testCase.shortcut} lost explicit runtimeMode`);
    }
    if (!testCase.assertions.includes("reload keeps the thread and its user message")) {
      throw new Error(`${testCase.command}/${testCase.shortcut} does not prove reload durability`);
    }
  }

  const chatNew = byCommand.get("chat.new") ?? new Set<string>();
  if (!chatNew.has("mod+n") || !chatNew.has("mod+shift+o") || chatNew.size !== 2) {
    throw new Error("chat.new must cover both configured shortcuts");
  }
  const chatNewLocal = byCommand.get("chat.newLocal") ?? new Set<string>();
  if (!chatNewLocal.has("mod+shift+n") || chatNewLocal.size !== 1) {
    throw new Error("chat.newLocal must cover its configured shortcut");
  }
}

assertChatNewDraftPromotionCoverage();
