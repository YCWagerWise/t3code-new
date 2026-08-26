/**
 * Spans the seam finding #18 (round 2) said a component-only test cannot
 * close: a legacy Atlas access token persisted `sensitive: false` (already
 * leaked to a browser), an edit to a completely UNRELATED environment
 * variable, a save through the real settings-persistence/secret-store path,
 * a simulated remount, and finally the Atlas driver's own credential
 * decision. If any layer silently "healed" the leaked token into
 * `sensitive: true` while still carrying its old value, this is where it
 * would show up as `{ kind: "token", value: "<the leaked token>" }`.
 *
 * `preparePublishedCredentialVariable` (from `@t3tools/contracts`) is the
 * exact function `ProviderEnvironmentSection.publishRows` calls per row —
 * see `apps/web/src/components/settings/ProviderEnvironmentSection.test.tsx`
 * for proof the component wires it correctly. This file proves what happens
 * to its output once it leaves the browser.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ATLAS_ACCESS_TOKEN_ENV,
  ProviderDriverKind,
  ProviderInstanceId,
  preparePublishedCredentialVariable,
  type ProviderCredentialName,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { readAtlasCredentialForTest } from "./AtlasDriver.ts";

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-atlas-credential-persistence-test-",
        }),
      ),
    ),
  );

const LEAKED_TOKEN = "leaked-atlas-token";
const ATLAS_INSTANCE_ID = ProviderInstanceId.make("atlas");
// The exact shape the web settings UI passes as `ProviderClientDefinition.credentials`
// for Atlas — kept local so this test proves the contract, not a re-typed copy of it.
const ATLAS_CREDENTIALS: ReadonlyArray<ProviderCredentialName> = [{ name: ATLAS_ACCESS_TOKEN_ENV }];

it.layer(NodeServices.layer)("the Atlas credential across save, persistence, and remount", (it) => {
  it.effect(
    "never republishes, persists, or authenticates with a legacy leaked token after an unrelated row edit",
    () =>
      Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

        // Legacy on-disk state: exactly the pre-fix scenario finding #18
        // describes — the Atlas access token was persisted *without* the
        // Sensitive flag, so it already reached a browser in clear text.
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            providerInstances: {
              [ATLAS_INSTANCE_ID]: {
                driver: "atlas",
                enabled: true,
                config: { baseUrl: "http://127.0.0.1:3019" },
                environment: [
                  { name: ATLAS_ACCESS_TOKEN_ENV, value: LEAKED_TOKEN, sensitive: false },
                  { name: "OTHER_VAR", value: "old-value", sensitive: false },
                ],
              },
            },
          }),
        );

        // The client-side transform, applied to the FULL row set the way
        // `ProviderEnvironmentSection.publishRows` applies it on every
        // edit. The user only touched OTHER_VAR — the legacy row is
        // untouched here too, still `sensitive: false`, still holding the
        // leaked value — proving the fix does not depend on the user
        // individually addressing the compromised row.
        const legacyRowA: ProviderInstanceEnvironmentVariable = {
          name: ATLAS_ACCESS_TOKEN_ENV,
          value: LEAKED_TOKEN,
          sensitive: false,
        };
        const editedRowB: ProviderInstanceEnvironmentVariable = {
          name: "OTHER_VAR",
          value: "new-value",
          sensitive: false,
        };
        const published = [legacyRowA, editedRowB].map((variable) =>
          preparePublishedCredentialVariable(ATLAS_CREDENTIALS, variable),
        );

        // Fail closed at the source: the transform itself must never let
        // the leaked value leave the browser.
        assert.deepEqual(published, [
          { name: ATLAS_ACCESS_TOKEN_ENV, value: "", sensitive: true },
          { name: "OTHER_VAR", value: "new-value", sensitive: false },
        ]);

        // The save an edit to OTHER_VAR would actually trigger.
        const afterEdit = yield* serverSettings.updateSettings({
          providerInstances: {
            [ATLAS_INSTANCE_ID]: {
              driver: ProviderDriverKind.make("atlas"),
              enabled: true,
              config: { baseUrl: "http://127.0.0.1:3019" },
              environment: published,
            },
          },
        });
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.notInclude(JSON.stringify(afterEdit), LEAKED_TOKEN);

        // Server-side persistence/redaction: the leaked value must never
        // have been written to the secret store (it would resurface via
        // `valueRedacted: true` and a materialized value below if it had
        // been), and settings.json on disk must not contain it either —
        // this is exactly what a real process restart would read.
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, LEAKED_TOKEN);
        const rawEnvironment = // @effect-diagnostics-next-line preferSchemaOverJson:off
        (
          JSON.parse(raw) as {
            providerInstances: {
              atlas: { environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> };
            };
          }
        ).providerInstances.atlas.environment;
        const atlasRowOnDisk = rawEnvironment.find((v) => v.name === ATLAS_ACCESS_TOKEN_ENV);
        assert.deepEqual(atlasRowOnDisk, {
          name: ATLAS_ACCESS_TOKEN_ENV,
          value: "",
          sensitive: true,
        });

        // Simulate a remount: this is the exact code path a freshly
        // started server (and the Atlas driver's `create`) reads settings
        // through.
        const remounted = yield* serverSettings.getSettings;
        const remountedEnvironment = remounted.providerInstances[ATLAS_INSTANCE_ID]?.environment;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.notInclude(JSON.stringify(remountedEnvironment), LEAKED_TOKEN);

        // The driver decision — the actual security property under test.
        // A silently "healed" sensitive:true row that still carried the
        // old value would authenticate as the leaked token here.
        assert.deepEqual(readAtlasCredentialForTest(remountedEnvironment), { kind: "none" });
        // Cross-checked against the raw on-disk environment too, so this
        // does not depend on the settings cache the same service instance
        // is still holding.
        assert.deepEqual(readAtlasCredentialForTest(rawEnvironment), { kind: "none" });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
