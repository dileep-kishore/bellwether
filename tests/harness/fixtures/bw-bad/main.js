// Breaks one harness rule per props().case, so the harness tests can see each refusal.
import { View, div, svg } from "gpui-kit";
import { spaces, run, props } from "herdr";

export default class Bad extends View {
  init(_props, cx) {
    const c = props().case;
    if (c === "timer") cx.timer.every(1000, () => spaces());
    if (c === "fast") cx.timer.every(250, () => {});
    if (c === "task") cx.spawn(async () => spaces());
    if (c === "swallowed")
      cx.spawn(async () => {
        try {
          spaces();
        } catch {}
      });
    if (c === "throws")
      cx.spawn(async () => {
        throw new Error("task blew up");
      });
  }

  render(_cx) {
    const c = props().case;
    if (c === "command") run("tab.mvoe", { id: "tb1", index: 2 });
    if (c === "arg") run("tab.move", { id: "tb1", idx: 2 });
    if (c === "required") run("tab.move", { id: "tb1" });
    if (c === "own") run("bw-bad.refresh");
    if (c === "path") return div().child(svg("mods/bw-bad/nope.svg"));
    if (c === "foreign") return div().child(svg("mods/spaces/icon.svg"));
    if (c === "reuse") {
      const d = div();
      return div().child(d).child(d);
    }
    return div().id("root").child("bad");
  }
}
