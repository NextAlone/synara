import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CliConfig, synaraCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@synara/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import {
  consumeDesktopParentIpcFlag,
  protectFromDesktopParentExit,
} from "./desktopParentLifecycle";

const DESKTOP_PARENT_FORCE_EXIT_DELAY_MS = 8_000;

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const desktopParentIpcEnabled = consumeDesktopParentIpcFlag(process.env);
const program = Command.run(synaraCli, { version }).pipe(Effect.provide(RuntimeLayer));

protectFromDesktopParentExit({
  program,
  enabled: desktopParentIpcEnabled,
  parent: process,
  onDisconnect: Effect.sync(() => {
    console.warn("[server] Desktop parent disconnected; shutting down.");
    const forceExitTimer = setTimeout(() => {
      console.error("[server] Desktop parent disconnect shutdown timed out; forcing exit.");
      process.exit(1);
    }, DESKTOP_PARENT_FORCE_EXIT_DELAY_MS);
    forceExitTimer.unref();
  }),
}).pipe((program) => NodeRuntime.runMain(program as Effect.Effect<void, unknown, never>));
