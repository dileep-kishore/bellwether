// Read-only Drafts & Audit inspector panel (filled out in Wave 3 Task 11).
import { View, div } from "gpui-kit";
import { themeColors } from "./ui.js";

export default class Drafts extends View {
  render() {
    const t = themeColors();
    return div().id("bw-drafts").size_full().bg(t.chrome);
  }
}
