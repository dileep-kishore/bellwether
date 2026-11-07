// A mod that keeps every harness rule: live data only in render, a slow timer, Git from a task.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, run, exec, theme } from "herdr";

export default class Good extends View {
  init(_props, cx) {
    this.top = null;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["-C", "/r/alpha", "--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { on: null });
      this.top = r.stdout.split("\n")[1] || null;
      cx.notify();
    });
    cx.timer.every(60000, (cx) => cx.notify());
  }

  render(_cx) {
    const t = theme();
    const active = spaces().find((s) => s.active);
    return v_flex()
      .size_full()
      .bg(t.chrome)
      .child(
        h_flex()
          .id("go")
          .gap(4)
          .child(svg("mods/bw-good/icons/dot.svg").size(12).text_color(t.working))
          .child(svg("icons/claude.svg").size(12))
          .child(active?.name ?? "no space")
          .hover((el) => el.bg(t.hover))
          .on_click(() => active && run("space.select", { id: active.id })),
      )
      .child(div().id("top").child(this.top ?? "…"));
  }
}
