/* Rich-text editor for Docs, built on Tiptap (ProseMirror).
 * Bundled by `npm run build:editor` into public/vendor/editor.js, which exposes window.CRMEditor.
 *
 * Besides normal formatting it adds:
 *   - tasks with an assignee and a due date (and a stable id, so the CRM can list and tick them)
 *   - @mentions of people in the company
 *   - date chips
 *   - "/" commands to insert any block
 */
import { Editor, Node, Extension, mergeAttributes } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Highlight } from "@tiptap/extension-highlight";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Mention } from "@tiptap/extension-mention";
import { Suggestion } from "@tiptap/suggestion";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
function niceDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00"); if (isNaN(d)) return iso;
  const diff = Math.round((d - new Date(todayISO() + "T00:00:00")) / 864e5);
  if (diff === 0) return "Today"; if (diff === 1) return "Tomorrow"; if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
const initials = name => (name || "?").split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
const ICON = {
  person: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.6"/><path d="M2.8 13.6c.7-2.4 2.8-3.7 5.2-3.7s4.5 1.3 5.2 3.7"/></svg>',
  cal: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.3" y="3.3" width="11.4" height="10.4" rx="1.6"/><path d="M2.3 6.6h11.4M5.4 1.8v2.6M10.6 1.8v2.6"/></svg>',
};

/* ---------- floating lists and pickers ---------- */
let openPop = null;
function closePop() { openPop?.destroy(); openPop = null; }
function place(el, rect) {
  if (!rect) return;
  el.style.left = "0px"; el.style.top = "0px";
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(Math.max(8, rect.left), innerWidth - w - 8);
  let top = rect.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - 6);
  el.style.left = left + "px"; el.style.top = top + "px";
}
// A keyboard-driven list (used for @mentions, / commands and choosing an assignee).
class ListPop {
  constructor({ items, renderItem, onPick, rect, emptyText = "No matches", search = false, placeholder = "" }) {
    closePop();
    this.items = items; this.renderItem = renderItem; this.onPick = onPick; this.index = 0; this.emptyText = emptyText;
    this.el = document.createElement("div"); this.el.className = "ed-pop"; this.el.setAttribute("role", "listbox");
    if (search) {
      this.all = items;
      this.el.innerHTML = `<input class="ed-pop-search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><div class="ed-pop-list"></div>`;
      this.input = this.el.querySelector("input");
      this.input.addEventListener("input", () => { const q = this.input.value.toLowerCase(); this.items = this.all.filter(i => !q || (i.label || "").toLowerCase().includes(q) || i.always); this.index = 0; this.draw(); });
      this.input.addEventListener("keydown", e => { if (this.key(e)) e.preventDefault(); });
    }
    this.list = search ? this.el.querySelector(".ed-pop-list") : this.el;
    this.el.addEventListener("mousedown", e => { if (e.target !== this.input) e.preventDefault(); });
    this.el.addEventListener("click", e => { const b = e.target.closest("[data-i]"); if (b) this.pick(+b.dataset.i); });
    document.body.appendChild(this.el);
    this.draw(); place(this.el, rect);
    if (this.input) setTimeout(() => this.input.focus(), 0);
    this.outside = e => { if (!this.el.contains(e.target)) closePop(); };
    setTimeout(() => document.addEventListener("mousedown", this.outside), 0);
    openPop = this;
  }
  setItems(items, rect) { this.items = items; this.index = 0; this.draw(); place(this.el, rect); }
  draw() {
    this.list.innerHTML = this.items.length
      ? this.items.map((it, i) => `<button type="button" role="option" data-i="${i}" class="${i === this.index ? "on" : ""}" aria-selected="${i === this.index}">${this.renderItem(it)}</button>`).join("")
      : `<div class="ed-pop-empty">${esc(this.emptyText)}</div>`;
    this.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }
  key(e) {
    const n = this.items.length;
    if (e.key === "ArrowDown") { if (n) { this.index = (this.index + 1) % n; this.draw(); } return true; }
    if (e.key === "ArrowUp") { if (n) { this.index = (this.index + n - 1) % n; this.draw(); } return true; }
    if (e.key === "Enter" || e.key === "Tab") { if (n) { this.pick(this.index); return true; } return false; }
    if (e.key === "Escape") { closePop(); return true; }
    return false;
  }
  pick(i) { const it = this.items[i]; if (it) this.onPick(it); }
  destroy() { document.removeEventListener("mousedown", this.outside); this.el.remove(); if (openPop === this) openPop = null; }
}
// Small date chooser with Clear.
class DatePop {
  constructor({ value, rect, onPick }) {
    closePop();
    this.el = document.createElement("div"); this.el.className = "ed-pop ed-date";
    const t = todayISO(), plus = n => { const d = new Date(t + "T00:00:00"); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
    this.el.innerHTML = `<div class="ed-date-quick"><button type="button" data-d="${t}">Today</button><button type="button" data-d="${plus(1)}">Tomorrow</button><button type="button" data-d="${plus(7)}">In a week</button></div>
      <input type="date" value="${esc(value || "")}" aria-label="Date"><div class="ed-date-row"><button type="button" data-clear>Clear</button><button type="button" class="primary" data-ok>Done</button></div>`;
    const input = this.el.querySelector("input");
    this.el.addEventListener("click", e => {
      const q = e.target.closest("[data-d]"); if (q) { onPick(q.dataset.d); return closePop(); }
      if (e.target.closest("[data-clear]")) { onPick(null); return closePop(); }
      if (e.target.closest("[data-ok]")) { onPick(input.value || null); return closePop(); }
    });
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); onPick(input.value || null); closePop(); } if (e.key === "Escape") closePop(); });
    document.body.appendChild(this.el); place(this.el, rect);
    setTimeout(() => input.focus(), 0);
    this.outside = e => { if (!this.el.contains(e.target)) closePop(); };
    setTimeout(() => document.addEventListener("mousedown", this.outside), 0);
    openPop = this;
  }
  destroy() { document.removeEventListener("mousedown", this.outside); this.el.remove(); if (openPop === this) openPop = null; }
}
// Hook a Tiptap suggestion (typed "@" or "/") up to a ListPop.
const suggestionRender = renderItem => () => {
  let pop = null;
  return {
    onStart: p => { pop = new ListPop({ items: p.items, renderItem, rect: p.clientRect?.(), onPick: it => p.command(it) }); },
    onUpdate: p => { if (!pop) return; pop.onPick = it => p.command(it); pop.setItems(p.items, p.clientRect?.()); },
    onKeyDown: ({ event }) => pop ? pop.key(event) : false,
    onExit: () => { pop?.destroy(); pop = null; },
  };
};

/* ---------- create an editor ----------
 * opts: element, content (Tiptap JSON), users() → [{id,name,active}], me (user id),
 *       onChange(json), placeholder */
function create(opts) {
  const users = () => (opts.users?.() || []);
  const userById = id => users().find(u => u.id === Number(id));
  const peopleItems = q => users().filter(u => u.active !== false && (!q || u.name.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (b.id === opts.me) - (a.id === opts.me) || a.name.localeCompare(b.name)).slice(0, 8)
    .map(u => ({ id: u.id, label: u.name }));
  const personRow = it => `<span class="ed-av">${esc(initials(it.label))}</span><span>${esc(it.label)}${it.id === opts.me ? ' <small>(you)</small>' : ""}</span>`;

  // tasks: checkbox + text + who + when
  const CrmTaskItem = TaskItem.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        tid: { default: null, parseHTML: el => el.getAttribute("data-tid"), renderHTML: a => (a.tid ? { "data-tid": a.tid } : {}) },
        assignee: { default: null, parseHTML: el => (el.getAttribute("data-assignee") ? Number(el.getAttribute("data-assignee")) : null), renderHTML: a => (a.assignee ? { "data-assignee": a.assignee } : {}) },
        due: { default: null, parseHTML: el => el.getAttribute("data-due"), renderHTML: a => (a.due ? { "data-due": a.due } : {}) },
      };
    },
    addNodeView() {
      return ({ node, getPos, editor }) => {
        let current = node;
        const li = document.createElement("li"); li.dataset.type = "taskItem";
        const box = document.createElement("label"); box.className = "task-check"; box.contentEditable = "false";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("aria-label", "Done"); box.append(cb);
        const body = document.createElement("div"); body.className = "task-body";
        const meta = document.createElement("span"); meta.className = "task-meta"; meta.contentEditable = "false";
        li.append(box, body, meta);
        const setAttrs = attrs => {
          if (typeof getPos !== "function") return;
          editor.chain().command(({ tr }) => { const pos = getPos(); const n = tr.doc.nodeAt(pos); if (!n) return false; tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs }); return true; }).run();
        };
        cb.addEventListener("change", () => setAttrs({ checked: cb.checked }));
        meta.addEventListener("mousedown", e => e.preventDefault());
        meta.addEventListener("click", e => {
          const b = e.target.closest("[data-k]"); if (!b || !editor.isEditable) return;
          const rect = b.getBoundingClientRect();
          if (b.dataset.k === "who") {
            const people = users().filter(u => u.active !== false).sort((x, y) => (y.id === opts.me) - (x.id === opts.me) || x.name.localeCompare(y.name)).map(u => ({ id: u.id, label: u.name }));
            new ListPop({ items: [...(current.attrs.assignee ? [{ id: null, label: "Unassign", always: true }] : []), ...people],
              renderItem: it => (it.id == null ? `<span class="ed-av ghost">×</span><span>Unassign</span>` : personRow(it)),
              rect, search: true, placeholder: "Assign to…", onPick: it => { setAttrs({ assignee: it.id }); closePop(); editor.commands.focus(); } });
          } else {
            new DatePop({ value: current.attrs.due, rect, onPick: d => { setAttrs({ due: d }); editor.commands.focus(); } });
          }
        });
        const paint = () => {
          const a = current.attrs, u = a.assignee && userById(a.assignee), late = a.due && !a.checked && a.due < todayISO();
          cb.checked = !!a.checked; cb.disabled = !editor.isEditable; li.dataset.checked = String(!!a.checked);
          meta.innerHTML = `<button type="button" class="tchip${u ? " set" : ""}" data-k="who" title="${u ? "Assigned to " + esc(u.name) : "Assign someone"}">${u ? `<span class="ed-av sm">${esc(initials(u.name))}</span>${esc(u.name.split(" ")[0])}` : ICON.person + "<span>Assign</span>"}</button>` +
            `<button type="button" class="tchip${a.due ? " set" : ""}${late ? " late" : ""}" data-k="due" title="${a.due ? "Due " + esc(a.due) : "Add a due date"}">${ICON.cal}<span>${a.due ? esc(niceDate(a.due)) : "Due"}</span></button>`;
        };
        paint();
        return {
          dom: li, contentDOM: body,
          update: n => { if (n.type !== current.type) return false; current = n; paint(); return true; },
          stopEvent: e => meta.contains(e.target) || box.contains(e.target),
          ignoreMutation: m => m.type !== "selection" && !body.contains(m.target),
        };
      };
    },
  }).configure({ nested: true });

  // every task gets an id (and copies get new ones) so the CRM can track it
  const TaskIds = Extension.create({
    name: "taskIds",
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey("taskIds"),
        appendTransaction: (trs, _old, state) => {
          if (!trs.some(t => t.docChanged)) return null;
          const seen = new Set(); let tr = null;
          state.doc.descendants((n, pos) => {
            if (n.type.name !== "taskItem") return;
            let id = n.attrs.tid;
            if (!id || seen.has(id)) { id = uid(); tr = tr || state.tr; tr.setNodeMarkup(pos, undefined, { ...n.attrs, tid: id }); }
            seen.add(id);
          });
          return tr;
        },
      })];
    },
  });

  // an inline date ("Today", "12 Nov"), click to change
  const DateChip = Node.create({
    name: "dateChip", group: "inline", inline: true, atom: true, selectable: true,
    addAttributes() { return { date: { default: null, parseHTML: el => el.getAttribute("data-date"), renderHTML: a => ({ "data-date": a.date }) } }; },
    parseHTML() { return [{ tag: 'span[data-type="date"]' }]; },
    renderHTML({ HTMLAttributes }) { return ["span", mergeAttributes({ "data-type": "date", class: "date-chip" }, HTMLAttributes), niceDate(HTMLAttributes["data-date"])]; },
    renderText({ node }) { return node.attrs.date || ""; },
    addNodeView() {
      return ({ node, getPos, editor }) => {
        let current = node;
        const el = document.createElement("span"); el.className = "date-chip"; el.contentEditable = "false"; el.dataset.type = "date";
        const paint = () => { el.innerHTML = ICON.cal + `<span>${esc(niceDate(current.attrs.date))}</span>`; el.title = current.attrs.date || ""; };
        el.addEventListener("mousedown", e => e.preventDefault());
        el.addEventListener("click", () => {
          if (!editor.isEditable || typeof getPos !== "function") return;
          new DatePop({ value: current.attrs.date, rect: el.getBoundingClientRect(), onPick: d => {
            const pos = getPos();
            if (!d) editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
            else editor.chain().focus().command(({ tr }) => { tr.setNodeMarkup(pos, undefined, { date: d }); return true; }).run();
          } });
        });
        paint();
        return { dom: el, update: n => { if (n.type !== current.type) return false; current = n; paint(); return true; } };
      };
    },
    addCommands() { return { insertDate: date => ({ commands }) => commands.insertContent([{ type: "dateChip", attrs: { date: date || todayISO() } }, { type: "text", text: " " }]) }; },
  });

  const COMMANDS = [
    { title: "Text", hint: "Plain paragraph", k: "p paragraph", run: c => c.setParagraph().run() },
    { title: "Heading 1", hint: "Big section heading", k: "h1 title", run: c => c.setHeading({ level: 1 }).run() },
    { title: "Heading 2", hint: "Medium heading", k: "h2", run: c => c.setHeading({ level: 2 }).run() },
    { title: "Heading 3", hint: "Small heading", k: "h3", run: c => c.setHeading({ level: 3 }).run() },
    { title: "Task", hint: "Checkbox with assignee and due date", k: "todo checkbox check", run: c => c.toggleTaskList().run() },
    { title: "Bulleted list", hint: "Simple list", k: "ul bullet", run: c => c.toggleBulletList().run() },
    { title: "Numbered list", hint: "1, 2, 3", k: "ol ordered", run: c => c.toggleOrderedList().run() },
    { title: "Date", hint: "Insert today's date", k: "today calendar", run: c => c.insertDate(todayISO()).run() },
    { title: "Mention someone", hint: "Tag a person with @", k: "@ tag person people", run: c => c.insertContent("@").run() },
    { title: "Quote", hint: "Callout or quotation", k: "blockquote", run: c => c.toggleBlockquote().run() },
    { title: "Table", hint: "3 × 3 table", k: "grid", run: c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: "Code", hint: "Code or preformatted text", k: "pre", run: c => c.toggleCodeBlock().run() },
    { title: "Divider", hint: "Horizontal line", k: "hr line rule", run: c => c.setHorizontalRule().run() },
  ];
  const SlashCommands = Extension.create({
    name: "slashCommands",
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor, pluginKey: new PluginKey("slash"), char: "/",
        items: ({ query }) => { const q = query.toLowerCase(); return COMMANDS.filter(c => !q || c.title.toLowerCase().includes(q) || c.k.includes(q)); },
        command: ({ editor, range, props }) => props.run(editor.chain().focus().deleteRange(range)),
        render: suggestionRender(c => `<b>${esc(c.title)}</b><small>${esc(c.hint)}</small>`),
      })];
    },
  });

  const editor = new Editor({
    element: opts.element,
    content: opts.content || { type: "doc", content: [{ type: "paragraph" }] },
    editable: opts.editable !== false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false, autolink: true, defaultProtocol: "https",
          HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
          // only web, mail and phone links: never javascript: or data:
          isAllowedUri: (url, ctx) => ctx.defaultValidate(url) && /^(https?:\/\/|mailto:|tel:)/i.test(url),
        },
      }),
      Highlight,
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === "heading" ? "Heading" : opts.placeholder || "Type / for commands, @ to mention someone…") }),
      TaskList, CrmTaskItem, TaskIds, DateChip,
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      Mention.configure({
        HTMLAttributes: { class: "mention" },
        renderText: ({ node }) => "@" + (userById(node.attrs.id)?.name || node.attrs.label || "someone"),
        renderHTML: ({ options, node }) => ["span", mergeAttributes({ "data-type": "mention", "data-id": node.attrs.id }, options.HTMLAttributes), "@" + (userById(node.attrs.id)?.name || node.attrs.label || "someone")],
        suggestion: { char: "@", items: ({ query }) => peopleItems(query), render: suggestionRender(personRow) },
      }),
      SlashCommands,
    ],
    onUpdate: ({ editor }) => opts.onChange?.(editor.getJSON()),
  });
  // Ctrl/⌘-click opens a link in a new tab
  opts.element.addEventListener("click", e => {
    const a = e.target.closest("a[href]"); if (!a || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); window.open(a.href, "_blank", "noopener");
  });
  return editor;
}

window.CRMEditor = { create, closePop, niceDate, ListPop, DatePop };
