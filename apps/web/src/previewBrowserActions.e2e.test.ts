import http from "node:http";

import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  lookupFavicon,
  recordFaviconForProject,
  resetBrowserFaviconsForTests,
  useBrowserFaviconStore,
} from "./browserFaviconStore";
import {
  recordVisitForThread,
  resetBrowserHistoryForTests,
  setTitleForThreadUrl,
  useBrowserHistoryStore,
} from "./browserHistoryStore";
import { boundConfiguredLocalServerUrls } from "./portDiscoveryState";
import { usePreviewMiniPlayerStore } from "./previewMiniPlayerStore";
import {
  applyPreviewDesktopState,
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "./previewStateStore";
import { resolveRemoteOpenState } from "./remoteOpen";

const environmentId = EnvironmentId.make("env-preview-e2e");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-preview-e2e"));
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-preview-e2e"));

function snapshot(overrides: Partial<PreviewSessionSnapshot> = {}): PreviewSessionSnapshot {
  return {
    threadId: threadRef.threadId,
    tabId: "tab-a",
    navStatus: { _tag: "Success", url: "http://localhost:5173/", title: "Home" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  resetBrowserHistoryForTests();
  resetBrowserFaviconsForTests();
});

afterEach(() => {
  resetPreviewStateForTests();
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  resetBrowserHistoryForTests();
  resetBrowserFaviconsForTests();
});

describe("preview/browser action coverage", () => {
  it("applies preview navigation, focus, zoom, and reload recovery to observable state", () => {
    applyPreviewServerSnapshot(threadRef, snapshot({ tabId: "tab-a" }));
    applyPreviewServerSnapshot(
      threadRef,
      snapshot({
        tabId: "tab-b",
        navStatus: { _tag: "Success", url: "http://localhost:5173/docs", title: "Docs" },
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    setActivePreviewTab(threadRef, "tab-a");
    expect(readThreadPreviewState(threadRef).activeTabId).toBe("tab-a");

    updatePreviewServerSnapshot(
      threadRef,
      snapshot({
        tabId: "tab-a",
        navStatus: {
          _tag: "Success",
          url: "http://localhost:5173/docs?refresh=1",
          title: "Refreshed",
        },
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    const refreshed = readThreadPreviewState(threadRef).snapshot;
    expect(refreshed?.tabId).toBe("tab-a");
    expect(refreshed?.navStatus).toMatchObject({
      _tag: "Success",
      url: "http://localhost:5173/docs?refresh=1",
    });

    applyPreviewDesktopState(threadRef, "tab-a", {
      hasWebContents: true,
      canGoBack: true,
      canGoForward: false,
      loading: false,
      zoomFactor: 1.25,
      pictureInPicture: false,
      colorScheme: "light",
      audioMuted: false,
      audible: false,
      controller: "human",
      favicon: null,
    });
    expect(readThreadPreviewState(threadRef).desktopOverlay?.zoomFactor).toBe(1.25);
    applyPreviewDesktopState(threadRef, "tab-a", {
      ...readThreadPreviewState(threadRef).desktopOverlay!,
      zoomFactor: 1,
    });
    expect(readThreadPreviewState(threadRef).desktopOverlay?.zoomFactor).toBe(1);

    const serverSnapshotAfterReload = readThreadPreviewState(threadRef).sessions["tab-a"]!;
    resetPreviewStateForTests();
    applyPreviewServerSnapshot(threadRef, serverSnapshotAfterReload);
    expect(readThreadPreviewState(threadRef).snapshot?.navStatus).toMatchObject({
      _tag: "Success",
      url: "http://localhost:5173/docs?refresh=1",
    });
  });

  it("keeps preview mini-player move and resize state observable by thread", () => {
    const store = usePreviewMiniPlayerStore.getState();
    store.open(threadRef, "tab-a");
    store.move(threadRef, "tab-a", { x: 32, y: 48 });
    store.resize(threadRef, "tab-a", { width: 480, height: 320 });
    expect(usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(threadRef)]).toEqual({
      tabId: "tab-a",
      position: { x: 32, y: 48 },
      size: { width: 480, height: 320 },
    });
  });

  it("persists browser history and favicon actions through store rehydration data", () => {
    const projectKey = scopedProjectKey(projectRef);
    useBrowserHistoryStore.getState().registerThreadProject(threadRef, projectKey);
    recordVisitForThread(threadRef, "localhost:5173/docs", 1_000);
    setTitleForThreadUrl(threadRef, "http://localhost:5173/docs", "Docs");

    const historySnapshot = useBrowserHistoryStore.getState().byProjectKey;
    resetBrowserHistoryForTests();
    useBrowserHistoryStore.setState({ byProjectKey: historySnapshot });
    expect(useBrowserHistoryStore.getState().byProjectKey[projectKey]).toEqual([
      { url: "http://localhost:5173/docs", lastVisitedAt: 1_000, title: "Docs" },
    ]);

    const icon = "data:image/png;base64,AAAA";
    recordFaviconForProject(
      projectRef,
      { pageUrl: "http://localhost:5173/docs", capturedAt: 2_000, dataUrl: icon },
      null,
    );
    const faviconSnapshot = useBrowserFaviconStore.getState().byKey;
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        projectRef,
        "http://localhost:5173/docs",
        null,
      ),
    ).toBe(icon);
    resetBrowserFaviconsForTests();
    useBrowserFaviconStore.setState({ byKey: faviconSnapshot });
    expect(
      lookupFavicon(
        useBrowserFaviconStore.getState().byKey,
        projectRef,
        "http://localhost:5173/docs",
        null,
      ),
    ).toBe(icon);
  });

  it("chooses remote open behavior from real connection targets", () => {
    expect(
      resolveRemoteOpenState({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "local",
          httpBaseUrl: "http://127.0.0.1:3210",
          wsBaseUrl: "ws://127.0.0.1:3210",
        }),
        sshAlias: null,
        remoteOpenTargets: [{ kind: "tailscale", host: "remote.tailnet.test" }],
        isDesktopRenderer: false,
      }).mode,
    ).toBe("local-exec");
    expect(
      resolveRemoteOpenState({
        target: new RelayConnectionTarget({ environmentId, label: "remote" }),
        sshAlias: null,
        remoteOpenTargets: [{ kind: "tailscale", host: "remote.tailnet.test" }],
        isDesktopRenderer: false,
      }),
    ).toEqual({ mode: "remote-links", host: { kind: "tailscale", host: "remote.tailnet.test" } });
  });

  it("admits configured local server URLs that point at a real listener", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected TCP listener");
      const url = `http://127.0.0.1:${address.port}/preview`;
      await new Promise<void>((resolve, reject) => {
        http.get(url, (res) => {
          res.resume();
          res.on("end", resolve);
        }).on("error", reject);
      });
      expect(boundConfiguredLocalServerUrls([url])).toEqual([url]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
