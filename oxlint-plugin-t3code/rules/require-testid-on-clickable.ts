import { defineRule } from "@oxlint/plugins";

// The attribute an e2e spec keys on. One constant, because the whole point of
// the rule is that this string is the durable handle — a spec that selects by
// rendered text breaks on a copy change and gets "fixed" by loosening the
// assertion until it can no longer fail.
const TEST_ID_ATTRIBUTE = "data-testid";
const CLICK_HANDLER_ATTRIBUTE = "onClick";

const INTRINSIC_ELEMENT_PATTERN = /^[a-z]/u;

// Components that render an intrinsic element and forward unknown props to it,
// so a `data-testid` written on the JSX actually reaches the DOM. Verified by
// reading each one, NOT assumed: components/ui/button.tsx destructures its own
// props and passes the rest through `mergeProps<"button">`, so the attribute
// lands on the real <button>.
//
// A component NOT listed here is skipped rather than reported. Reporting it
// would demand an attribute that may be swallowed before the DOM, and a rule
// that asks for something ineffective teaches people to suppress it.
const FORWARDS_PROPS_TO_THE_DOM = new Set(["Button"]);

// A handler on these is a delegated/bubbled listener on a layout node, not an
// affordance the user is told to click, and giving every wrapper div a testid
// makes the inventory noisier without making anything more selectable.
const LAYOUT_ELEMENTS = new Set(["div", "span", "li", "ul", "section", "article", "tr", "td"]);

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require a stable data-testid on elements that carry an onClick handler, so e2e specs select by a durable handle instead of rendered text.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;

        const isIntrinsic = INTRINSIC_ELEMENT_PATTERN.test(tag);
        if (isIntrinsic) {
          if (LAYOUT_ELEMENTS.has(tag)) return;
        } else if (!FORWARDS_PROPS_TO_THE_DOM.has(tag)) {
          return;
        }

        let hasClickHandler = false;
        let hasTestId = false;
        for (const attribute of node.attributes) {
          // A spread may carry either attribute and we cannot see inside it, so
          // an element with a spread is not reported — silence beats a warning
          // the author cannot act on.
          if (attribute.type === "JSXSpreadAttribute") return;
          if (attribute.type !== "JSXAttribute") continue;
          if (attribute.name.type !== "JSXIdentifier") continue;
          if (attribute.name.name === CLICK_HANDLER_ATTRIBUTE) hasClickHandler = true;
          if (attribute.name.name === TEST_ID_ATTRIBUTE) hasTestId = true;
        }

        if (!hasClickHandler || hasTestId) return;

        context.report({
          node,
          message: `<${tag}> has ${CLICK_HANDLER_ATTRIBUTE} but no ${TEST_ID_ATTRIBUTE}. Add a stable ${TEST_ID_ATTRIBUTE} so an e2e spec can select it without depending on rendered text or DOM structure.`,
        });
      },
    };
  },
});
