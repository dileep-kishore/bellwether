// Cross-agent Needs you / Whose move triage screen (filled out in Wave 3 Task 9).
import { View, div } from "gpui-kit";
import { nextCommand } from "herdr";
import { themeColors } from "./ui.js";

export default class Needs extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.focusHandle = cx.focus_handle();
    this.pendingFocus = false;
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        if ((await nextCommand()) !== "focus") continue;
        this.pendingFocus = true;
        cx.notify();
      }
    });
  }

  render() {
    if (this.pendingFocus) {
      this.pendingFocus = false;
      this.focusHandle.focus();
    }
    const t = themeColors();
    return div().id("bw-needs").size_full().bg(t.surface).track_focus(this.focusHandle);
  }
}
