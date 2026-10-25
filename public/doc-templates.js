/* Quotation & invoice templates.
 * DocTemplates.render(model, layout) returns the HTML for one printed document.
 * The model is plain data prepared by app.js (already formatted dates, a money() formatter);
 * the layout is the company's saved choices from Settings → Documents. */
(() => {
"use strict";

const LAYOUT_DEFAULTS = {
  template: "classic", accent: "", font: "sans", paper: "A4",
  invoiceTitle: "Invoice", quoteTitle: "Quotation", taxDisplay: "single",
  showLogo: true, showSellerGstin: true, showBuyerGstin: true, showHsn: false,
  showWords: true, showBank: true, showNotes: true, showSignature: true,
  signatureLabel: "Authorised Signatory", footer: "Thank you for your business.",
  receiptTitle: "Payment Receipt", receiptPaper: "A5",
};
const TEMPLATES = [
  { id: "classic", name: "Classic", blurb: "Company left, title right, accent rule." },
  { id: "band", name: "Modern band", blurb: "Dark header band with detail tiles." },
  { id: "minimal", name: "Minimal", blurb: "Airy, light title, hairlines only." },
  { id: "gst", name: "GST tax invoice", blurb: "Bordered Indian format with CGST/SGST." },
];
const FONTS = {
  sans: { label: "Montserrat", css: '"Montserrat", system-ui, sans-serif' },
  serif: { label: "Serif (Source Serif)", css: '"Source Serif 4", Georgia, "Times New Roman", serif' },
  plain: { label: "Arial (plain)", css: 'Arial, Helvetica, sans-serif' },
};

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ml = v => esc(v).replace(/\n/g, "<br>");

/* Small Markdown subset for notes & terms. Input is escaped first, so no raw HTML gets through.
 * Supports: # headings, **bold**, *italic*, `code`, - bullets, 1. numbers, | tables |, --- rules. */
const mdInline = t => esc(t)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
  .replace(/(^|[^\w])_([^_\s][^_]*?)_(?![\w])/g, "$1<em>$2</em>");
function md(src) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n"), out = [];
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^\s*(#{1,4})\s+(.*)$/))) { out.push(`<div class="d-md-h d-md-h${m[1].length}">${mdInline(m[2])}</div>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const ord = /^\s*\d+[.)]\s+/.test(l), re = ord ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, items = [];
      while (i < lines.length && re.test(lines[i])) items.push(`<li>${mdInline(lines[i++].replace(re, ""))}</li>`);
      out.push(`<${ord ? "ol" : "ul"}>${items.join("")}</${ord ? "ol" : "ul"}>`); continue;
    }
    if (l.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<table class="d-md-table"><thead><tr>${head.map(c => `<th>${mdInline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${mdInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,4}\s|[-*+]\s|\d+[.)]\s)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !(lines[i].includes("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || ""))) para.push(mdInline(lines[i++]));
    if (!para.length) para.push(mdInline(lines[i++]));
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return `<div class="d-md">${out.join("")}</div>`;
}

/* ---------- amount in words (Indian numbering: thousand, lakh, crore) ---------- */
const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function below100(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : ""); }
function below1000(n) { return n >= 100 ? ONES[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + below100(n % 100) : "") : below100(n); }
function intWords(n) {
  if (n === 0) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  if (crore) parts.push(intWords(crore) + " Crore");
  if (lakh) parts.push(below100(lakh) + " Lakh");
  if (thousand) parts.push(below100(thousand) + " Thousand");
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}
function amountInWords(amount, currency) {
  const total = Math.round(Math.abs(Number(amount) || 0) * 100);
  const whole = Math.floor(total / 100), cents = total % 100;
  if ((currency || "INR").toUpperCase() === "INR") {
    return `Rupees ${intWords(whole)}${cents ? ` and ${intWords(cents)} Paise` : ""} Only`;
  }
  return `${currency} ${intWords(whole)}${cents ? ` and ${cents}/100` : ""} Only`;
}

/* ---------- shared pieces ---------- */
function sellerLines(m, L) {
  const s = m.seller, lines = [];
  if (s.address) lines.push(ml(s.address));
  const contact = [s.phone, s.email, s.website].filter(Boolean).map(esc).join(" · ");
  if (contact) lines.push(contact);
  if (L.showSellerGstin && s.gstin) lines.push(`GSTIN: <b>${esc(s.gstin)}</b>`);
  return lines.join("<br>");
}
function buyerLines(m, L) {
  const b = m.buyer, lines = [];
  if (b.contact && b.contact !== b.name) lines.push(esc(b.contact));
  if (b.address) lines.push(ml(b.address));
  if (L.showBuyerGstin && b.gstin) lines.push(`GSTIN: <b>${esc(b.gstin)}</b>`);
  return lines.join("<br>");
}
const logo = (m, L, cls = "d-logo") => L.showLogo && m.seller.logo ? `<img class="${cls}" src="${esc(m.seller.logo)}" alt="">` : "";
const titleOf = (m, L) => m.kind === "quotation" ? L.quoteTitle || "Quotation" : L.invoiceTitle || "Invoice";
function metaPairs(m) {
  return [[m.kind === "quotation" ? "Quotation no." : "Invoice no.", m.number], ["Date", m.date],
    [m.kind === "quotation" ? "Valid until" : "Due date", m.secondDate], ...(m.ref ? [["Reference", m.ref]] : [])];
}
function taxRows(m, L) {
  const t = m.totals, r = t.taxRate;
  if (!r) return [];
  if (L.taxDisplay === "cgst_sgst") return [[`CGST (${r / 2}%)`, m.money(t.tax / 2)], [`SGST (${r / 2}%)`, m.money(t.tax / 2)]];
  if (L.taxDisplay === "igst") return [[`IGST (${r}%)`, m.money(t.tax)]];
  return [[`Tax (${r}%)`, m.money(t.tax)]];
}
function totalsRows(m, L) {
  const t = m.totals, rows = [["Subtotal", m.money(t.sub)]];
  if (t.disc) rows.push(["Discount", "−" + m.money(t.disc)]);
  rows.push(...taxRows(m, L), ["Total", m.money(t.total), "grand"]);
  if (t.paid > 0) rows.push(["Paid", "−" + m.money(t.paid)], ["Balance due", m.money(t.balance), "grand"]);
  return rows;
}
const totalsBlock = (m, L, cls = "d-totals") => m.body != null && !m.totals.total ? "" :
  `<div class="${cls}">${totalsRows(m, L).map(([k, v, c]) => `<div class="d-trow ${c || ""}"><span>${k}</span><span class="d-num">${v}</span></div>`).join("")}</div>`;
function itemsTable(m, L, { serial = false } = {}) {
  if (m.body != null) return `<div class="d-body">${md(m.body)}</div>`;
  const head = `<tr>${serial ? `<th class="d-sr">#</th>` : ""}<th>Description</th>${L.showHsn ? "<th>HSN/SAC</th>" : ""}<th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr>`;
  const rows = m.items.map((i, n) => `<tr>${serial ? `<td class="d-sr">${n + 1}</td>` : ""}<td>${esc(i.desc)}</td>${L.showHsn ? `<td>${esc(i.hsn || "")}</td>` : ""}<td class="r d-num">${i.qty}</td><td class="r d-num">${m.money(i.rate)}</td><td class="r d-num">${m.money(i.amount)}</td></tr>`).join("");
  return `<div class="d-table-wrap"><table class="d-items"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="6" class="d-muted">No items</td></tr>`}</tbody></table></div>`;
}
const words = (m, L) => L.showWords && !(m.body != null && !m.totals.total) ? `<div class="d-words"><span class="d-lbl">Amount in words</span>${esc(amountInWords(m.totals.total, m.currency))}</div>` : "";
const bank = (m, L) => m.kind === "invoice" && L.showBank && m.bank ? `<div class="d-block"><div class="d-lbl">Payment details</div>${ml(m.bank)}</div>` : "";
const notes = (m, L) => L.showNotes && m.notes ? `<div class="d-block"><div class="d-lbl">Notes &amp; terms</div>${ml(m.notes)}</div>` : "";
const signature = (m, L) => L.showSignature ? `<div class="d-sign"><div>For <b>${esc(m.seller.name)}</b></div><div class="d-sign-line"></div><div>${esc(L.signatureLabel || "Authorised Signatory")}</div></div>` : "";
const footer = L => L.footer ? `<div class="d-footer">${esc(L.footer)}</div>` : "";
const subject = m => m.subject ? `<div class="d-subject"><span class="d-lbl">Subject</span>${esc(m.subject)}</div>` : "";

/* ---------- the four layouts ---------- */
const LAYOUTS = {
  classic(m, L) {
    return `
    <header class="c-top">
      <div>${logo(m, L)}<div class="d-company">${esc(m.seller.name)}</div><div class="d-muted">${sellerLines(m, L)}</div></div>
      <div class="c-title"><div class="d-title">${esc(titleOf(m, L))}</div>
        <dl class="c-meta">${metaPairs(m).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></div>
    </header>
    <section class="c-bill"><div class="d-lbl">${m.kind === "quotation" ? "Prepared for" : "Bill to"}</div><div class="d-party">${esc(m.buyer.name)}</div><div>${buyerLines(m, L)}</div></section>
    ${subject(m)}${itemsTable(m, L)}
    <div class="c-after"><div class="c-left">${words(m, L)}${bank(m, L)}${notes(m, L)}</div>${totalsBlock(m, L)}</div>
    ${signature(m, L)}${footer(L)}`;
  },

  band(m, L) {
    return `
    <header class="b-band">
      <div class="b-brand">${logo(m, L, "d-logo b-logo")}<div><div class="d-company">${esc(m.seller.name)}</div><div class="b-sub">${sellerLines(m, L)}</div></div></div>
      <div class="d-title">${esc(titleOf(m, L))}</div>
    </header>
    <div class="b-tiles">${metaPairs(m).map(([k, v]) => `<div class="b-tile"><div class="d-lbl">${k}</div><div class="b-val">${esc(v)}</div></div>`).join("")}</div>
    <section class="b-bill"><div class="d-lbl">${m.kind === "quotation" ? "Prepared for" : "Billed to"}</div><div class="d-party">${esc(m.buyer.name)}</div><div class="d-muted">${buyerLines(m, L)}</div></section>
    ${subject(m)}${itemsTable(m, L)}
    <div class="b-after"><div class="b-left">${words(m, L)}${bank(m, L)}${notes(m, L)}</div>${totalsBlock(m, L, "d-totals b-totals")}</div>
    ${signature(m, L)}${footer(L)}`;
  },

  minimal(m, L) {
    return `
    <header class="n-top"><div class="d-title">${esc(titleOf(m, L))}</div>${logo(m, L)}</header>
    <dl class="n-meta">${metaPairs(m).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
    <div class="n-parties">
      <section><div class="d-lbl">From</div><div class="d-party">${esc(m.seller.name)}</div><div class="d-muted">${sellerLines(m, L)}</div></section>
      <section><div class="d-lbl">${m.kind === "quotation" ? "For" : "To"}</div><div class="d-party">${esc(m.buyer.name)}</div><div class="d-muted">${buyerLines(m, L)}</div></section>
    </div>
    ${subject(m)}${itemsTable(m, L)}
    ${totalsBlock(m, L)}${words(m, L)}
    <div class="n-blocks">${bank(m, L)}${notes(m, L)}</div>
    ${signature(m, L)}${footer(L)}`;
  },

  gst(m, L) {
    const meta = metaPairs(m);
    return `
    <div class="g-frame">
      <div class="g-title">${esc(titleOf(m, L))}</div>
      <div class="g-row">
        <div class="g-cell g-seller">${logo(m, L)}<div class="d-company">${esc(m.seller.name)}</div><div>${sellerLines(m, L)}</div></div>
        <div class="g-cell g-meta">${meta.map(([k, v]) => `<div class="g-kv"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
      </div>
      <div class="g-row"><div class="g-cell"><div class="d-lbl">${m.kind === "quotation" ? "Quotation to" : "Bill to (Buyer)"}</div><div class="d-party">${esc(m.buyer.name)}</div><div>${buyerLines(m, L)}</div>${m.subject ? `<div class="g-subject">Subject: ${esc(m.subject)}</div>` : ""}</div></div>
      ${itemsTable(m, L, { serial: true })}
      <div class="g-row">
        <div class="g-cell g-wordscell">${words(m, L) || "&nbsp;"}</div>
        <div class="g-cell g-totcell">${totalsBlock(m, L)}</div>
      </div>
      ${bank(m, L) || notes(m, L) || L.showSignature ? `<div class="g-row">
        <div class="g-cell">${bank(m, L)}${notes(m, L)}</div>
        <div class="g-cell g-signcell">${signature(m, L)}</div>
      </div>` : ""}
    </div>
    ${footer(L)}`;
  },
};

/* ---------- payment receipt ----------
 * r: { receiptNo, date, amount, method, ref, note, showBalance, seller, buyer, currency, money, brandColor,
 *      invoice: { number, date, total, before, balance } } */
function renderReceipt(r, layout) {
  const L = { ...LAYOUT_DEFAULTS, ...(layout || {}) };
  const accent = /^#[0-9a-f]{6}$/i.test(L.accent) ? L.accent : (r.brandColor || "#b8652c");
  const font = (FONTS[L.font] || FONTS.sans).css;
  // the invoice total and balance are shown only when chosen for this receipt
  const inv = r.invoice, paidUp = r.showBalance && inv.balance <= 0.004;
  const how = [r.method, r.ref ? `ref. ${r.ref}` : ""].filter(Boolean).join(", ");
  const details = [["Payment date", r.date], ["Mode", r.method || "—"], ["Reference", r.ref || "—"], ...(r.note ? [["Note", r.note]] : [])];
  return `<div class="doc rcpt paper-${L.receiptPaper === "A4" ? "a4" : "a5"}" style="--doc-accent:${accent};--doc-font:${esc(font)}">
    <header class="r-top">
      <div class="r-seller">${logo(r, L)}<div class="d-company">${esc(r.seller.name)}</div><div class="d-muted">${sellerLines(r, L)}</div></div>
      <div class="r-head"><div class="d-title">${esc(L.receiptTitle || "Payment Receipt")}</div>
        <dl class="r-meta"><dt>Receipt no.</dt><dd>${esc(r.receiptNo)}</dd><dt>Date</dt><dd>${esc(r.date)}</dd></dl></div>
    </header>
    <section class="r-amount">
      <div><span class="d-lbl">Amount received</span><div class="r-big d-num">${r.money(r.amount)}</div></div>
      <div class="r-words">${esc(amountInWords(r.amount, r.currency))}</div>
    </section>
    <p class="r-text">Received with thanks from <b>${esc(r.buyer.name)}</b> the sum of <b>${r.money(r.amount)}</b>${how ? ` by ${esc(how)}` : ""}, against invoice <b>${esc(inv.number)}</b> dated ${esc(inv.date)}.</p>
    <div class="r-grid">
      <section><div class="d-lbl">Received from</div><div class="d-party">${esc(r.buyer.name)}</div><div class="d-muted">${buyerLines(r, L)}</div></section>
      <section><div class="d-lbl">Payment details</div><dl class="r-kv">${details.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl></section>
    </div>
    ${r.showBalance ? `<table class="r-sum"><thead><tr><th>Invoice</th><th class="r">Invoice total</th><th class="r">Received earlier</th><th class="r">This receipt</th><th class="r">Balance due</th></tr></thead>
      <tbody><tr><td><b>${esc(inv.number)}</b><br><span class="d-muted">${esc(inv.date)}</span></td><td class="r d-num">${r.money(inv.total)}</td><td class="r d-num">${r.money(inv.before)}</td><td class="r d-num"><b>${r.money(r.amount)}</b></td><td class="r d-num"><b>${r.money(Math.max(inv.balance, 0))}</b></td></tr></tbody></table>`
    : `<table class="r-sum"><thead><tr><th>Against invoice</th><th>Invoice date</th><th class="r">Amount received</th></tr></thead>
      <tbody><tr><td><b>${esc(inv.number)}</b></td><td>${esc(inv.date)}</td><td class="r d-num"><b>${r.money(r.amount)}</b></td></tr></tbody></table>`}
    <div class="r-end">${paidUp ? `<div class="r-stamp">Paid in full</div>` : `<div></div>`}${signature(r, L)}</div>
    <div class="d-footer">This is a computer-generated receipt.${L.footer ? " " + esc(L.footer) : ""}</div>
  </div>`;
}

function render(m, layout) {
  const L = { ...LAYOUT_DEFAULTS, ...(layout || {}) };
  const tpl = LAYOUTS[L.template] ? L.template : "classic";
  const accent = /^#[0-9a-f]{6}$/i.test(L.accent) ? L.accent : (m.brandColor || "#b8652c");
  const font = (FONTS[L.font] || FONTS.sans).css;
  return `<div class="doc t-${tpl} paper-${L.paper === "Letter" ? "letter" : "a4"}" style="--doc-accent:${accent};--doc-font:${esc(font)}">${LAYOUTS[tpl](m, L)}</div>`;
}

window.DocTemplates = { render, renderReceipt, amountInWords, LAYOUT_DEFAULTS, TEMPLATES, FONTS };
})();
