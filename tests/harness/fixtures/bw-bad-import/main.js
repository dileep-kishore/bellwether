// Imports a name herdr.d.ts does not declare; loading it must fail.
import { View, div } from "gpui-kit";
import { nothere } from "herdr";

export default class BadImport extends View {
  render() {
    return div().child(String(nothere));
  }
}
