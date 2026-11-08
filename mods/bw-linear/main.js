// Issues: the open Linear issues of the project linked to the active space's repository, an issue opened
// inline, and Attach, which puts the issue on the current chat tab's composer. Without props this copy is
// the right sidebar's panel; with `{ pick }` it is the link picker dialog. The loop task reads only while
// the panel is shown and drawn: once when it is shown, every 60 s, and on a refresh click. Every Linear
// call runs this Mac's `bw linear`, which holds the key; Git runs on the space's machine.
import { div, svg, View } from "gpui-kit";
import { h_flex, Input, InputState, TextView, v_flex } from "gpui-base";
import { closeOverlay, exec, layout, openOverlay, panes, props, setShared, shared, spaces } from "herdr";
import { readPlace } from "./git.js";
import { createHelper } from "./helper.js";
import { addChip, ATTACH, chatTabOf, chipFrom } from "./linear-attach.js";
import { LINKS, moveLink, readLink, suggest, writeLink } from "./linear-links.js";
import {
  ageText,
  appendPage,
  defaultScope,
  failureText,
  groupByState,
  isShown,
  listArgs,
  originArgs,
  POLL_MS,
  readIssue,
  readList,
  repoName,
} from "./model.js";
import { placeOf } from "./projects-model.js";
import { createPoke } from "./refresh-driver.js";
import { button, hoverFill, pill, spinner, themeColors } from "./ui.js";

/** @typedef {import("./ui.js").Theme} Theme */
/** @typedef {import("./model.js").Issue} Issue */
/** @typedef {import("./model.js").Scope} Scope */
/** @typedef {import("./linear-links.js").Repo} Repo */
/** @typedef {{ state: string, message: string, code?: string }} Failure */
/** @typedef {Repo & { name: string }} RepoInfo */

/** @param {string} name */
const icon = (name) => `mods/bw-linear/icons/${name}.svg`;
const SCOPES = /** @type {const} */ ([
  ["project", "Project"],
  ["mine", "Mine"],
  ["all", "All"],
]);
const PICKER = { width: 440, height: 500 };

/** @param {unknown} e */
const message = (e) => (e instanceof Error ? e.message : String(e));

/**
 * The repository a folder belongs to on `machine`, with its origin, or why there is none.
 * @param {string | null} machine @param {string} folder
 * @returns {Promise<{ ok: true, repo: RepoInfo } | { ok: false, state: string, message: string }>}
 */
async function readRepo(machine, folder) {
  const place = await readPlace(exec, machine, folder);
  if (place.ok === false) return place;
  return { ok: true, repo: await withOrigin(machine, place.place.commonDir) };
}

/** @param {string | null} machine @param {string} commonDir @returns {Promise<RepoInfo>} */
async function withOrigin(machine, commonDir) {
  let origin = null;
  try {
    const r = await exec("git", originArgs(commonDir), { on: machine });
    if (r.code === 0 && r.stdout.trim()) origin = r.stdout.trim();
  } catch {
    // An unreachable machine shows its error on the next read; the repository is still keyed by place.
  }
  return { machine, commonDir, origin, name: repoName(commonDir) };
}

export default class Issues extends View {
  /** @param {unknown} _props @param {any} cx */
  init(_props, cx) {
    this.alive = true;
    const p = /** @type {any} */ (props() ?? {});
    /** The picker dialog's repository, when this copy is the picker. @type {{ machine: string | null, commonDir: string, name?: string } | null} */
    this.pick = p.pick && typeof p.pick.commonDir === "string" ? p.pick : null;
    /** @type {string | null} */
    this.overlay = typeof p.overlay === "string" ? p.overlay : null;
    this.helper = createHelper({
      exec,
      localInstall: async () => {
        throw new Error("bw linear runs on this Mac only");
      },
    });
    /** @type {string | null} */
    this.note = null;
    /** @type {string | null} the row or button under the pointer */
    this.hovered = null;
    this.query = "";
    this.search = InputState.new({ placeholder: this.pick ? "Find a project" : "Search issues, then Enter" });
    this.search.on("change", (/** @type {unknown} */ _e, /** @type {any} */ cx) => cx.notify());
    this.search.on("submit", (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
      if (this.pick) return;
      this.query = this.search.value().trim();
      this.refresh(cx);
    });
    /** Projects for the picker. @type {{ id: string, name: string }[] | null} */
    this.projects = null;
    /** @type {string | null} */
    this.projectsError = null;
    this.poke = createPoke();
    if (this.pick) {
      cx.spawn(async (/** @type {any} */ cx) => this.loadPicker(cx));
      return;
    }

    /** @type {{ id: string, machine: string | null, folder: string } | null} the active space, as render read it */
    this.want = null;
    /** @type {string | null} the space the repository was read for */
    this.repoFor = null;
    /** @type {RepoInfo | null} */
    this.repo = null;
    /** @type {string | null} why the space has no repository */
    this.repoError = null;
    /** @type {Scope | null} the filter the user picked; null is the default */
    this.scope = null;
    /** @type {{ key: string, issues: Issue[], next: string | null, ageS: number | null } | null} */
    this.list = null;
    /** @type {Failure | null} */
    this.failure = null;
    this.loading = false;
    this.moreWanted = false;
    this.repoWanted = false;
    /** @type {{ identifier: string, issue: Issue | null, loading: boolean, error: string | null } | null} */
    this.open = null;
    /** The chat tab Attach would add to, and every live tab id, as render read them. */
    /** @type {string | null} */
    this.chatTab = null;
    /** @type {string[]} */
    this.liveTabs = [];
    /** @type {{ repo: string | null, link: string } | null} the repository and link render last saw */
    this.linkSeen = null;
    /** @type {boolean} */
    this.shown = false;
    // Herdr draws only shown copies: a read whose notify brought no render means the copy is hidden.
    this.drawn = false;
    this.parked = false;

    cx.spawn(async (/** @type {any} */ cx) => {
      while (this.alive) {
        // The layout is read here too: the render a strip click causes can come before the stack switches.
        if (!this.shown || !this.drawn || !isShown(layout())) {
          this.parked = true;
          await this.poke.wait();
          continue;
        }
        try {
          await this.cycle(cx);
        } catch (e) {
          this.failure = { state: "failed", message: message(e) };
          this.loading = false;
          cx.notify();
        }
        await this.poke.wait(cx.sleep(POLL_MS));
      }
    });
  }

  close() {
    this.alive = false;
    this.poke.poke();
  }

  /** The filter shown: the user's, else Project when linked and Mine when not. */
  scopeNow() {
    const link = this.link();
    if (this.scope === "project" && !link) return "mine";
    return this.scope ?? defaultScope(link !== null);
  }

  link() {
    return this.repo ? readLink(shared(LINKS), this.repo) : null;
  }

  /** Reads again now: a refresh click, a filter, a search, or a new link. @param {any} cx */
  refresh(cx) {
    this.repoWanted = true;
    this.note = null;
    this.poke.poke();
    cx?.notify();
  }

  /** What the shown list answers: the space, then the `bw linear` arguments; null with no space. */
  listKey() {
    const w = this.want;
    if (!w) return null;
    return JSON.stringify([
      w.id,
      w.machine,
      w.folder,
      listArgs(this.scopeNow(), this.link()?.projectId ?? null, this.query),
    ]);
  }

  /** One read: the repository when the space changed or a refresh asked, then the list. @param {any} cx */
  async cycle(cx) {
    const want = this.want;
    if (!want) {
      this.repo = null;
      this.list = null;
      cx.notify();
      return;
    }
    const spaceKey = JSON.stringify([want.id, want.machine, want.folder]);
    if (this.repoFor !== spaceKey || this.repoWanted) {
      this.repoWanted = false;
      const r = await readRepo(want.machine, want.folder);
      if (r.ok === true) {
        this.repo = r.repo;
        this.repoError = null;
      } else if (this.repoFor !== spaceKey) {
        this.repo = null;
        this.repoError = r.state === "not_git" ? "This space is not in a Git repository." : r.message;
      }
      this.repoFor = spaceKey;
      if (this.repo) {
        const moved = moveLink(shared(LINKS), this.repo);
        if (moved) setShared(LINKS, moved);
      }
    }
    const args = listArgs(this.scopeNow(), this.link()?.projectId ?? null, this.query);
    const key = this.listKey();
    if (!args || !key) return;
    const more = this.moreWanted && this.list?.key === key && this.list.next;
    this.moreWanted = false;
    this.loading = true;
    cx.notify();
    const answer = await this.helper.call(
      null,
      more ? [...args, "--after", /** @type {string} */ (this.list?.next)] : args,
    );
    this.loading = false;
    // The space, filter or search changed while Linear answered: the next read is already due.
    if (this.listKey() !== key) {
      this.poke.poke();
      return;
    }
    if (answer.ok === false) {
      this.failure = answer;
      // A refused or missing key leaves no list on screen: it would look current.
      if (answer.code === "no_key" || answer.code === "key_refused") this.list = null;
    } else {
      const page = readList(answer.lines);
      this.failure = null;
      this.list = {
        key,
        issues: more && this.list ? appendPage(this.list.issues, page.issues) : page.issues,
        next: page.next,
        ageS: page.ageS,
      };
    }
    this.drawn = false;
    cx.notify();
  }

  /** @param {string} identifier @param {any} cx */
  openIssue(identifier, cx) {
    this.open = { identifier, issue: null, loading: true, error: null };
    this.note = null;
    cx.notify();
    cx.spawn(async (/** @type {any} */ cx) => {
      const answer = await this.helper.call(null, ["linear", "issue", "--id", identifier]);
      if (this.open?.identifier !== identifier) return;
      if (answer.ok === false) this.open = { ...this.open, loading: false, error: failureText(answer) };
      else {
        const issue = readIssue(answer.lines.find((l) => l.type === "linear-issue"));
        this.open = { identifier, issue, loading: false, error: issue ? null : "bw linear issue printed no issue" };
      }
      cx.notify();
    });
  }

  /** @param {any} cx */
  attach(cx) {
    const issue = this.open?.issue;
    const tab = this.chatTab;
    if (!issue || !tab) return;
    const chip = chipFrom(issue, Date.now());
    if (!chip) return;
    setShared(ATTACH, addChip(shared(ATTACH), tab, chip, this.liveTabs));
    this.note = `${issue.identifier} is on the chat's composer; it goes with your next message.`;
    cx.notify();
  }

  /** Opens the picker for the shown repository. */
  openPicker() {
    const r = this.repo;
    if (!r) return;
    openOverlay({
      mod: "bw-linear",
      kind: "dialog",
      ...PICKER,
      props: { pick: { machine: r.machine, commonDir: r.commonDir, name: r.name } },
    });
  }

  /** The picker's projects and the repository's origin. @param {any} cx */
  async loadPicker(cx) {
    const pick = /** @type {NonNullable<typeof this.pick>} */ (this.pick);
    this.pickRepo = await withOrigin(pick.machine ?? null, pick.commonDir);
    const answer = await this.helper.call(null, ["linear", "projects"]);
    if (answer.ok === false) this.projectsError = failureText(answer);
    else
      this.projects = answer.lines
        .filter((l) => l.type === "linear-project" && typeof l.id === "string")
        .map((l) => ({ id: /** @type {string} */ (l.id), name: String(l.name ?? "") }));
    cx.notify();
  }

  /** @param {{ id: string, name: string } | null} project */
  choose(project) {
    const repo = this.pickRepo;
    if (!repo) return;
    setShared(
      LINKS,
      writeLink(shared(LINKS), repo, project ? { projectId: project.id, name: project.name, at: Date.now() } : null),
    );
    if (this.overlay) closeOverlay(this.overlay);
  }

  render() {
    const t = themeColors();
    if (this.pick) return this.renderPicker(t);
    const shown = isShown(layout());
    const all = spaces();
    const ps = panes();
    const space = all.find((s) => s.active) ?? null;
    const want = space ? { id: space.id, machine: space.machine ?? null, folder: placeOf(space, ps) } : null;
    const changed = JSON.stringify(want) !== JSON.stringify(this.want);
    this.want = want;
    this.chatTab = chatTabOf(all, ps);
    this.liveTabs = all.flatMap((s) => (s.tabs ?? []).map((/** @type {any} */ tb) => tb.id));
    if (changed) {
      this.open = null;
      this.list = null;
      this.failure = null;
    }
    // A link made in the picker, here or in another window, reads the new project's list.
    const repoId = this.repo ? JSON.stringify([this.repo.machine, this.repo.commonDir]) : null;
    const linkNow = JSON.stringify(this.link());
    const was = this.linkSeen;
    const relinked = repoId !== null && was?.repo === repoId && was.link !== linkNow;
    this.linkSeen = { repo: repoId, link: linkNow };
    // Shown or hidden, a new space or link, or drawn again after the loop parked: one poke, then parked is clear.
    if (shown !== this.shown || changed || relinked || (shown && this.parked)) {
      this.shown = shown;
      this.parked = false;
      this.poke.poke();
    }
    this.drawn = true;

    const root = v_flex().id("issues-root").size_full().bg(t.chrome).text_size(13).text_color(t.foreground);
    root.child(this.header(t));
    if (this.note) root.child(this.noteRow(t, "issues-note", this.note));
    if (this.list?.ageS != null)
      root.child(this.noteRow(t, "issues-stale", `Linear is unreachable: this list is ${ageText(this.list.ageS)}.`));
    if (this.open) return root.child(this.detail(t));
    return root.child(this.body(t));
  }

  /** @param {Theme} t @param {string} id @param {string} text */
  noteRow(t, id, text) {
    return h_flex()
      .id(id)
      .flex_none()
      .mx(12)
      .mt(8)
      .px(10)
      .py(6)
      .rounded(8)
      .bg(t.raised)
      .border(1)
      .border_color(t.border)
      .text_size(12)
      .text_color(t.muted)
      .child(div().flex_1().min_w(0).child(text));
  }

  /** @param {Theme} t */
  header(t) {
    const link = this.link();
    const scope = this.scopeNow();
    const title = !this.want
      ? "No space"
      : !this.repo
        ? (this.repoError ?? "Reading the repository…")
        : link
          ? link.name
          : "Link a Linear project";
    const canPick = this.repo !== null;
    return v_flex()
      .id("issues-header")
      .flex_none()
      .px(12)
      .pt(10)
      .pb(8)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            h_flex()
              .id("issues-project")
              .relative()
              .flex_1()
              .min_w(0)
              .h(28)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(8)
              .when(canPick, (el) =>
                el
                  .cursor_pointer()
                  .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => this.hover("issues-project", on, cx))
                  .on_click(() => this.openPicker()),
              )
              .child(hoverFill(t, "issues-project-hover", canPick && this.hovered === "issues-project", 8))
              .child(
                svg(icon("issues"))
                  .size(14)
                  .flex_none()
                  .text_color(link ? t.accent : t.muted),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .font_medium()
                  .text_color(link ? t.foreground : t.muted)
                  .child(title),
              )
              .when(canPick, (el) => el.child(svg(icon("chevron-down")).size(12).flex_none().text_color(t.muted))),
          )
          .child(
            this.loading
              ? div().size(28).flex().items_center().justify_center().child(spinner(t, 13))
              : button(t, {
                  id: "issues-refresh",
                  kind: "ghost",
                  icon: svg(icon("refresh")).size(14),
                  onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.refresh(cx),
                }),
          ),
      )
      .child(
        h_flex()
          .id("issues-filter")
          .h(26)
          .p(2)
          .gap(2)
          .rounded(13)
          .bg(t.raised)
          .children(
            SCOPES.map(([id, label]) => {
              const on = scope === id;
              const enabled = id !== "project" || link !== null;
              return h_flex()
                .id(`issues-scope-${id}`)
                .flex_1()
                .h(22)
                .justify_center()
                .items_center()
                .rounded(11)
                .text_size(12)
                .text_color(on ? t.foreground : enabled ? t.muted : t.dim)
                .when(on, (el) => el.bg(t.selected).font_medium())
                .when(enabled && !on, (el) =>
                  el
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => {
                      this.scope = id;
                      this.list = null;
                      this.refresh(cx);
                    }),
                )
                .child(label);
            }),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(svg(icon("search")).size(13).flex_none().text_color(t.muted))
          .child(Input.new(this.search).flex_1()),
      );
  }

  /** @param {string} id @param {boolean} on @param {any} cx */
  hover(id, on, cx) {
    const next = on ? id : this.hovered === id ? null : this.hovered;
    if (next === this.hovered) return;
    this.hovered = next;
    cx.notify();
  }

  /** @param {Theme} t */
  body(t) {
    const box = v_flex().id("issues-list").flex_1().min_h(0).overflow_y_scroll().px(8).py(8).gap(2);
    const center = (/** @type {string} */ text, /** @type {string} */ id) =>
      box.child(div().id(id).px(16).py(24).text_center().text_size(12.5).text_color(t.muted).child(text));
    if (this.failure && !this.list) return center(failureText(this.failure), "issues-error");
    if (!this.repo && this.repoError)
      return center("Open a space in a Git repository to see its issues.", "issues-empty");
    if (!this.list) return center(this.loading ? "Reading Linear…" : "", "issues-wait");
    if (this.failure)
      box.child(
        div().id("issues-error").px(8).py(4).text_size(12).text_color(t.blocked).child(failureText(this.failure)),
      );
    const groups = groupByState(this.list.issues);
    if (!groups.length)
      return center(this.query ? `No open issue matches "${this.query}".` : "No open issues.", "issues-none");
    for (const g of groups) {
      box.child(
        h_flex()
          .id(`issues-group-${g.key}`)
          .h(26)
          .px(8)
          .mt(6)
          .gap(6)
          .items_center()
          .text_size(11)
          .font_medium()
          .text_color(t.muted)
          .child(
            div()
              .size(8)
              .rounded(4)
              .flex_none()
              .bg(t.accent)
              .opacity(g.name ? 1 : 0),
          )
          .child(div().flex_1().truncate().child(g.name.toUpperCase()))
          .child(div().child(String(g.issues.length))),
      );
      for (const i of g.issues) box.child(this.row(t, i));
    }
    if (this.list.next)
      box.child(
        h_flex()
          .py(6)
          .justify_center()
          .child(
            button(t, {
              id: "issues-more",
              label: "Load more",
              onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
                this.moreWanted = true;
                this.poke.poke();
                cx.notify();
              },
            }),
          ),
      );
    return box;
  }

  /** @param {Theme} t @param {Issue} i */
  row(t, i) {
    const id = `issue-${i.identifier}`;
    return h_flex()
      .id(id)
      .relative()
      .h(30)
      .px(8)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => this.hover(id, on, cx))
      .on_click((/** @type {unknown} */ _e, /** @type {any} */ cx) => this.openIssue(i.identifier, cx))
      .child(hoverFill(t, `${id}-hover`, this.hovered === id, 8))
      .child(div().w(64).flex_none().truncate().text_size(11.5).text_color(t.muted).child(i.identifier))
      .child(div().flex_1().min_w(0).truncate().child(i.title))
      .when(i.mine, (el) => el.child(pill(t, "me", "machine")));
  }

  /** @param {Theme} t */
  detail(t) {
    const o = /** @type {NonNullable<typeof this.open>} */ (this.open);
    const i = o.issue;
    const box = v_flex().id("issue-detail").flex_1().min_h(0).overflow_y_scroll().px(14).py(10).gap(10);
    box.child(
      h_flex().child(
        button(t, {
          id: "issue-back",
          kind: "ghost",
          label: "Issues",
          icon: svg(icon("back")).size(13),
          onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
            this.open = null;
            this.note = null;
            cx.notify();
          },
        }),
      ),
    );
    if (!i)
      return box.child(
        div()
          .text_color(o.error ? t.blocked : t.muted)
          .child(o.error ?? `Reading ${o.identifier}…`),
      );
    box.child(
      h_flex()
        .gap(6)
        .items_center()
        .flex_wrap()
        .child(div().text_size(12).text_color(t.muted).child(i.identifier))
        .child(pill(t, i.state.name, "count", "issue-state"))
        .children(i.labels.map((l) => pill(t, l.name, "machine"))),
    );
    box.child(div().id("issue-title").text_size(15).font_semibold().child(i.title));
    const can = this.chatTab !== null;
    box.child(
      h_flex()
        .gap(6)
        .flex_wrap()
        .child(
          button(t, {
            id: "issue-attach",
            kind: "primary",
            label: "Attach to chat",
            icon: svg(icon("attach")).size(13),
            enabled: can,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => this.attach(cx),
          }),
        )
        .child(
          button(t, {
            id: "issue-open",
            label: "Open in Linear",
            icon: svg(icon("link")).size(13),
            enabled: Boolean(i.url),
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => cx.open_url(i.url),
          }),
        )
        .child(
          button(t, {
            id: "issue-branch",
            label: "Copy branch name",
            icon: svg(icon("copy")).size(13),
            enabled: i.branch !== null,
            onClick: (/** @type {unknown} */ _e, /** @type {any} */ cx) => {
              cx.write_to_clipboard(/** @type {string} */ (i.branch));
              this.note = `Copied ${i.branch}`;
              cx.notify();
            },
          }),
        ),
    );
    if (!can)
      box.child(
        div().id("issue-attach-hint").text_size(12).text_color(t.muted).child("Open a chat tab to attach this issue."),
      );
    const description = i.description?.trim() ?? "";
    box.child(
      description
        ? div()
            .id("issue-description")
            .w_full()
            .text_size(13)
            .child(TextView.markdown(`issue-md-${i.identifier}`, description).selectable(true))
        : div().id("issue-description").text_color(t.muted).child("No description."),
    );
    return box;
  }

  /** @param {Theme} t */
  renderPicker(t) {
    const pick = /** @type {NonNullable<typeof this.pick>} */ (this.pick);
    const name = pick.name ?? repoName(pick.commonDir);
    const filter = this.search.value().trim().toLowerCase();
    const projects = this.projects ?? [];
    const suggested = suggest(projects, name);
    const shown = [...(suggested ? [suggested] : []), ...projects.filter((p) => p !== suggested)].filter(
      (p) => !filter || p.name.toLowerCase().includes(filter),
    );
    const linked = this.pickRepo ? readLink(shared(LINKS), this.pickRepo) : null;
    const list = v_flex().id("pick-list").flex_1().min_h(0).overflow_y_scroll().gap(1);
    if (this.projectsError) list.child(div().id("pick-error").p(12).text_color(t.blocked).child(this.projectsError));
    else if (!this.projects || !this.pickRepo)
      list.child(div().p(12).text_color(t.muted).child("Reading Linear's projects…"));
    else
      for (const p of shown) {
        const id = `pick-${p.id}`;
        list.child(
          h_flex()
            .id(id)
            .relative()
            .h(30)
            .px(8)
            .gap(8)
            .items_center()
            .rounded(8)
            .cursor_pointer()
            .on_hover((/** @type {boolean} */ on, /** @type {any} */ cx) => this.hover(id, on, cx))
            .on_click(() => this.choose(p))
            .child(hoverFill(t, `${id}-hover`, this.hovered === id, 8))
            .child(div().flex_1().min_w(0).truncate().child(p.name))
            .when(p === suggested, (el) => el.child(pill(t, "suggested", "accent")))
            .when(linked?.projectId === p.id, (el) => el.child(pill(t, "linked", "count"))),
        );
      }
    return v_flex()
      .id("pick-root")
      .size_full()
      .p(14)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(div().font_semibold().text_size(14).child(`Link ${name} to a Linear project`))
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(
            this.pickRepo?.origin
              ? "Kept by its origin, so its clones on other machines share the link."
              : "This repository has no origin; the link is kept for this machine's copy and moves to the origin once it has one.",
          ),
      )
      .child(Input.new(this.search).w_full())
      .child(list)
      .child(
        h_flex()
          .gap(6)
          .justify_end()
          .when(linked !== null, (el) =>
            el.child(button(t, { id: "pick-unlink", label: "Unlink", onClick: () => this.choose(null) })),
          )
          .child(
            button(t, {
              id: "pick-cancel",
              kind: "ghost",
              label: "Cancel",
              onClick: () => {
                if (this.overlay) closeOverlay(this.overlay);
              },
            }),
          ),
      );
  }
}
