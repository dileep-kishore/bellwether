// Top capsule bar and four-screen coordinator: floating tab capsule on the left, utility capsule on
// the right, `bw.screen` mirroring for hidden stack children, and explicit keyboard focus handoff.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  agents,
  focused,
  home,
  layout,
  nextCommand,
  notify,
  openOverlay,
  panes,
  run,
  setShared,
  settings,
  shared,
  spaces,
  window,
} from "herdr";
import {
  CHAT_AGENT,
  CHAT_SHOWN,
  PENDING_TAB_VIEW,
  PR_SUMMARY,
  SCREEN_KEY,
  TAB_VIEW,
  TERMINAL_FOCUS,
  adopt,
  adoptTabViews,
  desiredScreen,
  focusRecord,
  isChatTab,
  resolveTabTerminal,
  shownChatPanes,
  wakeAt,
  writeTabView,
} from "./chat-tabs.js";
import { moveIndex, needsCount, tabItems } from "./model.js";
import { createPoke } from "./refresh-driver.js";
import {
  ICONS,
  findLayout,
  hoverFill,
  machineTag,
  mutedOnSelected,
  needsCountPill,
  programIcon,
  statusMark,
  themeColors,
} from "./ui.js";

const CHAT_TABS = "bw.chat-tabs";
const SCREEN_STACK = "screen";
const MIN_WAKE_MS = 1000;
const COMMANDS = new Set(["chat-flip", "terminal-peek", "needs-toggle", "overview-toggle"]);

/** @param {string} name */
const icon = (name) => `mods/bw-tabs/icons/${name}.svg`;

/** @param {unknown} _e @param {{ stop_propagation(): void }} cx */
const stop = (_e, cx) => cx.stop_propagation();

export default class Tabs extends View {
  /** @param {unknown} _p @param {any} cx */
  init(_p, cx) {
    /** The tab a left press started on, until the release. @type {string | null} */
    this.pressed = null;
    /** The tab under the pointer while one is pressed, for the drop marker. @type {string | null} */
    this.over = null;
    /** The tab or utility button under the pointer, for its hover fill. @type {string | null} */
    this.hovered = null;
    /** Queued commands received from nextCommand() or capsule clicks; render drains them. @type {string[]} */
    this.pendingCmds = [];
    /** Tab clicked while `needs` or `overview` was active, returning to that tab's screen. @type {string | null} */
    this.clickedTab = null;
    /** Last `space\ntab\nscreen` requested via `layout.select`, deduplicating renders before layout catches up. @type {string | null} */
    this.askedScreen = null;
    /** Screen requested via `layout.select` while `layout()` has not yet reported the new active child. @type {string | null} */
    this.pendingScreen = null;
    /** Raw `screen.active` value from the previous `render()`. @type {string | null} */
    this.lastObservedScreen = null;
    /** Last active `space\ntab` observed in render. @type {string | null} */
    this.lastTabKey = null;
    /** Screen that last received keyboard focus handoff. @type {string | null} */
    this.focusedScreen = null;
    /** The wake time render last asked the wake task for. @type {number | null} */
    this.wakeFor = null;
    this.wake = createPoke();

    // Tasks never read live data: they enqueue command names and notify render().
    cx.spawn(async (/** @type {any} */ cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (!COMMANDS.has(cmd)) continue;
        this.pendingCmds.push(cmd);
        cx.notify();
      }
    });
    cx.spawn(async (/** @type {any} */ cx) => {
      /** @type {{ cancel(): void } | null} */
      let timer = null;
      for (;;) {
        await this.wake.wait();
        timer?.cancel();
        timer = null;
        const at = this.wakeFor;
        if (at === null) continue;
        timer = cx.timer.after(Math.max(MIN_WAKE_MS, at - Date.now()), (/** @type {any} */ cx) => {
          this.wakeFor = null;
          cx.notify();
        });
      }
    });
  }

  /**
   * Focuses the destination screen's primary surface once per transition so keystrokes never reach
   * an off-screen terminal.
   * @param {string} screen
   * @param {string | null} terminal
   */
  handoffFocus(screen, terminal) {
    if (this.focusedScreen === screen) return;
    this.focusedScreen = screen;
    if (screen === "panes") {
      if (terminal) run("pane.focus", { terminal });
    } else if (screen === "chat") {
      run("bw-chat.focus");
    } else if (screen === "needs") {
      run("bw-needs.focus");
    } else if (screen === "overview") {
      run("bw-overview.focus");
    }
  }

  /**
   * Coordinates chat-tab adoption, `bw.tab-view` overrides, `screen` stack selection, `bw.screen`
   * mirroring, and `TERMINAL_FOCUS` tracking inside `render()`.
   * @param {any[]} all SpaceInfo[]
   * @param {any[]} ps PaneInfo[]
   * @param {any} space active SpaceInfo | null
   * @param {any} layoutTree layout()
   * @returns {{ screen: string, activeTerm: string | null }}
   */
  coordinate(all, ps, space, layoutTree) {
    const now = Date.now();
    const r = adopt(shared(CHAT_TABS), all, ps, now);
    if (r.next) setShared(CHAT_TABS, r.next);
    for (const [cmd, args] of r.actions) run(cmd, args);
    for (const n of r.notices) notify({ ...n, level: "warning" });
    const chatState = r.next ?? shared(CHAT_TABS);

    const tv = adoptTabViews(shared(TAB_VIEW), shared(PENDING_TAB_VIEW), all, ps, chatState, now);
    if (tv.nextViews) setShared(TAB_VIEW, tv.nextViews);
    if (tv.nextPending) setShared(PENDING_TAB_VIEW, tv.nextPending);
    let tabViews = tv.nextViews ?? shared(TAB_VIEW);

    const shown = shownChatPanes(all, ps);
    if (JSON.stringify(shown) !== JSON.stringify(shared(CHAT_SHOWN) ?? [])) setShared(CHAT_SHOWN, shown);

    const screenNode = findLayout(layoutTree, SCREEN_STACK);
    const rawScreen = typeof screenNode?.active === "string" ? screenNode.active : "chat";
    if (
      rawScreen === this.pendingScreen ||
      (this.lastObservedScreen !== null && rawScreen !== this.lastObservedScreen)
    ) {
      this.pendingScreen = null;
    }
    this.lastObservedScreen = rawScreen;
    const screenNow = this.pendingScreen ?? rawScreen;

    const curFocus = focused();
    const activeTabId = space?.tabs.find((/** @type {any} */ t) => t.active)?.id ?? null;
    const liveTabIds = all.flatMap((sp) => sp.tabs.map((/** @type {any} */ t) => t.id));
    const chatAgents = shared(CHAT_AGENT);
    const activeTerm = resolveTabTerminal(activeTabId, ps, chatState, chatAgents);
    const tabKey = `${space?.id ?? ""}\n${activeTabId ?? ""}`;
    const tabChanged = this.lastTabKey !== null && this.lastTabKey !== tabKey;
    this.lastTabKey = tabKey;

    if (this.focusedScreen === null) this.focusedScreen = screenNow;

    /** @type {string | null} */
    let explicitScreen = null;
    const cmds = this.pendingCmds.splice(0);
    for (const cmd of cmds) {
      if (cmd === "terminal-peek") {
        if (activeTerm) run("terminal.peek", { terminal: activeTerm });
        continue;
      }
      const current = explicitScreen ?? screenNow;
      if (cmd === "needs-toggle") {
        explicitScreen = current === "needs" ? desiredScreen(activeTabId, ps, chatState, tabViews) : "needs";
      } else if (cmd === "overview-toggle") {
        explicitScreen = current === "overview" ? desiredScreen(activeTabId, ps, chatState, tabViews) : "overview";
      } else if (cmd === "chat-flip") {
        if (current === "panes") {
          if (activeTabId && isChatTab(activeTabId, ps, chatState)) {
            tabViews = writeTabView(tabViews, activeTabId, "chat", liveTabIds);
            setShared(TAB_VIEW, tabViews);
            explicitScreen = "chat";
          }
        } else if (current === "chat") {
          if (activeTabId && isChatTab(activeTabId, ps, chatState)) {
            tabViews = writeTabView(tabViews, activeTabId, "panes", liveTabIds);
            setShared(TAB_VIEW, tabViews);
            explicitScreen = "panes";
          } else if (activeTabId) {
            explicitScreen = "panes";
          }
        } else if (activeTabId) {
          if (isChatTab(activeTabId, ps, chatState)) {
            tabViews = writeTabView(tabViews, activeTabId, "panes", liveTabIds);
            setShared(TAB_VIEW, tabViews);
          }
          explicitScreen = "panes";
        }
      }
    }

    if (this.clickedTab !== null) {
      const clicked = this.clickedTab;
      this.clickedTab = null;
      if (screenNow === "needs" || screenNow === "overview") {
        explicitScreen = desiredScreen(clicked, ps, chatState, tabViews);
      }
    }

    /** @type {string} */
    let targetScreen = screenNow;
    if (explicitScreen !== null) {
      targetScreen = explicitScreen;
      if (screenNode && targetScreen !== screenNow) {
        this.pendingScreen = targetScreen === rawScreen ? null : targetScreen;
        this.askedScreen = `${tabKey}\n${targetScreen}`;
        run("layout.select", { stack: SCREEN_STACK, child: targetScreen });
      } else if (targetScreen === rawScreen) {
        this.pendingScreen = null;
        this.askedScreen = null;
      }
      const termForTarget = resolveTabTerminal(activeTabId, ps, chatState, chatAgents);
      this.handoffFocus(targetScreen, termForTarget);
    } else if (screenNode && activeTabId && (screenNow === "chat" || screenNow === "panes")) {
      const want = desiredScreen(activeTabId, ps, chatState, tabViews);
      if (want === screenNow) {
        if (want === rawScreen) this.askedScreen = null;
        if (this.focusedScreen !== screenNow) {
          this.handoffFocus(screenNow, activeTerm);
        } else if (tabChanged && screenNow === "chat") {
          run("bw-chat.focus");
        }
      } else {
        const askKey = `${tabKey}\n${want}`;
        targetScreen = want;
        if (this.askedScreen !== askKey) {
          this.pendingScreen = want;
          this.askedScreen = askKey;
          run("layout.select", { stack: SCREEN_STACK, child: want });
          this.handoffFocus(want, activeTerm);
        }
      }
    } else {
      if (tabChanged) this.askedScreen = null;
      if (this.focusedScreen !== screenNow) this.handoffFocus(screenNow, activeTerm);
    }

    if (shared(SCREEN_KEY) !== targetScreen) setShared(SCREEN_KEY, targetScreen);

    const focus = focusRecord(shared(TERMINAL_FOCUS), curFocus?.terminal ?? null, now, targetScreen);
    if (focus) setShared(TERMINAL_FOCUS, focus);

    const at = wakeAt(chatState, tv.nextPending ?? shared(PENDING_TAB_VIEW));
    if (at !== this.wakeFor) {
      this.wakeFor = at;
      this.wake.poke();
    }

    return { screen: targetScreen, activeTerm };
  }

  render() {
    const t = themeColors();
    const all = spaces();
    const ps = panes();
    const ags = agents();
    const tree = layout();
    const space = all.find((s) => s.active) ?? null;
    const { screen, activeTerm } = this.coordinate(all, ps, space, tree);
    const items = tabItems(space, ps);
    const attention = needsCount(ags, ps, all, shared(PR_SUMMARY));
    const w = window();
    const sidebar = findLayout(tree, "sidebar");
    const right = findLayout(tree, "right");
    const zoom = Number(settings()?.zoom) || 1;
    // With the sidebar hidden on macOS, reserve scaled clearance for the window traffic lights.
    const pad =
      w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && sidebar?.hidden ? Math.round(78 * zoom) : 10;

    /**
     * Round 26 px icon button inside a floating 36 px capsule.
     * @param {{ id: string, label: string, path: string, active?: boolean, enabled?: boolean, onClick: (e: unknown, cx: any) => void }} b
     */
    const capsuleIcon = (b) => {
      const enabled = b.enabled !== false;
      const active = Boolean(b.active);
      return div()
        .id(b.id)
        .relative()
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(13)
        .accessibility_label(b.label)
        .text_color(!enabled ? t.dim : active ? t.foreground : t.muted)
        .when(active, (el) => el.bg(t.selected))
        .when(!enabled, (el) => el.opacity(0.45))
        .when(enabled, (el) =>
          el
            .cursor_pointer()
            .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
              const next = on ? b.id : this.hovered === b.id ? null : this.hovered;
              if (next === this.hovered) return;
              this.hovered = next;
              cx.notify();
            })
            .on_click(b.onClick),
        )
        .on_mouse_down("left", stop)
        .child(hoverFill(t, `hover-${b.id}`, enabled && !active && this.hovered === b.id, 13))
        .child(svg(b.path).size(14).flex_none());
    };

    const tab = (/** @type {import("./model.js").TabItem} */ c) => {
      const marked = this.pressed !== null && this.pressed !== c.id && this.over === c.id;
      const showClose = c.active || this.hovered === c.id;
      return h_flex()
        .id(`tab-${c.id}`)
        .relative()
        .h(26)
        .pl(10)
        .pr(showClose ? 5 : 10)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(13)
        .text_size(12.5)
        .when(c.active, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!c.active, (el) => el.text_color(t.muted))
        .when(c.settled, (el) => el.italic())
        .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => {
          const next = on ? c.id : this.hovered === c.id ? null : this.hovered;
          if (next === this.hovered) return;
          this.hovered = next;
          cx.notify();
        })
        .on_mouse_down("left", (_e, cx) => {
          cx.stop_propagation();
          this.pressed = c.id;
          this.over = null;
        })
        .on_mouse_move((_e, cx) => {
          if (this.pressed === null || this.over === c.id) return;
          this.over = c.id;
          cx.notify();
        })
        .on_mouse_up("left", () => {
          const index = moveIndex(items, this.pressed, c.id);
          const from = this.pressed;
          this.pressed = null;
          this.over = null;
          if (index !== null && from !== null) run("tab.move", { id: from, index });
        })
        .on_click((_e, cx) => {
          run("tab.select", { id: c.id });
          if (screen === "needs" || screen === "overview") {
            this.clickedTab = c.id;
            cx.notify();
          }
        })
        .child(hoverFill(t, `tab-hover-${c.id}`, !c.active && this.hovered === c.id, 13))
        .when(marked, (el) =>
          el.child(div().id(`tab-drop-${c.id}`).absolute().left(-3).top(3).bottom(3).w(2).rounded(1).bg(t.accent)),
        )
        .when(c.active, (el) =>
          el.child(div().id(`tab-mark-${c.id}`).absolute().left(29).bottom(2).w(14).h(2).rounded(1).bg(t.accent)),
        )
        .child(programIcon(c.program, t, 13))
        .child(div().max_w(170).truncate().child(c.title))
        .child(statusMark(t, c.status, 12, `tab-status-${c.id}`))
        .when(Boolean(space?.machine), (el) => el.child(machineTag(String(space?.machine), t)))
        .when(showClose, (el) =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .size(18)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(9)
              .text_color(c.active ? mutedOnSelected : t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg(ICONS.close).size(11)),
          ),
        );
    };

    /** @type {{ space: string } | { machine: string | null, folder: string }} */
    const props = space ? { space: space.id } : { machine: null, folder: home() };

    return h_flex()
      .id("tabs-bar")
      .h(48)
      .w_full()
      .min_w(0)
      .pl(pad)
      .pr(10)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .on_mouse_down("left", () => {
        this.pressed = null;
        this.over = null;
      })
      .on_mouse_up("left", () => {
        this.pressed = null;
        this.over = null;
      })
      .on_mouse_down_out(() => {
        this.pressed = null;
        this.over = null;
      })
      .child(
        h_flex()
          .id("tab-capsule")
          .flex_shrink_1()
          .min_w(0)
          .h(36)
          .px(5)
          .gap(3)
          .items_center()
          .rounded(18)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .on_mouse_down("left", stop)
          .when(Boolean(sidebar?.hidden), (el) =>
            el.child(
              capsuleIcon({
                id: "tabs-sidebar",
                label: "Show sidebar (⌘B)",
                path: icon("sidebar"),
                onClick: () => run("layout.toggle", { id: "sidebar" }),
              }),
            ),
          )
          .when(items.length > 0, (el) =>
            el.child(
              h_flex()
                .id("tab-scroll")
                .min_w(0)
                .h_full()
                .items_center()
                .gap(2)
                .overflow_x_scrollbar()
                .children(items.map(tab)),
            ),
          )
          .child(
            capsuleIcon({
              id: "tab-new",
              label: "New tab",
              path: ICONS.plus,
              onClick: () =>
                openOverlay({ mod: "bw-new", kind: "popup", width: 232, height: 300, frame: "none", props }),
            }),
          ),
      )
      .child(div().flex_1().h_full())
      .child(
        h_flex()
          .id("utility-capsule")
          .flex_none()
          .h(36)
          .px(5)
          .gap(3)
          .items_center()
          .rounded(18)
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .on_mouse_down("left", stop)
          .when(attention > 0, (el) =>
            el.child(
              needsCountPill(t, attention, {
                id: "tabs-needs",
                active: screen === "needs",
                onClick: (_e, cx) => {
                  this.pendingCmds.push("needs-toggle");
                  cx.notify();
                },
              }).on_mouse_down("left", stop),
            ),
          )
          .child(
            capsuleIcon({
              id: "tabs-overview",
              label: "Overview (⌘⇧O)",
              path: icon("grid"),
              active: screen === "overview",
              onClick: (_e, cx) => {
                this.pendingCmds.push("overview-toggle");
                cx.notify();
              },
            }),
          )
          .child(
            capsuleIcon({
              id: "tabs-terminal",
              label: "Toggle terminal (⌘J)",
              path: ICONS.terminal,
              active: screen === "panes",
              enabled: activeTerm !== null,
              onClick: (_e, cx) => {
                this.pendingCmds.push("chat-flip");
                cx.notify();
              },
            }),
          )
          .child(
            capsuleIcon({
              id: "tabs-peek",
              label: "Peek terminal (⌘⇧')",
              path: icon("peek"),
              enabled: activeTerm !== null,
              onClick: () => {
                if (activeTerm) run("terminal.peek", { terminal: activeTerm });
              },
            }),
          )
          .child(
            capsuleIcon({
              id: "tabs-inspector",
              label: "Toggle inspector (⌘⌥B)",
              path: icon("panel-right"),
              active: Boolean(right && !right.hidden),
              onClick: () => run("layout.toggle", { id: "right" }),
            }),
          ),
      );
  }
}
