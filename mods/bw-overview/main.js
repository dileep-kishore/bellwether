// Cross-space fleet Overview screen (filled out in Wave 3 Task 9).
import { View, div } from "gpui-kit";
import { themeColors } from "./ui.js";

export default class Overview extends View {
  render() {
    const t = themeColors();
    return div().id("bw-overview").size_full().bg(t.surface);
  }
}
