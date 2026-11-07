// Bun test preload: serves the stub namespaces for a mod's bare `herdr`, `gpui-kit` and
// `gpui-base` imports. A name the namespace lacks fails at link, as it would in Herdr.
import { plugin } from "bun";
import { herdrModule } from "./herdr-stub.js";
import { baseModule, kitModule } from "./kit-stub.js";

plugin({
  name: "herdr-harness",
  setup(build) {
    build.module("herdr", () => ({ exports: herdrModule, loader: "object" }));
    build.module("gpui-kit", () => ({ exports: kitModule, loader: "object" }));
    build.module("gpui-base", () => ({ exports: baseModule, loader: "object" }));
  },
});
