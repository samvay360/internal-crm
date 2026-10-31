(() => {
"use strict";

/* ---------- constants ---------- */
const COLS = ["leads","clients","projects","tasks","quotes","invoices","expenses","settlements"];
const LEAD_STAGES = ["New","Contacted","Qualified","Proposal","Negotiation","Won","Lost"];
const PROJECT_STATUS = ["Planning","Active","On hold","Completed","Cancelled"];
const TASK_STATUS = ["To do","In progress","Review","Done"];
const PRIORITIES = ["Low","Medium","High"];
const QUOTE_STATUS = ["Draft","Sent","Accepted","Declined"];
const INVOICE_STATUS = ["Draft","Sent","Void"];
const PAY_METHODS = ["Bank transfer","Cash","Card","Cheque","Online","Other"];
const NAV = [
  ["overview","Overview"],["leads","Leads"],["clients","Clients"],["projects","Projects"],["tasks","Tasks"],["docs","Docs"],
  ["sep"],["quotes","Quotations"],["invoices","Invoices"],["expenses","Expenses"],["money","Money"],["sep"],["settings","Settings"]
];

/* ---------- state ---------- */
const S = {
  data:{leads:[],clients:[],projects:[],tasks:[],quotes:[],invoices:[],expenses:[],settlements:[],docs:[]}, unread:0, docFilter:"all",
  settings:{}, users:[], me:null, activity:[],
  view:"overview", param:null, q:{}, mode:{leads:"board",tasks:"board"},
  taskFilter:"all", leadRegion:"", expMonth:null, expCategory:"", settingsTab:"company", sheet:null,
  tenant:null, tenants:[], allUsers:[],
  dirty:{}, dirtyKey:"",  // what the viewer has typed into page forms, kept across redraws
  inflight:0, ready:false, modal:null
};
try{ const m=JSON.parse(localStorage.getItem("crm.mode")||"null"); if(m) Object.assign(S.mode,m); }catch(e){}

/* ---------- utils ---------- */
const $ = (s,r=document)=>r.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const todayISO = () => { const d=new Date(); return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const addDays = (iso,n) => { const d=new Date(iso+"T00:00:00"); d.setDate(d.getDate()+n); return new Date(d.getTime()-d.getTimezoneOffset()*6e4).toISOString().slice(0,10); };
const fmtDate = iso => { if(!iso) return "—"; const d=new Date(iso.length<=10?iso+"T00:00:00":iso); return isNaN(d)?"—":d.toLocaleDateString(undefined,{day:"numeric",month:"short",year:"numeric"}); };
const fmtDateTime = iso => { if(!iso) return "—"; const d=new Date(iso); return isNaN(d)?"—":d.toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"numeric",minute:"2-digit"}); };
const cur = () => (S.settings.currency||"INR").toUpperCase();
const money = n => { const v=Number(n)||0; try{ return new Intl.NumberFormat("en-IN",{style:"currency",currency:cur()}).format(v);}catch(e){ return cur()+" "+v.toFixed(2);} };
const num = v => { const n=parseFloat(v); return isFinite(n)?n:0; };
const byId = (col,id) => S.data[col].find(x=>x.id===Number(id));
const clientName = id => { const c=byId("clients",id); return c ? (c.company||c.name) : ""; };
const projectName = id => byId("projects",id)?.name || "";
const userName = id => S.users.find(u=>u.id===id)?.name || (id?"Former user":"—");
const isAdmin = () => S.me?.role==="admin"||S.me?.role==="superadmin";
const isSuper = () => S.me?.role==="superadmin";
const roleLabel = r => ({superadmin:"Super admin",admin:"Administrator",member:"Member"})[r]||r;
const matches = (obj,q) => !q || JSON.stringify(obj).toLowerCase().includes(q.toLowerCase());

function toast(msg){
  document.querySelectorAll(".toast").forEach(x=>x.remove());
  const t=document.createElement("div"); t.className="toast"; t.setAttribute("role","status"); t.textContent=msg; document.body.appendChild(t);
  setTimeout(()=>t.remove(),3000);
}
function confirmBox(title,body,okLabel="Delete"){
  S.modal?.dismiss();
  return new Promise(res=>{
    const opener=document.activeElement;
    const m=document.createElement("div"); m.className="modal";
    m.innerHTML=`<div class="modal-box" role="alertdialog" aria-modal="true" aria-labelledby="modal-t" aria-describedby="modal-b"><h3 id="modal-t">${esc(title)}</h3><p id="modal-b">${esc(body)}</p><div class="row"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${esc(okLabel)}</button></div></div>`;
    const done=v=>{ if(!m.isConnected) return; S.modal=null; m.classList.add("closing"); setTimeout(()=>m.remove(),140); opener?.focus?.({preventScroll:true}); res(v); };
    m.addEventListener("click",e=>{ const a=e.target.closest("[data-a]")?.dataset.a; if(a||e.target===m) done(a==="yes"); });
    m.addEventListener("keydown",e=>{ if(e.key==="Escape"){ e.stopPropagation(); done(false); } trapFocus(e,m); });
    S.modal={dismiss:()=>done(false)};
    document.body.appendChild(m); m.querySelector('[data-a="yes"]').focus();
  });
}
const confirmDiscard=()=>confirmBox("Discard unsaved changes?","You have changes that haven't been saved. If you leave now they will be lost.","Discard changes");
// keep Tab inside an open dialog or panel
function trapFocus(e,root){
  if(e.key!=="Tab") return;
  const f=[...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(x=>x.offsetParent!==null);
  if(!f.length) return;
  const first=f[0], last=f[f.length-1];
  if(e.shiftKey&&document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey&&document.activeElement===last){ e.preventDefault(); first.focus(); }
}
function saveFile(filename,content,type){
  const url=URL.createObjectURL(new Blob([content],{type}));
  const a=document.createElement("a"); a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ---------- API ---------- */
// Thin bar at the top of the window while any request is running (after a short delay, so quick ones don't flicker).
function progress(delta){
  S.inflight=Math.max(0,S.inflight+delta);
  const bar=$("#progress"); if(!bar) return;
  clearTimeout(S.progT);
  if(S.inflight>0){ if(!bar.classList.contains("on")) S.progT=setTimeout(()=>{ bar.classList.remove("done"); bar.classList.add("on"); },120); }
  else if(bar.classList.contains("on")){ bar.classList.add("done"); S.progT=setTimeout(()=>bar.classList.remove("on","done"),320); }
}
async function api(method,url,body){
  let res; progress(1);
  try{ res=await fetch(url,{method,headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined,credentials:"same-origin"}); }
  catch(e){ throw new Error("Can't reach the server. Check your internet connection and try again."); }
  finally{ progress(-1); }
  let data=null; try{ data=await res.json(); }catch(e){}
  if(res.status===401&&!url.endsWith("/login")){ showAuth(); throw new Error("Your session has ended. Please sign in again."); }
  if(!res.ok) throw new Error(data?.error||"The server could not complete this request.");
  return data;
}
async function create(col,body){
  try{ const rec=await api("POST","/api/"+col,body); S.data[col].unshift(rec); render(); refreshActivity(); return rec; }
  catch(e){ toast(e.message); return null; }
}
async function update(col,id,body){
  try{ const rec=await api("PUT",`/api/${col}/${id}`,body); const i=S.data[col].findIndex(x=>x.id===rec.id); if(i>=0) S.data[col][i]=rec; render(); refreshActivity(); return rec; }
  catch(e){ toast(e.message); return null; }
}
async function remove(col,id){
  try{ await api("DELETE",`/api/${col}/${id}`); S.data[col]=S.data[col].filter(x=>x.id!==Number(id)); render(); refreshActivity(); return true; }
  catch(e){ toast(e.message); return false; }
}
async function loadAll(){
  const b=await api("GET","/api/bootstrap");
  S.loadedAt=new Date();
  S.me=b.me; S.tenant=b.tenant; S.settings=b.settings; S.users=b.users; S.data=b.data; S.unread=b.unread||0;
  if(isSuper()) await loadAdmin();
  applyBrand(S.settings);
  refreshActivity();
  render();
}
// super admin only: every tenant and every account
async function loadAdmin(){
  try{ [S.tenants,S.allUsers]=await Promise.all([api("GET","/api/admin/tenants"),api("GET","/api/admin/users")]); }catch(e){}
}
async function refreshActivity(){ try{ S.activity=await api("GET","/api/activity"); if(S.view==="overview") render(); }catch(e){} }

/* ---------- branding ---------- */
function applyBrand(s){
  const root=document.documentElement;
  if(s.brandColor&&/^#[0-9a-f]{6}$/i.test(s.brandColor)){
    root.style.setProperty("--accent",s.brandColor);
    const [r,g,b]=[1,3,5].map(i=>parseInt(s.brandColor.slice(i,i+2),16)/255).map(c=>c<=.03928?c/12.92:((c+.055)/1.055)**2.4);
    root.style.setProperty("--accent-fg",(0.2126*r+0.7152*g+0.0722*b)>0.45?"#111111":"#ffffff");
  } else { root.style.removeProperty("--accent"); root.style.removeProperty("--accent-fg"); }
  document.title=(s.companyName||"Company")+" CRM";
}
// "Samvay360" -> SAMVAY + copper 360, matching the site's wordmark
const wordmark = name => { const m=/^(.*?)(\d+)$/.exec(name||""); return m?`${esc(m[1])}<span class="hl">${esc(m[2])}</span>`:esc(name||"Your company"); };
const brandMark = (s) => s.logo?`<span class="brand-mark"><img src="${esc(s.logo)}" alt=""></span>`:`<span class="brand-mark">${esc((s.companyName||"CRM").trim().slice(0,2).toUpperCase())}</span>`;

/* ---------- totals for quotes/invoices ---------- */
function totals(doc){
  const sub=(doc.items||[]).reduce((s,i)=>s+num(i.qty)*num(i.rate),0);
  const disc=Math.min(num(doc.discount),sub);
  const tax=(sub-disc)*num(doc.tax_rate)/100;
  const total=sub-disc+tax;
  const paid=(doc.payments||[]).reduce((s,p)=>s+num(p.amount),0);
  return {sub,disc,tax,total,paid,balance:Math.max(total-paid,0)};
}
function invoiceStatus(inv){
  if(inv.status==="Void"||inv.status==="Draft"||!inv.status) return inv.status||"Draft";
  const t=totals(inv);
  if(t.total>0 && t.balance<=0.004) return "Paid";
  if(inv.due_date && inv.due_date<todayISO()) return "Overdue";
  return t.paid>0 ? "Partially paid" : "Sent";
}
function quoteStatus(q){
  if(q.status==="Sent" && q.valid_until && q.valid_until<todayISO()) return "Expired";
  return q.status||"Draft";
}
const TONE = {
  New:"info",Contacted:"info",Qualified:"accent",Proposal:"warn",Negotiation:"warn",Won:"good",Lost:"bad",
  Planning:"info",Active:"accent","On hold":"warn",Completed:"good",Cancelled:"bad",
  "In progress":"info",Review:"warn",Done:"good",
  Sent:"info",Accepted:"good",Declined:"bad",Expired:"warn",
  "Partially paid":"warn",Paid:"good",Overdue:"bad",
  Medium:"warn",High:"bad"
};
const pill = s => `<span class="pill ${TONE[s]??""}">${esc(s)}</span>`;
function nextNumber(col,prefix){
  let max=0; const re=new RegExp("^"+prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(\\d+)$");
  for(const d of S.data[col]){ const m=re.exec(d.number||""); if(m) max=Math.max(max,parseInt(m[1],10)); }
  return prefix+String(max+1).padStart(4,"0");
}

/* ---------- auth screens ---------- */
async function start(){
  let st;
  try{ st=await api("GET","/api/status"); }catch(e){ return showFatal(e.message); }
  applyBrand(st);
  if(st.needsSetup) return showSetup(st);
  if(!st.user) return showAuth(st);
  showApp();
  const rt=routeFromUrl();
  S.view=rt.view; S.param=rt.param; if(rt.tab) S.settingsTab=rt.tab;
  try{ await loadAll(); }catch(e){ return showLoadError(e.message); }
  S.ready=true;
  history.replaceState({route:true,scroll:0,sheetPushed:false,preset:null},"",location.pathname+location.search); remember();
  applyRoute(rt);
}
function showFatal(msg){
  $("#root").innerHTML=`<div class="auth"><div class="auth-box"><h1>Can't reach the CRM</h1><p>${esc(msg)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`;
}
function showLoadError(msg){
  const m=$("#main"); if(!m) return showFatal(msg);
  m.innerHTML=`<div class="panel load-error" role="alert"><strong>Your data didn't load</strong><p>${esc(msg)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
}
function authShell(st,inner){
  $("#root").innerHTML=`<div class="auth"><form class="auth-box" id="auth-form" novalidate>${st?.logo?`<img class="auth-logo" src="${esc(st.logo)}" alt="">`:""}${inner}<div class="error" id="auth-error" role="alert"></div></form></div>`;
  $("#auth-form input")?.focus();
}
async function showAuth(st){
  S.ready=false; S.sheet=null; S.modal?.dismiss(); if($("#overlay")) $("#overlay").innerHTML="";
  if(!st){ try{ st=await api("GET","/api/status"); }catch(e){ st={}; } }
  authShell(st,`<h1>Sign in${st.companyName?" to "+esc(st.companyName):""}</h1><p>Use the email and password your administrator gave you.</p>
    <div class="field"><label for="a-email">Email</label><input class="input" id="a-email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="a-pass">Password</label><input class="input" id="a-pass" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" type="submit">Sign in</button>`);
  $("#auth-form").onsubmit=async e=>{ e.preventDefault();
    try{ await api("POST","/api/login",{email:$("#a-email").value,password:$("#a-pass").value}); location.reload(); }
    catch(err){ $("#auth-error").textContent=err.message; } };
}
function showSetup(st){
  authShell(st,`<h1>Set up your CRM</h1><p>Create the super admin account. Only the super admin can add companies and user accounts, from Settings → Accounts.</p>
    <div class="field"><label for="a-company">Company name</label><input class="input" id="a-company"></div>
    <div class="field"><label for="a-name">Your name</label><input class="input" id="a-name" autocomplete="name" required></div>
    <div class="field"><label for="a-email">Email</label><input class="input" id="a-email" type="email" autocomplete="username" required></div>
    <div class="field"><label for="a-pass">Password</label><input class="input" id="a-pass" type="password" autocomplete="new-password" minlength="8" required><span class="hint">At least 8 characters.</span></div>
    <button class="btn primary" type="submit">Create account</button>`);
  $("#auth-form").onsubmit=async e=>{ e.preventDefault();
    try{ await api("POST","/api/setup",{companyName:$("#a-company").value,name:$("#a-name").value,email:$("#a-email").value,password:$("#a-pass").value}); location.reload(); }
    catch(err){ $("#auth-error").textContent=err.message; } };
}
function showApp(){
  $("#root").innerHTML=`<div class="app"><nav class="rail" id="rail" aria-label="Modules">${skeletonRail()}</nav><main id="main" aria-busy="true">${skeletonPage()}</main></div>`;
}
// Placeholders shown while the first load is in flight.
const skeletonRail=()=>`<div class="brand"><span class="brand-mark"></span><span class="skel" style="width:110px;height:14px"></span></div>${Array.from({length:9},()=>`<span class="skel nav-skel"></span>`).join("")}`;
const skeletonPage=()=>`<div class="head"><div><span class="skel" style="width:220px;height:30px"></span><span class="skel" style="width:320px;height:12px;margin-top:10px"></span></div></div>
  <div class="kpis">${Array.from({length:4},()=>`<div class="panel kpi"><span class="skel" style="width:60%;height:10px"></span><span class="skel" style="width:80%;height:24px;margin-top:10px"></span></div>`).join("")}</div>
  <div class="panel" style="padding:18px"><div class="skel-lines"><i></i><i></i><i></i><i></i><i></i></div></div>`;

/* ---------- navigation ----------
 * Every page has a real address and goes into browser history, so Back/Forward, reload,
 * bookmarks and "open in new tab" all work:
 *   /  /leads  /clients  /clients/12  /projects  /projects/7  /tasks
 *   /quotations  /invoices  /expenses  /settings/<tab>
 * An open record panel adds ?record=<collection>/<id|new>, so Back closes it and a link can open it.
 * A route is {view, param, tab, record:{col,id}|null}. */
const PATHS={overview:"",leads:"leads",clients:"clients",client:"clients",projects:"projects",project:"projects",tasks:"tasks",
  quotes:"quotations",invoices:"invoices",expenses:"expenses",money:"money",settings:"settings",docs:"docs",doc:"docs"};
const VIEW_OF={money:"money",docs:"docs",leads:"leads",clients:"clients",projects:"projects",tasks:"tasks",quotations:"quotes",invoices:"invoices",expenses:"expenses",settings:"settings"};
const TITLES={money:"Money",docs:"Docs",overview:"Overview",leads:"Leads",clients:"Clients",projects:"Projects",tasks:"Tasks",quotes:"Quotations",invoices:"Invoices",expenses:"Expenses",settings:"Settings"};
const sameRecord=(a,b)=>(!a&&!b)||(!!a&&!!b&&a.col===b.col&&String(a.id)===String(b.id));

function routeFromUrl(){
  const parts=location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let view=VIEW_OF[parts[0]]||"overview", param=null, tab=null;
  if(view==="clients"&&parts[1]){ view="client"; param=Number(parts[1]); }
  if(view==="projects"&&parts[1]){ view="project"; param=Number(parts[1]); }
  if(view==="docs"&&parts[1]){ view="doc"; param=Number(parts[1]); }
  if(view==="settings") tab=parts[1]||"company";
  let record=null; const r=new URLSearchParams(location.search).get("record");
  if(r){ const [col,id]=r.split("/"); if(COLS.includes(col)&&id) record={col,id:id==="new"?"new":Number(id)}; }
  const receipt=record&&record.col==="invoices"?new URLSearchParams(location.search).get("receipt"):null;
  return {view,param,tab,record,receipt:receipt||null};
}
function urlFor(rt){
  let p="/"+(PATHS[rt.view]??"");
  if((rt.view==="client"||rt.view==="project"||rt.view==="doc")&&rt.param) p+="/"+rt.param;
  if(rt.view==="settings") p+="/"+(rt.tab||"company");
  if(rt.record) p+="?record="+rt.record.col+"/"+rt.record.id;
  if(rt.record&&rt.receipt) p+="&receipt="+encodeURIComponent(rt.receipt);
  return p;
}
const currentRoute=()=>({view:S.view,param:S.param,tab:S.view==="settings"?S.settingsTab:null,
  record:S.sheet?{col:S.sheet.col,id:S.sheet.id||"new"}:null, receipt:S.sheet?.receipt||null});
const pageUrl=(view,param=null)=>urlFor({view,param,tab:view==="settings"?S.settingsTab:null});

function saveScroll(){ try{ history.replaceState({...(history.state||{}),scroll:scrollY},""); }catch(e){} }
function remember(){ S.lastUrl=location.pathname+location.search; S.lastState=history.state; }

// Go somewhere. Asks before throwing away unsaved panel edits, unless force.
async function navigate(rt,{replace=false,preset=null,force=false}={}){
  const leavingRecord=!sameRecord(rt.record,currentRoute().record);
  if(!force&&leavingRecord&&sheetIsDirty()&&!await confirmDiscard()) return false;
  if(S.view==="doc"&&!(rt.view==="doc"&&rt.param===S.param)) await flushDoc();
  const url=urlFor(rt);
  saveScroll();
  const state={route:true,preset:preset||null,scroll:0,
    // a panel opened on top of a page: closing it goes Back instead of adding another entry
    // same record (e.g. opening its receipt) keeps the panel's flag; a newly opened panel was pushed
    sheetPushed:rt.record?(replace||sameRecord(rt.record,currentRoute().record)?!!history.state?.sheetPushed:true):false,
    receiptPushed:rt.receipt?(replace?!!history.state?.receiptPushed:!currentRoute().receipt||!!history.state?.receiptPushed):false};
  if(replace||url===location.pathname+location.search) history.replaceState(state,"",url); else history.pushState(state,"",url);
  remember();
  applyRoute(rt,{preset,scrollTop:!replace});
  return true;
}
function go(view,param=null){ return navigate({view,param,tab:view==="settings"?S.settingsTab:null}); }
function openRecord(col,id,preset={}){ S.sheetOpener=document.activeElement; return navigate({...currentRoute(),record:{col,id:id||"new"}},{preset}); }
async function closeSheetNav({force=false}={}){
  if(!S.sheet) return;
  if(!force&&sheetIsDirty()&&!await confirmDiscard()) return;
  const steps=(history.state?.sheetPushed?1:0)+(history.state?.receiptPushed?1:0);
  if(history.state?.sheetPushed){ S.skipDirtyCheck=true; history.go(-steps); }
  else navigate({...currentRoute(),record:null},{replace:true,force:true});
}

// Show what a route describes: the page, plus the record panel if any.
function applyRoute(rt,{preset=null,scrollTop=false,scrollTo=null}={}){
  const viewChanged=rt.view!==S.view||rt.param!==S.param||(rt.view==="settings"&&rt.tab!==S.settingsTab);
  if(S.docPage&&!(rt.view==="doc"&&rt.param===S.docPage.id)){ flushDoc(); leaveDocPage(); }
  S.view=rt.view; S.param=rt.param; if(rt.view==="settings") S.settingsTab=rt.tab||"company";
  if(viewChanged) S.viewEnter=true;
  if(rt.view==="doc"&&S.ready) enterDocPage(rt.param);
  const rail=$("#rail"); if(rail?.classList.contains("open")){ rail.classList.remove("open"); $('[data-act="menu"]')?.setAttribute("aria-expanded","false"); }
  if($("#main")&&S.ready) doRender();
  if(S.ready){
    if(!rt.record){ if(S.sheet) hideSheet(); }
    else if(!sameRecord(rt.record,currentRoute().record)){
      if(!showRecord(rt.record.col,rt.record.id==="new"?null:rt.record.id,preset||{})){
        // the record no longer exists: drop it from the address
        history.replaceState({...history.state,sheetPushed:false},"",urlFor({...rt,record:null})); remember();
      }
    }
  }
  // the invoice panel can show one of its payment receipts
  if(S.ready&&rt.record&&S.sheet?.doc&&(S.sheet.receipt||null)!==(rt.receipt||null)){
    const exists=!rt.receipt||(S.sheet.doc.payments||[]).some(p=>p.receipt_no===rt.receipt);
    S.sheet.receipt=exists?rt.receipt:null; drawDocEditor();
    if(!exists){ toast("That receipt was not found on this invoice."); history.replaceState({...history.state,receiptPushed:false},"",urlFor({...rt,receipt:null})); remember(); }
  }
  document.title=`${rt.record&&S.sheet?sheetTitle()+" · ":""}${(rt.view==="doc"?(S.docPage?.doc?.title||"Untitled doc"):TITLES[rt.view==="client"?"clients":rt.view==="project"?"projects":rt.view])||"CRM"} · ${S.settings.companyName||"Company"} CRM`;
  if(scrollTo!=null) requestAnimationFrame(()=>scrollTo>=0&&window.scrollTo(0,scrollTo));
  else if(scrollTop&&viewChanged) window.scrollTo(0,0);
  if(viewChanged&&!rt.record) requestAnimationFrame(()=>$("#main h1")?.focus({preventScroll:true}));
}
const sheetTitle=()=>{ const t=$("#overlay .sheet-head h2"); return t?t.textContent.trim().replace(/\s+/g," ").slice(0,60):""; };

addEventListener("popstate",async e=>{
  if(!S.ready) return;
  // Back while a dialog is open just closes the dialog
  if(S.modal){ S.modal.dismiss(); history.pushState(S.lastState,"",S.lastUrl); return; }
  const rt=routeFromUrl();
  if(!S.skipDirtyCheck&&!sameRecord(rt.record,currentRoute().record)&&sheetIsDirty()){
    history.pushState(S.lastState,"",S.lastUrl); // stay put while asking
    if(await confirmDiscard()){ S.skipDirtyCheck=true; history.back(); }
    return;
  }
  S.skipDirtyCheck=false;
  remember();
  applyRoute(rt,{preset:e.state?.preset,scrollTo:e.state?.scroll??0});
});
addEventListener("beforeunload",e=>{
  if(S.docPage&&["dirty","error","saving"].includes(S.docPage.status)){ saveDoc({keepalive:true}); e.preventDefault(); e.returnValue=""; return; }
  if(sheetIsDirty()||Object.keys(S.dirty).length||(S.layoutDraft&&layoutChanged())){ e.preventDefault(); e.returnValue=""; }
});
if("scrollRestoration" in history) history.scrollRestoration="manual";
// links from the earlier version (#leads, #client/3) still work
if(/^#[a-z]+(\/\d+)?$/.test(location.hash)){ const [v,p]=location.hash.slice(1).split("/"); history.replaceState(null,"",urlFor({view:v,param:p?Number(p):null,tab:null})); }

/* ---------- render shell ---------- */
function renderRail(){
  const c={leads:S.data.leads.filter(l=>!["Won","Lost"].includes(l.stage)).length,clients:S.data.clients.length,projects:S.data.projects.filter(p=>p.status==="Active").length,
    tasks:S.data.tasks.filter(t=>t.status!=="Done").length,quotes:S.data.quotes.length,invoices:S.data.invoices.filter(i=>["Sent","Partially paid","Overdue"].includes(invoiceStatus(i))).length};
  const parent={client:"clients",project:"projects",doc:"docs"}[S.view]||S.view;
  $("#rail").innerHTML=`<div class="brand">${brandMark(S.settings)}<span class="brand-name">${wordmark((S.settings.companyName||"").toUpperCase())}<small>CRM</small></span><button type="button" class="bell" id="bell" data-act="bell" aria-label="Notifications"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5 5 0 0 0-5 5v2.7l-1.4 2.6a.8.8 0 0 0 .7 1.2h11.4a.8.8 0 0 0 .7-1.2L15 10.2V7.5a5 5 0 0 0-5-5Z"/><path d="M8 16a2 2 0 0 0 4 0"/></svg><span class="bell-count" id="bell-count" hidden></span></button><button class="burger" data-act="menu" aria-label="Menu" aria-expanded="${$("#rail")?.classList.contains("open")?"true":"false"}"><span></span><span></span><span></span></button></div>`+
    NAV.map(n=>n[0]==="sep"?`<div class="nav-sep"></div>`:
      `<a class="nav-btn" href="${n[0]==="settings"?"/settings/company":pageUrl(n[0])}" data-go="${n[0]}" ${parent===n[0]?'aria-current="page"':""}><span>${n[1]}</span>${c[n[0]]!=null?`<span class="count">${c[n[0]]}</span>`:""}</a>`).join("")+
    `<div class="rail-foot">${isSuper()&&S.tenants.length?`<label class="label-mono" for="tenant-switch">Working in</label><select class="input" id="tenant-switch" aria-label="Switch company">${S.tenants.map(t=>`<option value="${t.id}" ${t.id===S.tenant?.id?"selected":""}>${esc(t.name)}${t.active?"":" (disabled)"}</option>`).join("")}</select>`:""}<span>${esc(S.me?.name||"")} <span class="tag">${roleLabel(S.me?.role)}</span></span><button data-act="refresh" title="Load the latest changes made by your team">↻ Refresh</button><span class="cell-sub" id="loaded-at">${S.loadedAt?"Updated "+S.loadedAt.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}):""}</span><button data-act="logout">Sign out</button></div>`;
}
function head(title,sub,actions=""){
  return `<div class="head"><div><h1 tabindex="-1">${esc(title)}</h1>${sub?`<p>${sub}</p>`:""}</div><div class="toolbar">${actions}</div></div>`;
}
const addBtn = (label,act) => `<button class="btn primary" data-act="${act}">${esc(label)}</button>`;
const searchBox = key => `<input class="input search" type="search" id="q-${key}" placeholder="Search…" value="${esc(S.q[key]||"")}" data-search="${key}" aria-label="Search">`;
const emptyState = (title,body,btnLabel,act) => `<div class="empty"><strong>${esc(title)}</strong>${esc(body)}${btnLabel?`<br><button class="btn primary" data-act="${act}">${esc(btnLabel)}</button>`:""}</div>`;

let queued=false;
function render(){ if(queued||!$("#main")) return; queued=true; requestAnimationFrame(()=>{ queued=false; doRender(); }); }
function doRender(){
  renderRail(); paintBell();
  if(S.view==="doc"&&S.docPage?.mounted&&S.docPage.id===S.param&&$("#ed-surface .ProseMirror")){ paintDocChrome(); return; }
  const main=$("#main");
  const active=document.activeElement, activeId=main.contains(active)?active.id:null;
  let selStart=null, selEnd=null; try{ selStart=active.selectionStart; selEnd=active.selectionEnd; }catch(e){}
  // typed-in values belong to one page of one company; forget them when either changes
  const key=[S.view,S.param,S.tenant?.id].join("|");
  if(key!==S.dirtyKey){ S.dirty={}; S.dirtyKey=key; }
  const views={overview:viewOverview,leads:viewLeads,clients:viewClients,projects:viewProjects,tasks:viewTasks,quotes:()=>viewDocs("quotes"),invoices:()=>viewDocs("invoices"),expenses:viewExpenses,money:viewMoney,settings:viewSettings,client:viewClient,project:viewProject,docs:viewDocsList,doc:viewDocPage};
  main.innerHTML=(views[S.view]||viewOverview)();
  main.removeAttribute("aria-busy");
  if(S.viewEnter){ S.viewEnter=false; main.classList.remove("view-enter"); void main.offsetWidth; main.classList.add("view-enter"); }
  // label each table cell with its column heading so the phone layout can show it as a stacked card
  main.querySelectorAll(".table-wrap table").forEach(t=>{ const heads=[...t.querySelectorAll("thead th")].map(th=>th.textContent.trim());
    t.querySelectorAll("tbody tr").forEach(tr=>[...tr.children].forEach((td,i)=>{ if(heads[i]) td.dataset.label=heads[i]; })); });
  // a redraw (e.g. the 30-second refresh) must not wipe what the viewer is typing
  for(const [id,v] of Object.entries(S.dirty)){ const el=document.getElementById(id); if(el&&main.contains(el)) el.value=v; }
  fitLayoutPreview();
  if(activeId){ const el=document.getElementById(activeId); if(el){ el.focus({preventScroll:true}); if(selStart!=null) try{ el.setSelectionRange(selStart,selEnd); }catch(e){} } }
}

/* ---------- overview ---------- */
function viewOverview(){
  const d=S.data, t=todayISO(), wk=addDays(t,7);
  const openLeads=d.leads.filter(l=>!["Won","Lost"].includes(l.stage));
  const pipeline=openLeads.reduce((s,l)=>s+num(l.value),0);
  const invs=d.invoices.map(i=>({...i,_s:invoiceStatus(i),_t:totals(i)}));
  const outstanding=invs.filter(i=>["Sent","Partially paid","Overdue"].includes(i._s)).reduce((s,i)=>s+i._t.balance,0);
  const overdue=invs.filter(i=>i._s==="Overdue");
  const month=t.slice(0,7);
  const paidMonth=d.invoices.flatMap(i=>i.payments||[]).filter(p=>(p.date||"").startsWith(month)).reduce((s,p)=>s+num(p.amount),0);
  const activeProj=d.projects.filter(p=>p.status==="Active");
  const dueTasks=d.tasks.filter(x=>x.status!=="Done"&&x.due_date&&x.due_date<=wk).sort((a,b)=>a.due_date.localeCompare(b.due_date));
  const won=d.leads.filter(l=>l.stage==="Won").length, lost=d.leads.filter(l=>l.stage==="Lost").length;
  const winRate=won+lost?Math.round(won/(won+lost)*100)+"%":"—";
  let h=head("Overview",new Date().toLocaleDateString(undefined,{weekday:"long",day:"numeric",month:"long",year:"numeric"}));
  if(COLS.every(c=>!d[c].length)){
    h+=`<div class="panel" style="margin-bottom:16px"><div class="empty"><strong>Your CRM is ready</strong>Add your company details and team first, then your first lead or client.<br>
    <span class="toolbar" style="justify-content:center;margin-top:12px">${isAdmin()?`<a class="btn" href="/settings/company" data-go="settings">Company & team settings</a>`:""}<button class="btn primary" data-act="new-lead">Add a lead</button><button class="btn" data-act="new-client">Add a client</button></span></div></div>`;
  }
  h+=`<div class="kpis">
    <div class="panel kpi"><div class="label">Open pipeline</div><div class="value">${money(pipeline)}</div><div class="sub">${openLeads.length} open lead${openLeads.length===1?"":"s"} · win rate ${winRate}</div></div>
    <div class="panel kpi"><div class="label">Outstanding</div><div class="value">${money(outstanding)}</div><div class="sub">${overdue.length?`<span style="color:var(--bad)">${overdue.length} overdue</span>`:"Nothing overdue"}</div></div>
    <div class="panel kpi"><div class="label">Received this month</div><div class="value">${money(paidMonth)}</div><div class="sub">Payments recorded in ${new Date().toLocaleDateString(undefined,{month:"long"})}</div></div>
    <div class="panel kpi"><div class="label">Spent this month</div><div class="value">${money(d.expenses.filter(e=>(e.date||"").startsWith(month)).reduce((a,e)=>a+num(e.amount),0))}</div><div class="sub">${d.expenses.filter(e=>(e.date||"").startsWith(month)).length} expense${d.expenses.filter(e=>(e.date||"").startsWith(month)).length===1?"":"s"} recorded</div></div>
    <div class="panel kpi"><div class="label">Active projects</div><div class="value">${activeProj.length}</div><div class="sub">${dueTasks.length} task${dueTasks.length===1?"":"s"} due within 7 days</div></div>
  </div><div class="grid2">`;
  const followUps=openLeads.filter(l=>l.next_follow_up&&l.next_follow_up<=wk).sort((a,b)=>a.next_follow_up.localeCompare(b.next_follow_up));
  h+=`<section class="panel"><h2>Lead follow-ups</h2>${followUps.length?`<ul class="list-plain">${followUps.slice(0,8).map(l=>`<li data-open="leads:${l.id}"><span><span class="cell-main">${esc(l.name)}</span><br><span class="cell-sub">${esc(l.stage||"New")} · ${esc(userName(l.owner_id))}</span></span><span class="meta" style="${l.next_follow_up<t?"color:var(--bad)":""}">${l.next_follow_up<t?"Overdue · ":""}${fmtDate(l.next_follow_up)}</span></li>`).join("")}</ul>`:`<div class="empty">No lead follow-ups due this week.</div>`}</section>`;
  h+=`<section class="panel"><h2>Tasks due soon</h2>${dueTasks.length?`<ul class="list-plain">${dueTasks.slice(0,8).map(x=>`<li data-open="tasks:${x.id}"><span><span class="cell-main">${esc(x.title)}</span><br><span class="cell-sub">${esc(projectName(x.project_id)||"No project")} · ${esc(userName(x.assignee_id))}</span></span><span class="meta" style="${x.due_date<t?"color:var(--bad)":""}">${x.due_date<t?"Overdue · ":""}${fmtDate(x.due_date)}</span></li>`).join("")}</ul>`:`<div class="empty">No open tasks due this week.</div>`}</section>`;
  h+=myTasksPanel();
  h+=`<section class="panel"><h2>Overdue invoices</h2>${overdue.length?`<ul class="list-plain">${overdue.map(i=>`<li data-open="invoices:${i.id}"><span><span class="cell-main mono">${esc(i.number)}</span><br><span class="cell-sub">${esc(clientName(i.client_id))}</span></span><span class="meta"><span class="num">${money(i._t.balance)}</span><br>due ${fmtDate(i.due_date)}</span></li>`).join("")}</ul>`:`<div class="empty">No overdue invoices.</div>`}</section>`;
  const stageVals=LEAD_STAGES.filter(s=>s!=="Lost").map(s=>{const ls=d.leads.filter(l=>l.stage===s);return {s,n:ls.length,v:ls.reduce((a,l)=>a+num(l.value),0)};});
  const maxV=Math.max(1,...stageVals.map(x=>x.v));
  h+=`<section class="panel"><h2>Pipeline by stage</h2><div style="padding:14px 16px;display:grid;gap:10px">${stageVals.map(x=>`<div style="display:grid;grid-template-columns:110px 1fr auto;gap:10px;align-items:center;font-size:13px"><span>${x.s} <span class="cell-sub">(${x.n})</span></span><div class="progress"><i style="width:${(x.v/maxV*100).toFixed(1)}%"></i></div><span class="num">${money(x.v)}</span></div>`).join("")}</div></section>`;
  const regions=[...new Set(openLeads.map(l=>l.region||"No region"))].map(r=>{const ls=openLeads.filter(l=>(l.region||"No region")===r);return {r,n:ls.length,v:ls.reduce((a,l)=>a+num(l.value),0)};}).sort((a,b)=>b.v-a.v);
  const maxR=Math.max(1,...regions.map(x=>x.v));
  h+=`<section class="panel"><h2>Open leads by region</h2>${regions.length?`<div style="padding:14px 16px;display:grid;gap:10px">${regions.map(x=>`<div style="display:grid;grid-template-columns:110px 1fr auto;gap:10px;align-items:center;font-size:13px"><span>${esc(x.r)} <span class="cell-sub">(${x.n})</span></span><div class="progress"><i style="width:${(x.v/maxR*100).toFixed(1)}%"></i></div><span class="num">${money(x.v)}</span></div>`).join("")}</div>`:`<div class="empty">No open leads.</div>`}</section>`;
  h+=`<section class="panel"><h2>Recent activity</h2>${S.activity.length?`<ul class="list-plain">${S.activity.slice(0,10).map(a=>`<li ${a.action!=="deleted"&&byId(a.entity,a.entity_id)?`data-open="${a.entity}:${a.entity_id}"`:""}><span>${esc(a.summary)}<br><span class="cell-sub">${esc(userName(a.user_id))}</span></span><span class="meta">${fmtDateTime(a.at)}</span></li>`).join("")}</ul>`:`<div class="empty">Nothing yet.</div>`}</section>`;
  return h+`</div>`;
}

/* ---------- leads ---------- */
function viewLeads(){
  const q=S.q.leads;
  let rows=S.data.leads.filter(l=>matches({...l,_by:userName(l.created_by)},q));
  if(S.leadRegion) rows=rows.filter(l=>(l.region||"")===S.leadRegion);
  const mode=S.mode.leads;
  const regions=[...new Set([...(S.settings.regions||[]),...S.data.leads.map(l=>l.region).filter(Boolean)])];
  let h=head("Leads","Track prospects from first contact to won deal. Drag cards between stages.",
    `${searchBox("leads")}<select class="input inline" id="lead-region" aria-label="Filter by region"><option value="">All regions</option>${regions.map(r=>`<option ${r===S.leadRegion?"selected":""}>${esc(r)}</option>`).join("")}</select><div class="seg" role="group" aria-label="View"><button data-mode="leads:board" aria-pressed="${mode==="board"}">Board</button><button data-mode="leads:table" aria-pressed="${mode==="table"}">Table</button></div><button class="btn" data-act="csv-leads">Export CSV</button>${addBtn("New lead","new-lead")}`);
  if(!S.data.leads.length) return h+`<div class="panel">${emptyState("No leads yet","Add enquiries as they come in and move them along the pipeline as they progress.","Add your first lead","new-lead")}</div>`;
  if(mode==="board"){
    h+=`<div class="board">${LEAD_STAGES.map(st=>{const items=rows.filter(l=>(l.stage||"New")===st);const total=items.reduce((s,l)=>s+num(l.value),0);
      return `<div class="col" data-drop="leads:stage:${st}"><div class="col-head"><span>${st} <span class="num">${items.length}</span></span><span class="num">${money(total)}</span></div>${items.map(l=>`<div class="card" draggable="true" data-drag="${l.id}" data-open="leads:${l.id}"><span class="t">${esc(l.name)}</span>${l.company?`<span class="cell-sub">${esc(l.company)}</span>`:""}<span class="s"><span class="num">${money(l.value)}</span>${l.region?`<span class="tag">${esc(l.region)}</span>`:""}</span><span class="s"><span>Added by ${esc(userName(l.created_by))}</span><span>${l.next_follow_up?"Follow up "+fmtDate(l.next_follow_up):""}</span></span></div>`).join("")}</div>`;}).join("")}</div>`;
  } else {
    h+=`<div class="panel table-wrap"><table><thead><tr><th>Lead</th><th>Stage</th><th>Region</th><th>Ref</th><th>Source</th><th>Owner</th><th>Added by</th><th class="r">Value</th></tr></thead><tbody>${rows.map(l=>`<tr data-open="leads:${l.id}"><td><div class="cell-main">${esc(l.name)}</div><div class="cell-sub">${esc([l.company,l.email].filter(Boolean).join(" · "))}</div></td><td>${pill(l.stage||"New")}</td><td>${esc(l.region||"—")}</td><td>${esc(l.ref||"—")}</td><td>${esc(l.source||"—")}</td><td>${esc(l.owner_id?userName(l.owner_id):"—")}</td><td><div>${esc(userName(l.created_by))}</div><div class="cell-sub">${fmtDate(l.created_at)}</div></td><td class="r num">${money(l.value)}</td></tr>`).join("")||`<tr><td colspan="8" class="empty">No leads match these filters.</td></tr>`}</tbody></table></div>`;
  }
  return h;
}

/* ---------- clients ---------- */
function viewClients(){
  const rows=S.data.clients.filter(c=>matches(c,S.q.clients)).sort((a,b)=>(a.company||a.name||"").localeCompare(b.company||b.name||""));
  let h=head("Clients","Everyone you do business with, with their projects, quotations and invoices.",`${searchBox("clients")}<button class="btn" data-act="csv-clients">Export CSV</button>${addBtn("New client","new-client")}`);
  if(!S.data.clients.length) return h+`<div class="panel">${emptyState("No clients yet","Add a client directly, or convert a won lead into a client.","Add your first client","new-client")}</div>`;
  h+=`<div class="panel table-wrap"><table><thead><tr><th>Client</th><th>Contact</th><th>Region</th><th class="r">Projects</th><th class="r">Billed</th><th class="r">Outstanding</th></tr></thead><tbody>`;
  h+=rows.map(c=>{const inv=S.data.invoices.filter(i=>i.client_id===c.id&&!["Draft","Void"].includes(i.status));const billed=inv.reduce((s,i)=>s+totals(i).total,0);const due=inv.reduce((s,i)=>s+totals(i).balance,0);
    return `<tr data-go-detail="client:${c.id}"><td><div class="cell-main">${esc(c.company||c.name)}</div>${c.company&&c.name?`<div class="cell-sub">${esc(c.name)}</div>`:""}</td><td><div>${esc(c.email||"—")}</div><div class="cell-sub">${esc(c.phone||"")}</div></td><td>${esc(c.region||"—")}</td><td class="r num">${S.data.projects.filter(p=>p.client_id===c.id).length}</td><td class="r num">${money(billed)}</td><td class="r num" style="${due>0?"color:var(--warn)":""}">${money(due)}</td></tr>`;}).join("");
  return h+`</tbody></table></div>`;
}
function viewClient(){
  const c=byId("clients",S.param);
  if(!c) return head("Client not found","")+`<button class="btn" data-go="clients">Back to clients</button>`;
  const projects=S.data.projects.filter(p=>p.client_id===c.id), quotes=S.data.quotes.filter(x=>x.client_id===c.id), invs=S.data.invoices.filter(x=>x.client_id===c.id);
  const due=invs.filter(i=>!["Draft","Void"].includes(i.status)).reduce((s,i)=>s+totals(i).balance,0);
  let h=head(c.company||c.name,`<a class="btn ghost sm" href="/clients" data-go="clients">← All clients</a>`,
    `<button class="btn" data-open="clients:${c.id}">Edit</button><button class="btn" data-act="new-project" data-client="${c.id}">New project</button><button class="btn" data-act="new-quotes" data-client="${c.id}">New quotation</button><button class="btn primary" data-act="new-invoices" data-client="${c.id}">New invoice</button>`);
  const cells=[["Contact",esc(c.name||"—")],["Email",esc(c.email||"—")],["Phone",esc(c.phone||"—")],["Region",esc(c.region||"—")],["Ref",esc(c.ref||"—")],["Address",esc(c.address||"—")],["GSTIN / Tax no.",esc(c.tax_id||"—")],["Outstanding",`<span class="num">${money(due)}</span>`],["Added by",`${esc(userName(c.created_by))} · ${fmtDate(c.created_at)}`]];
  h+=`<div class="panel" style="margin-bottom:16px"><dl class="detail-grid">${cells.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${c.notes?`<div style="padding:0 16px 16px;white-space:pre-wrap;color:var(--muted)">${esc(c.notes)}</div>`:""}</div><div class="grid2">`;
  h+=`<section class="panel"><h2>Projects</h2>${projects.length?`<ul class="list-plain">${projects.map(p=>`<li data-go-detail="project:${p.id}"><span class="cell-main">${esc(p.name)}</span><span class="meta">${pill(p.status||"Planning")}</span></li>`).join("")}</ul>`:`<div class="empty">No projects.</div>`}</section>`;
  h+=`<section class="panel"><h2>Quotations</h2>${quotes.length?`<ul class="list-plain">${quotes.map(x=>`<li data-open="quotes:${x.id}"><span class="mono">${esc(x.number)}</span><span class="meta"><span class="num">${money(totals(x).total)}</span> ${pill(quoteStatus(x))}</span></li>`).join("")}</ul>`:`<div class="empty">No quotations.</div>`}</section>`;
  const receipts=invs.flatMap(inv=>(inv.payments||[]).filter(p=>p.receipt_no).map(p=>({inv,p}))).sort((a,b)=>(b.p.date||"").localeCompare(a.p.date||""));
  h+=`<section class="panel linked-panel">${linkedDocsHtml("clients",c.id)}</section>`;
  h+=`<section class="panel"><h2>Payments received</h2>${receipts.length?`<ul class="list-plain">${receipts.map(({inv,p})=>`<li data-open-receipt="${inv.id}|${esc(p.receipt_no)}"><span><span class="mono cell-main">${esc(p.receipt_no)}</span><br><span class="cell-sub">${fmtDate(p.date)} · ${esc(inv.number)}${p.method?" · "+esc(p.method):""}</span></span><span class="meta num">${money(p.amount)}</span></li>`).join("")}</ul>`:`<div class="empty">No payments yet.</div>`}</section>`;
  h+=`<section class="panel"><h2>Invoices</h2>${invs.length?`<ul class="list-plain">${invs.map(x=>`<li data-open="invoices:${x.id}"><span class="mono">${esc(x.number)}</span><span class="meta"><span class="num">${money(totals(x).total)}</span> ${pill(invoiceStatus(x))}</span></li>`).join("")}</ul>`:`<div class="empty">No invoices.</div>`}</section>`;
  return h+`</div>`;
}

/* ---------- projects ---------- */
function projProgress(p){ const ts=S.data.tasks.filter(t=>t.project_id===p.id); const done=ts.filter(t=>t.status==="Done").length; return {n:ts.length,done,pct:ts.length?Math.round(done/ts.length*100):0}; }
function viewProjects(){
  const rows=S.data.projects.filter(p=>matches(p,S.q.projects)).sort((a,b)=>PROJECT_STATUS.indexOf(a.status)-PROJECT_STATUS.indexOf(b.status)||(a.due_date||"9").localeCompare(b.due_date||"9"));
  let h=head("Projects","Delivery work for your clients, with budgets, deadlines and task progress.",`${searchBox("projects")}<button class="btn" data-act="csv-projects">Export CSV</button>${addBtn("New project","new-project")}`);
  if(!S.data.projects.length) return h+`<div class="panel">${emptyState("No projects yet","Create a project for a client, then break it into tasks for your team.","Create a project","new-project")}</div>`;
  const t=todayISO();
  h+=`<div class="panel table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th>Lead</th><th>Due</th><th>Progress</th><th class="r">Budget</th></tr></thead><tbody>${rows.map(p=>{const pr=projProgress(p);const late=p.due_date&&p.due_date<t&&!["Completed","Cancelled"].includes(p.status);
    return `<tr data-go-detail="project:${p.id}"><td><div class="cell-main">${esc(p.name)}</div><div class="cell-sub">${esc(clientName(p.client_id)||"Internal")}</div></td><td>${pill(p.status||"Planning")}</td><td>${esc(p.owner_id?userName(p.owner_id):"—")}</td><td style="${late?"color:var(--bad)":""}">${fmtDate(p.due_date)}</td><td><div style="display:flex;gap:8px;align-items:center"><div class="progress" style="flex:1"><i style="width:${pr.pct}%"></i></div><span class="cell-sub num">${pr.done}/${pr.n}</span></div></td><td class="r num">${p.budget?money(p.budget):"—"}</td></tr>`;}).join("")}</tbody></table></div>`;
  return h;
}
function viewProject(){
  const p=byId("projects",S.param);
  if(!p) return head("Project not found","")+`<button class="btn" data-go="projects">Back to projects</button>`;
  const tasks=S.data.tasks.filter(t=>t.project_id===p.id), pr=projProgress(p);
  const spent=S.data.expenses.filter(e=>e.project_id===p.id).reduce((a,e)=>a+num(e.amount),0);
  const billed=S.data.invoices.filter(i=>i.project_id===p.id&&!["Draft","Void"].includes(i.status)).reduce((s,i)=>s+totals(i).total,0);
  let h=head(p.name,`<a class="btn ghost sm" href="/projects" data-go="projects">← All projects</a>`,`<button class="btn" data-open="projects:${p.id}">Edit</button><button class="btn" data-act="new-invoices" data-client="${p.client_id||""}" data-project="${p.id}">Invoice this project</button><button class="btn" data-act="new-expense">Add expense</button><button class="btn primary" data-act="new-task" data-project="${p.id}">Add task</button>`);
  const cells=[["Client",p.client_id?`<a href="/clients/${p.client_id}" data-go-detail="client:${p.client_id}">${esc(clientName(p.client_id))}</a>`:"Internal"],["Status",pill(p.status||"Planning")],["Project lead",esc(p.owner_id?userName(p.owner_id):"—")],["Start",fmtDate(p.start_date)],["Due",fmtDate(p.due_date)],["Budget",`<span class="num">${p.budget?money(p.budget):"—"}</span>`],["Expenses",`<span class="num" style="${p.budget&&spent>p.budget?"color:var(--bad)":""}">${money(spent)}</span>${p.budget?` <span class="cell-sub">of ${money(p.budget)} budget</span>`:""}`],["Invoiced",`<span class="num">${money(billed)}</span>`],["Progress",`${pr.pct}% <span class="cell-sub">(${pr.done} of ${pr.n} tasks)</span>`]];
  h+=`<div class="panel" style="margin-bottom:16px"><dl class="detail-grid">${cells.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>${p.description?`<div style="padding:0 16px 16px;white-space:pre-wrap;color:var(--muted)">${esc(p.description)}</div>`:""}</div>`;
  h+=`<div class="grid2" style="margin-bottom:16px">${projectMoneyPanel(p)}<section class="panel linked-panel">${linkedDocsHtml("projects",p.id)}</section></div>`;
  return h+(tasks.length?taskBoard(tasks):`<div class="panel">${emptyState("No tasks in this project","Break the work into tasks and assign them to people on your team.","Add a task","new-task")}</div>`);
}

/* ---------- tasks ---------- */
function taskBoard(tasks){
  const t=todayISO();
  if(S.mode.tasks==="table"&&S.view==="tasks"){
    return `<div class="panel table-wrap"><table><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Due</th></tr></thead><tbody>${[...tasks].sort((a,b)=>(a.due_date||"9").localeCompare(b.due_date||"9")).map(x=>`<tr data-open="tasks:${x.id}"><td><div class="cell-main">${esc(x.title)}</div><div class="cell-sub">${esc(projectName(x.project_id)||"No project")}</div></td><td>${pill(x.status||"To do")}</td><td>${pill(x.priority||"Medium")}</td><td>${esc(x.assignee_id?userName(x.assignee_id):"Unassigned")}</td><td style="${x.due_date&&x.due_date<t&&x.status!=="Done"?"color:var(--bad)":""}">${fmtDate(x.due_date)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  return `<div class="board">${TASK_STATUS.map(st=>{const items=tasks.filter(x=>(x.status||"To do")===st).sort((a,b)=>(a.due_date||"9").localeCompare(b.due_date||"9"));
    return `<div class="col" data-drop="tasks:status:${st}"><div class="col-head"><span>${st} <span class="num">${items.length}</span></span></div>${items.map(x=>`<div class="card prio-${(x.priority||"Medium").toLowerCase()}" draggable="true" data-drag="${x.id}" data-open="tasks:${x.id}"><span class="t">${esc(x.title)}</span>${S.view!=="project"?`<span class="cell-sub">${esc(projectName(x.project_id)||"No project")}</span>`:""}<span class="s"><span>${esc(x.assignee_id?userName(x.assignee_id):"Unassigned")}</span><span style="${x.due_date&&x.due_date<t&&st!=="Done"?"color:var(--bad)":""}">${x.due_date?fmtDate(x.due_date):""}</span></span></div>`).join("")}</div>`;}).join("")}</div>`;
}
function viewTasks(){
  let rows=S.data.tasks.filter(x=>matches(x,S.q.tasks));
  if(S.taskFilter==="mine") rows=rows.filter(x=>x.assignee_id===S.me.id);
  if(S.taskFilter==="open") rows=rows.filter(x=>x.status!=="Done");
  const mode=S.mode.tasks;
  let h=head("Tasks","Everything your team is working on, across all projects.",
    `${searchBox("tasks")}<select class="input inline" id="task-filter" aria-label="Filter tasks"><option value="all" ${S.taskFilter==="all"?"selected":""}>All tasks</option><option value="open" ${S.taskFilter==="open"?"selected":""}>Open tasks</option><option value="mine" ${S.taskFilter==="mine"?"selected":""}>Assigned to me</option></select><div class="seg" role="group" aria-label="View"><button data-mode="tasks:board" aria-pressed="${mode==="board"}">Board</button><button data-mode="tasks:table" aria-pressed="${mode==="table"}">Table</button></div>${addBtn("New task","new-task")}`);
  if(!S.data.tasks.length) return h+`<div class="panel">${emptyState("No tasks yet","Create tasks, assign them to teammates and track them to done.","Add a task","new-task")}</div>`;
  return h+taskBoard(rows);
}

/* ---------- quotations & invoices ---------- */
function viewDocs(col){
  const isQ=col==="quotes";
  const rows=S.data[col].filter(d=>matches({...d,_c:clientName(d.client_id)},S.q[col])).sort((a,b)=>(b.number||"").localeCompare(a.number||""));
  const st=isQ?quoteStatus:invoiceStatus;
  let h=head(isQ?"Quotations":"Invoices",isQ?"Price your work, send it, and turn accepted quotations into invoices.":"Bill clients, record payments and see what is still owed.",
    `${searchBox(col)}<button class="btn" data-act="csv-${col}">Export CSV</button>${addBtn(isQ?"New quotation":"New invoice","new-"+col)}`);
  if(!S.data[col].length) return h+`<div class="panel">${emptyState(isQ?"No quotations yet":"No invoices yet",isQ?"Create a quotation with line items, tax and discount, then send it to your client.":"Create an invoice from scratch or convert an accepted quotation.",isQ?"Create a quotation":"Create an invoice","new-"+col)}</div>`;
  if(!isQ){
    const all=S.data.invoices.map(i=>({s:invoiceStatus(i),t:totals(i)}));
    const sum=f=>all.filter(f).reduce((a,x)=>a+x.t.balance,0);
    h+=`<div class="kpis"><div class="panel kpi"><div class="label">Awaiting payment</div><div class="value">${money(sum(x=>["Sent","Partially paid"].includes(x.s)))}</div></div><div class="panel kpi"><div class="label">Overdue</div><div class="value" style="color:var(--bad)">${money(sum(x=>x.s==="Overdue"))}</div></div><div class="panel kpi"><div class="label">Collected (all time)</div><div class="value">${money(all.reduce((a,x)=>a+x.t.paid,0))}</div></div></div>`;
  }
  h+=`<div class="panel table-wrap"><table><thead><tr><th>Number</th><th>Client</th><th>Ref</th><th>Date</th><th>${isQ?"Valid until":"Due"}</th><th>Status</th><th class="r">Total</th>${isQ?"":`<th class="r">Balance</th>`}</tr></thead><tbody>${rows.map(d=>{const t=totals(d);return `<tr data-open="${col}:${d.id}"><td class="mono cell-main">${esc(d.number)}</td><td><div>${esc(clientName(d.client_id)||"—")}</div>${d.title?`<div class="cell-sub">${esc(d.title)}</div>`:""}</td><td>${esc(d.ref||"—")}</td><td>${fmtDate(d.date)}</td><td>${fmtDate(isQ?d.valid_until:d.due_date)}</td><td>${pill(st(d))}</td><td class="r num">${money(t.total)}</td>${isQ?"":`<td class="r num">${money(t.balance)}</td>`}</tr>`;}).join("")}</tbody></table></div>`;
  return h;
}

/* ---------- expenses ---------- */
const monthKey = iso => (iso||"").slice(0,7);
const monthLabel = key => { const [y,m]=key.split("-").map(Number); return new Date(y,m-1,1).toLocaleDateString(undefined,{month:"long",year:"numeric"}); };
function viewExpenses(){
  const all=S.data.expenses, thisMonth=monthKey(todayISO());
  const month=S.expMonth??thisMonth;
  const months=[...new Set([thisMonth,...all.map(e=>monthKey(e.date)).filter(Boolean)])].sort().reverse();
  const cats=[...new Set([...(S.settings.expenseCategories||[]),...all.map(e=>e.category).filter(Boolean)])];
  let rows=all.filter(e=>(month==="all"||monthKey(e.date)===month)&&(!S.expCategory||e.category===S.expCategory)&&matches({...e,_by:userName(e.paid_by),_p:projectName(e.project_id)},S.q.expenses))
    .sort((a,b)=>(b.date||"").localeCompare(a.date||"")||b.id-a.id);
  const total=rows.reduce((a,e)=>a+num(e.amount),0);
  let h=head("Expenses","Record what the company spends, and see where the money goes each month.",
    `${searchBox("expenses")}<select class="input inline" id="exp-month" aria-label="Month"><option value="all" ${month==="all"?"selected":""}>All months</option>${months.map(m=>`<option value="${m}" ${m===month?"selected":""}>${monthLabel(m)}</option>`).join("")}</select>
    <select class="input inline" id="exp-cat" aria-label="Category"><option value="">All categories</option>${cats.map(c=>`<option ${c===S.expCategory?"selected":""}>${esc(c)}</option>`).join("")}</select>
    <button class="btn" data-act="csv-expenses">Export CSV</button>${addBtn("Add expense","new-expense")}`);
  if(!all.length) return h+`<div class="panel">${emptyState("No expenses yet","Add rent, salaries, travel, software and anything else the company pays for.","Add your first expense","new-expense")}</div>`;
  // compare with the previous month when a single month is selected
  let compare="";
  if(month!=="all"){
    const [y,m]=month.split("-").map(Number), prev=new Date(y,m-2,1), pk=`${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,"0")}`;
    const prevTotal=all.filter(e=>monthKey(e.date)===pk&&(!S.expCategory||e.category===S.expCategory)).reduce((a,e)=>a+num(e.amount),0);
    compare=prevTotal?`${total>=prevTotal?"▲":"▼"} ${money(Math.abs(total-prevTotal))} vs ${monthLabel(pk)}`:`Nothing recorded in ${monthLabel(pk)}`;
  }
  const byCat=Object.entries(rows.reduce((o,e)=>{ const k=e.category||"Uncategorised"; o[k]=(o[k]||0)+num(e.amount); return o; },{})).sort((a,b)=>b[1]-a[1]);
  const maxC=Math.max(1,...byCat.map(x=>x[1]));
  h+=`<div class="kpis">
    <div class="panel kpi"><div class="label">${month==="all"?"Total spent":"Spent in "+monthLabel(month)}</div><div class="value">${money(total)}</div><div class="sub">${compare||`${rows.length} expenses`}</div></div>
    <div class="panel kpi"><div class="label">Expenses</div><div class="value">${rows.length}</div><div class="sub">${S.expCategory?esc(S.expCategory):"All categories"}</div></div>
    <div class="panel kpi"><div class="label">Largest category</div><div class="value" style="font-size:20px">${byCat[0]?esc(byCat[0][0]):"—"}</div><div class="sub">${byCat[0]?money(byCat[0][1]):"Nothing in this period"}</div></div>
  </div>`;
  if(!rows.length) return h+`<div class="panel">${emptyState("Nothing in this period","Try another month or category, or add an expense.","Add expense","new-expense")}</div>`;
  h+=`<div class="grid2" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr);align-items:start">
  <div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Paid by</th><th>Method</th><th class="r">Amount</th></tr></thead><tbody>${rows.map(e=>`<tr data-open="expenses:${e.id}"><td style="white-space:nowrap">${fmtDate(e.date)}</td><td><div class="cell-main">${esc(e.description)}</div><div class="cell-sub">${esc([e.vendor,projectName(e.project_id)].filter(Boolean).join(" · "))}</div></td><td>${e.category?`<span class="tag">${esc(e.category)}</span>`:"—"}</td><td>${esc(e.paid_by?userName(e.paid_by):"—")}${e.paid_from==="personal"?' <span class="tag" title="Paid from their own pocket; the company pays them back">own pocket</span>':""}</td><td>${esc(e.payment_method||"—")}</td><td class="r num">${money(e.amount)}</td></tr>`).join("")}
  <tr><td colspan="5" class="cell-main">Total</td><td class="r num cell-main">${money(total)}</td></tr></tbody></table></div>
  <section class="panel"><h2>By category</h2><div style="padding:14px 18px;display:grid;gap:12px">${byCat.map(([c,v])=>`<div style="display:grid;gap:4px;font-size:13px"><div style="display:flex;justify-content:space-between;gap:8px"><span>${esc(c)}</span><span class="num">${money(v)} <span class="cell-sub">${Math.round(v/total*100)}%</span></span></div><div class="progress"><i style="width:${(v/maxC*100).toFixed(1)}%"></i></div></div>`).join("")}</div></section>
  </div>`;
  return h;
}

/* ---------- settings ---------- */
function viewSettings(){
  const tabs=[["company","Company"],["branding","Branding"],["lists","Lists"],["team",isSuper()?"Accounts":"Team"],["account","My account"]];
  if(isAdmin()) tabs.splice(3,0,["documents","Documents"],["money","Money"]);
  const tab=S.settingsTab;
  let h=head("Settings",isSuper()?`Settings for ${esc(S.tenant?.name||"this company")}, plus every company and user account.`:isAdmin()?"Company details, branding and lists. Accounts are created by the super admin.":"Your account. Company settings can be changed by an administrator.");
  h+=`<div class="tabs" role="tablist">${tabs.map(([k,l])=>`<button role="tab" data-stab="${k}" aria-selected="${tab===k}">${l}</button>`).join("")}</div>`;
  const s=S.settings, dis=isAdmin()?"":"disabled";
  const f=(id,label,val,type="text",ph="")=>`<div class="field"><label for="s-${id}">${label}</label><input class="input" id="s-${id}" type="${type}" value="${esc(val??"")}" placeholder="${esc(ph)}" ${dis}></div>`;
  const ta=(id,label,val,ph="")=>`<div class="field full"><label for="s-${id}">${label}</label><textarea class="input" id="s-${id}" placeholder="${esc(ph)}" ${dis}>${esc(val||"")}</textarea></div>`;
  const saveBtn=isAdmin()?`<div style="margin-top:16px"><button class="btn primary" type="submit">Save settings</button></div>`:"";
  if(tab==="company") h+=`<form class="panel" data-settings-form style="padding:18px;max-width:780px"><div class="form">
    ${f("companyName","Company name",s.companyName)}${f("website","Website",s.website,"url","https://")}
    ${f("email","Billing email",s.email,"email")}${f("phone","Phone",s.phone,"tel")}
    ${f("taxId","GSTIN / Tax registration no.",s.taxId)}${f("currency","Currency code",s.currency,"text","USD, LKR, INR, EUR, GBP…")}
    ${ta("address","Address",s.address)}
    ${f("taxRate","Default tax rate (%)",s.taxRate,"number")}${f("paymentDays","Payment terms (days)",s.paymentDays,"number")}
    ${f("quotePrefix","Quotation number prefix",s.quotePrefix)}${f("invoicePrefix","Invoice number prefix",s.invoicePrefix)}${f("receiptPrefix","Receipt number prefix",s.receiptPrefix||"RCPT-")}
    ${f("quoteDays","Quotation valid for (days)",s.quoteDays,"number")}
    ${ta("bank","Payment details shown on invoices",s.bank,"Bank name, account number, branch, SWIFT…")}
    ${ta("terms","Default terms & notes",s.terms)}</div>${saveBtn}</form>`;
  if(tab==="branding") h+=`<form class="panel" data-settings-form style="padding:18px;max-width:780px"><div class="form">
    <div class="field full"><label for="s-logo-file">Logo</label>${s.logo?`<img src="${esc(s.logo)}" alt="Current logo" style="max-height:64px;max-width:240px;margin-bottom:6px;background:#fff;padding:4px;border-radius:4px">`:""}
      <input class="input" id="s-logo-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" ${dis}><span class="hint">Shown in the sidebar, on the sign-in page and on quotations and invoices. PNG, JPG, WebP or SVG under 1 MB.</span>
      ${s.logo&&isAdmin()?`<button type="button" class="btn sm" data-act="remove-logo" style="align-self:flex-start;margin-top:4px">Remove logo</button>`:""}</div>
    <div class="field"><label for="s-brandColor">Brand colour</label><div style="display:flex;gap:8px"><input type="color" id="s-brandColor-pick" value="${esc(s.brandColor||"#1d6b57")}" ${dis} aria-label="Pick brand colour" style="width:44px;height:36px;border:1px solid var(--line);border-radius:6px;background:none"><input class="input mono" id="s-brandColor" value="${esc(s.brandColor||"")}" placeholder="#1d6b57" ${dis}></div><span class="hint">Used for buttons, highlights and document headings. Leave empty for the default green.</span></div>
    </div>${saveBtn}</form>`;
  if(tab==="lists") h+=`<form class="panel" data-settings-form style="padding:18px;max-width:780px"><div class="form">
    <div class="field"><label for="s-regions">Regions</label><textarea class="input" id="s-regions" style="min-height:180px" ${dis}>${esc((s.regions||[]).join("\n"))}</textarea><span class="hint">One per line. Offered when adding leads, clients and projects.</span></div>
    <div class="field"><label for="s-leadSources">Lead sources</label><textarea class="input" id="s-leadSources" style="min-height:180px" ${dis}>${esc((s.leadSources||[]).join("\n"))}</textarea><span class="hint">One per line.</span></div>
    <div class="field"><label for="s-expenseCategories">Expense categories</label><textarea class="input" id="s-expenseCategories" style="min-height:180px" ${dis}>${esc((s.expenseCategories||[]).join("\n"))}</textarea><span class="hint">One per line. Offered when adding expenses.</span></div>
    </div>${saveBtn}</form>`;
  if(tab==="documents"&&isAdmin()) h+=layoutEditor();
  if(tab==="money"&&isAdmin()) h+=moneySettingsHtml();
  if(tab==="team") h+=isSuper()?accountsAdmin():teamList();
  if(tab==="account") h+=`<form class="panel" id="account-form" style="padding:18px;max-width:560px"><div class="form">
    <div class="field full"><label for="m-name">Your name</label><input class="input" id="m-name" value="${esc(S.me.name)}"></div>
    <div class="field full"><label>Email</label><div>${esc(S.me.email)}</div></div>
    <div class="field"><label for="m-cur">Current password</label><input class="input" id="m-cur" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="m-new">New password</label><input class="input" id="m-new" type="password" autocomplete="new-password" minlength="8"></div>
    </div><span class="hint">Leave the password fields empty to keep your password.</span><div style="margin-top:14px"><button class="btn primary" type="submit">Save</button></div></form>`;
  return h;
}

/* ---------- document layout editor ---------- */
const layoutDraft = () => (S.layoutDraft ??= savedLayout());
const layoutChanged = () => JSON.stringify(layoutDraft())!==JSON.stringify(savedLayout());
// Preview data: the latest real invoice/quotation, otherwise a clearly-labelled sample.
function previewDoc(kind){
  const col=kind==="quotation"?"quotes":"invoices";
  const real=S.data[col].find(x=>(x.items||[]).length);
  if(real) return {col,doc:real,sample:false};
  const t=todayISO();
  return {col,sample:true,doc:{number:(kind==="quotation"?S.settings.quotePrefix:S.settings.invoicePrefix)+"0001",date:t,due_date:addDays(t,14),valid_until:addDays(t,30),ref:"PO-4521",title:"Website redesign",
    tax_rate:num(S.settings.taxRate)||18,discount:0,notes:S.settings.terms||"Payment due within 14 days.",payments:[],
    items:[{desc:"Website design and development",hsn:"998314",qty:1,rate:45000},{desc:"Annual hosting and support",hsn:"998315",qty:1,rate:12000},{desc:"Content writing (per page)",hsn:"998399",qty:6,rate:1500}],
    _client:{company:"Sample Client Pvt Ltd",name:"Ravi Mehta",address:"12 Ring Road\nSurat, Gujarat 395002",tax_id:"24ABCDE1234F1Z5"}}};
}
// Preview for the editor: invoice, quotation, or a receipt (latest real one, otherwise a sample).
function previewReceipt(){
  for(const inv of S.data.invoices){ const pay=(inv.payments||[]).find(x=>x.receipt_no); if(pay) return {inv,pay,sample:false}; }
  const inv=previewDoc("invoice").doc, pay={receipt_no:(S.settings.receiptPrefix||"RCPT-")+"0001",date:todayISO(),amount:30000,method:"Bank transfer",ref:"UTR 4201 8890 1123",note:"Advance payment"};
  return {inv:{...inv,payments:[pay]},pay,sample:true};
}
function layoutPreviewHtml(layout,kind=S.layoutKind||"invoice"){
  if(kind==="receipt"){ const r=previewReceipt(); return receiptPaper(r.inv,r.pay,layout); }
  const p=previewDoc(kind); return docPaper(p.col,p.doc,layout);
}
function layoutEditor(){
  const L=layoutDraft(), T=DocTemplates.TEMPLATES, F=DocTemplates.FONTS, p=previewDoc(S.layoutKind||"invoice");
  const chk=(k,label)=>`<label><input type="checkbox" data-l="${k}" ${L[k]?"checked":""}> ${label}</label>`;
  const txt=(k,label,ph="")=>`<div class="field"><label for="L-${k}">${label}</label><input class="input" id="L-${k}" data-l="${k}" value="${esc(L[k])}" placeholder="${esc(ph)}"></div>`;
  return `<div class="layout-editor">
  <div class="panel le-controls">
    <div><h3 class="sub-head" style="margin-top:0">Layout</h3><div class="tpl-grid" id="tpl-grid">${T.map(t=>`<button type="button" class="tpl-card" data-tpl="${t.id}" aria-pressed="${L.template===t.id}"><div class="tpl-thumb">${layoutPreviewHtml({...L,template:t.id},"invoice")}</div><b>${t.name}</b><small>${t.blurb}</small></button>`).join("")}</div></div>
    <div><h3 class="sub-head" style="margin-top:0">Style</h3><div class="form">
      <div class="field"><label for="L-accent">Accent colour</label><div style="display:flex;gap:8px"><input type="color" id="L-accent-pick" data-l-pick="accent" value="${esc(L.accent||S.settings.brandColor||"#b8652c")}" aria-label="Pick accent colour" style="width:44px;height:38px;border:1px solid var(--line-strong);border-radius:8px;background:none;flex:none"><input class="input mono" id="L-accent" data-l="accent" value="${esc(L.accent)}" placeholder="Auto"></div></div>
      <div class="field"><label for="L-font">Font</label><select class="input" id="L-font" data-l="font">${Object.entries(F).map(([k,f])=>`<option value="${k}" ${L.font===k?"selected":""}>${f.label}</option>`).join("")}</select></div>
      <div class="field"><label for="L-paper">Paper size</label><select class="input" id="L-paper" data-l="paper">${["A4","Letter"].map(x=>`<option ${L.paper===x?"selected":""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label for="L-taxDisplay">Show tax as</label><select class="input" id="L-taxDisplay" data-l="taxDisplay">${[["single","One tax line"],["cgst_sgst","CGST + SGST (within state)"],["igst","IGST (other state)"]].map(([v,l])=>`<option value="${v}" ${L.taxDisplay===v?"selected":""}>${l}</option>`).join("")}</select></div>
    </div></div>
    <div><h3 class="sub-head" style="margin-top:0">Text</h3><div class="form">
      ${txt("invoiceTitle","Invoice title","Invoice")}${txt("quoteTitle","Quotation title","Quotation")}
      ${txt("signatureLabel","Signature label","Authorised Signatory")}${txt("footer","Footer","Thank you for your business.")}
      ${txt("receiptTitle","Receipt title","Payment Receipt")}
      <div class="field"><label for="L-receiptPaper">Receipt paper</label><select class="input" id="L-receiptPaper" data-l="receiptPaper">${[["A5","A5 (half A4)"],["A4","A4"]].map(([v,l])=>`<option value="${v}" ${L.receiptPaper===v?"selected":""}>${l}</option>`).join("")}</select></div>
    </div></div>
    <div><h3 class="sub-head" style="margin-top:0">Show on document</h3><div class="checks">
      ${chk("showLogo","Logo")}${chk("showSellerGstin","Our GSTIN")}${chk("showBuyerGstin","Client GSTIN")}${chk("showHsn","HSN/SAC column")}
      ${chk("showWords","Amount in words")}${chk("showBank","Bank details")}${chk("showNotes","Notes & terms")}${chk("showSignature","Signature block")}
    </div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button type="button" class="btn primary" data-act="save-layout">Save layout</button><button type="button" class="btn" data-act="reset-layout">Reset to default</button><span class="unsaved" id="le-unsaved" ${layoutChanged()?"":"hidden"}>Unsaved changes</span></div>
  </div>
  <div class="le-preview">
    <div class="le-preview-head"><div class="seg" role="group" aria-label="Preview document"><button type="button" data-lkind="invoice" aria-pressed="${(S.layoutKind||"invoice")==="invoice"}">Invoice</button><button type="button" data-lkind="quotation" aria-pressed="${S.layoutKind==="quotation"}">Quotation</button><button type="button" data-lkind="receipt" aria-pressed="${S.layoutKind==="receipt"}">Receipt</button></div>
      <span class="hint">${S.layoutKind==="receipt"?(previewReceipt().sample?"Sample receipt. Your latest real receipt will show here once you record a payment.":`Showing ${esc(previewReceipt().pay.receipt_no)}`):p.sample?"Sample data. Your latest real document will show here once you create one.":`Showing ${esc(p.doc.number)}`}</span></div>
    <div class="le-frame"><div class="le-paper ${L.paper==="Letter"?"letter":""}" id="le-paper">${layoutPreviewHtml(L)}</div></div>
  </div></div>`;
}
// Fit the 794px-wide (A4 at 96 dpi) paper into the preview column and the thumbnails.
function fitLayoutPreview(){
  const paper=$("#le-paper"); if(!paper) return;
  const doc=paper.firstElementChild, a5=doc.classList.contains("paper-a5"), W=a5?559:794, w=paper.parentElement.clientWidth-32, scale=Math.min(1,w/W);
  doc.style.transform=`scale(${scale})`;
  paper.style.width=W*scale+"px"; paper.style.height=Math.max(doc.offsetHeight,a5?794:paper.classList.contains("letter")?1056:1123)*scale+"px";
  document.querySelectorAll(".tpl-thumb").forEach(t=>t.style.setProperty("--thumb-scale",t.clientWidth/794));
}
function updateLayoutPreview(){
  const L=layoutDraft(), paper=$("#le-paper"); if(!paper) return;
  paper.innerHTML=layoutPreviewHtml(L); paper.classList.toggle("letter",L.paper==="Letter");
  document.querySelectorAll(".tpl-card").forEach(c=>{ c.setAttribute("aria-pressed",String(c.dataset.tpl===L.template)); c.querySelector(".tpl-thumb").innerHTML=layoutPreviewHtml({...L,template:c.dataset.tpl},"invoice"); });
  $("#le-unsaved").hidden=!layoutChanged();
  fitLayoutPreview();
}
addEventListener("resize",()=>fitLayoutPreview());

function teamList(){
  const people=S.users.filter(u=>u.tenant_id===S.tenant?.id);
  return `<p class="hint" style="margin:0 0 12px">New accounts are created by the super admin. Ask them to add a colleague or reset a password.</p>
  <div class="panel table-wrap" style="max-width:900px"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="r">Leads added</th></tr></thead><tbody>${people.map(u=>`<tr><td class="cell-main">${esc(u.name)}${u.id===S.me.id?' <span class="tag">You</span>':""}</td><td>${esc(u.email)}</td><td>${roleLabel(u.role)}</td><td>${u.active?'<span class="pill good">Active</span>':'<span class="pill bad">Disabled</span>'}</td><td class="r num">${S.data.leads.filter(l=>l.created_by===u.id).length}</td></tr>`).join("")}</tbody></table></div>`;
}
function accountsAdmin(){
  const tOpts=sel=>S.tenants.map(t=>`<option value="${t.id}" ${t.id===sel?"selected":""}>${esc(t.name)}</option>`).join("");
  return `<h3 class="sub-head" style="margin-top:0">Companies (tenants)</h3>
  <div class="panel table-wrap" style="max-width:1200px"><table><thead><tr><th>Company</th><th class="r">Tenant ID</th><th class="r">Users</th><th class="r">Leads</th><th>Status</th><th></th></tr></thead><tbody>${S.tenants.map(t=>`<tr><td class="cell-main">${esc(t.name)}${t.id===S.tenant?.id?' <span class="tag">Current</span>':""}</td><td class="r num">${t.id}</td><td class="r num">${t.users}</td><td class="r num">${t.leads}</td><td>${t.active?'<span class="pill good">Active</span>':'<span class="pill bad">Disabled</span>'}</td><td class="r">${t.id!==S.tenant?.id?`<button class="btn sm" data-tenant-open="${t.id}">Open</button> `:""}${t.id!==S.me.homeTenantId?`<button class="btn sm" data-tenant-active="${t.id}">${t.active?"Disable":"Enable"}</button>`:""}</td></tr>`).join("")}</tbody></table></div>
  <form class="panel" id="new-tenant-form" style="padding:18px;max-width:1200px;margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end"><div class="field" style="flex:1;min-width:220px"><label for="t-name">New company name</label><input class="input" id="t-name" required></div><button class="btn primary" type="submit">Add company</button></form>
  <h3 class="sub-head">User accounts</h3>
  <div class="panel table-wrap" style="max-width:1200px"><table><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Role</th><th>Status</th><th class="r">Leads added</th><th></th></tr></thead><tbody>${S.allUsers.map(u=>`<tr><td class="cell-main">${esc(u.name)}${u.id===S.me.id?' <span class="tag">You</span>':""}</td><td>${esc(u.email)}</td><td>${esc(u.tenant_name)} <span class="cell-sub num">#${u.tenant_id}</span></td><td>${roleLabel(u.role)}</td><td>${u.active?'<span class="pill good">Active</span>':'<span class="pill bad">Disabled</span>'}</td><td class="r num">${u.leads_added}</td><td class="r" style="white-space:nowrap">${u.role!=="superadmin"?`<button class="btn sm" data-user-role="${u.id}">${u.role==="admin"?"Make member":"Make admin"}</button> <button class="btn sm" data-user-active="${u.id}">${u.active?"Disable":"Enable"}</button> <button class="btn sm" data-user-reset="${u.id}">Reset password</button>${u.id!==S.me.id?` <button class="btn sm danger" data-user-delete="${u.id}">Delete</button>`:""}`:""}</td></tr>`).join("")}</tbody></table></div>
  <form class="panel" id="new-user-form" style="padding:18px;max-width:1200px;margin-top:12px"><h3 class="sub-head" style="margin-top:0">Create a user account</h3><div class="form">
    <div class="field"><label for="u-name">Name</label><input class="input" id="u-name" required></div>
    <div class="field"><label for="u-email">Email</label><input class="input" id="u-email" type="email" required></div>
    <div class="field"><label for="u-tenant">Company</label><select class="input" id="u-tenant">${tOpts(S.tenant?.id)}</select></div>
    <div class="field"><label for="u-role">Role</label><select class="input" id="u-role"><option value="member">Member: manages records</option><option value="admin">Administrator: also company settings</option></select></div>
    <div class="field full"><label for="u-pass">Temporary password</label><input class="input" id="u-pass" type="text" minlength="8" required><span class="hint">Share it with them; they can change it under My account.</span></div>
    </div><div style="margin-top:14px"><button class="btn primary" type="submit">Create account</button></div></form>`;
}

/* ---------- record forms ---------- */
const FORMS = {
  leads:{title:"lead",fields:[
    ["name","Contact name","text",{req:1}],["company","Company"],["email","Email","email"],["phone","Phone","tel"],
    ["region","Region","region"],["ref","Reference","text",{ph:"Referred by, or your reference no."}],
    ["stage","Stage","select",{opts:()=>LEAD_STAGES}],["source","Source","select",{opts:()=>["",...(S.settings.leadSources||[])]}],
    ["value","Estimated value","number"],["next_follow_up","Next follow-up","date"],
    ["owner_id","Owner","person"],["service","Interested in"],
    ["notes","Notes","textarea",{full:1}]]},
  clients:{title:"client",fields:[
    ["company","Company / organisation"],["name","Contact name","text",{req:1}],["email","Email","email"],["phone","Phone","tel"],
    ["region","Region","region"],["ref","Reference","text",{ph:"Account or customer no."}],
    ["address","Billing address","textarea",{full:1}],["tax_id","GSTIN / Tax no."],["website","Website"],["notes","Notes","textarea",{full:1}]]},
  projects:{title:"project",fields:[
    ["name","Project name","text",{req:1,full:1}],["client_id","Client","client"],["status","Status","select",{opts:()=>PROJECT_STATUS}],
    ["start_date","Start date","date"],["due_date","Due date","date"],["budget","Budget","number"],["owner_id","Project lead","person"],
    ["region","Region","region"],["description","Description","textarea",{full:1}]]},
  tasks:{title:"task",fields:[
    ["title","Task","text",{req:1,full:1}],["project_id","Project","project"],["status","Status","select",{opts:()=>TASK_STATUS}],
    ["priority","Priority","select",{opts:()=>PRIORITIES}],["due_date","Due date","date"],["assignee_id","Assignee","person"],
    ["description","Details","textarea",{full:1}]]},
  expenses:{title:"expense",fields:[
    ["description","What was it for?","text",{req:1,full:1,ph:"e.g. Office rent for October"}],
    ["amount","Amount","number",{req:1}],["date","Date","date",{req:1}],
    ["category","Category","select",{opts:()=>["",...(S.settings.expenseCategories||[])]}],["vendor","Paid to","text",{ph:"Vendor or person"}],
    ["payment_method","Payment method","select",{opts:()=>["",...PAY_METHODS]}],["paid_by","Paid by","person"],
    ["paid_from","Paid from","choice",{opts:()=>[["company","Company money"],["personal","Own pocket (company pays them back)"]]}],
    ["project_id","Project","project"],["notes","Notes","textarea",{full:1,ph:"Bill or reference number, anything useful later"}]]},
  settlements:{title:"settlement",fields:[
    ["from_party","Paid by","party",{req:1}],["to_party","Paid to","party",{req:1}],
    ["amount","Amount","number",{req:1}],["date","Date","date",{req:1}],
    ["method","Method","select",{opts:()=>["",...PAY_METHODS]}],["note","Note","text",{ph:"e.g. Partner share for October"}]]}
};
function options(list,v,blank){
  const all=[...list]; if(v&&!all.includes(v)) all.push(v);
  return (blank?`<option value="">${blank}</option>`:"")+all.map(x=>`<option value="${esc(x)}" ${x===v?"selected":""}>${esc(x||"—")}</option>`).join("");
}
function fieldHtml([key,label,type="text",o={}],rec){
  const v=rec[key]??"", id="f-"+key, cls=o.full?"field full":"field";
  const lab=`<label for="${id}">${esc(label)}${o.req?' <span class="req">*</span>':""}</label>`;
  const sel=inner=>`<div class="${cls}">${lab}<select class="input" id="${id}" name="${key}" data-type="${type}">${inner}</select></div>`;
  if(type==="select") return sel(options(o.opts(),v));
  if(type==="region") return `<div class="${cls}">${lab}<input class="input" id="${id}" name="${key}" data-type="${type}" list="${id}-list" value="${esc(v)}" placeholder="Pick or type a region" autocomplete="off"><datalist id="${id}-list">${(S.settings.regions||[]).map(r=>`<option value="${esc(r)}">`).join("")}</datalist></div>`;
  if(type==="client") return sel(`<option value="">— None —</option>`+[...S.data.clients].sort((a,b)=>(a.company||a.name).localeCompare(b.company||b.name)).map(c=>`<option value="${c.id}" ${c.id===v?"selected":""}>${esc(c.company||c.name)}</option>`).join(""));
  if(type==="project") return sel(`<option value="">— None —</option>`+S.data.projects.map(p=>`<option value="${p.id}" ${p.id===v?"selected":""}>${esc(p.name)}</option>`).join(""));
  if(type==="choice") return sel(o.opts().map(([val,label])=>`<option value="${esc(val)}" ${String(v||o.opts()[0][0])===val?"selected":""}>${esc(label)}</option>`).join(""));
  if(type==="party") return sel(`<option value="">Choose…</option><option value="company" ${v==="company"?"selected":""}>${esc(fundLabel())}</option>`+moneyPeople().map(u=>`<option value="${u.id}" ${String(v)===String(u.id)?"selected":""}>${esc(u.name)}${u.id===S.me.id?" (you)":""}</option>`).join(""));
  if(type==="person") return sel(`<option value="">Unassigned</option>`+S.users.filter(u=>u.active||u.id===v).map(u=>`<option value="${u.id}" ${u.id===v?"selected":""}>${esc(u.name)}${u.id===S.me.id?" (you)":""}</option>`).join(""));
  if(type==="textarea") return `<div class="${cls}">${lab}<textarea class="input" id="${id}" name="${key}">${esc(v)}</textarea></div>`;
  return `<div class="${cls}">${lab}<input class="input" id="${id}" name="${key}" type="${type}" value="${esc(v)}" placeholder="${esc(o.ph||"")}" ${type==="number"?'step="any"':""} ${o.req?"required":""}></div>`;
}
function openSheet(html,wide=false){
  clearTimeout(S.sheetHideT);
  $("#overlay").innerHTML=`<div class="scrim" data-close></div><aside class="sheet ${wide?"wide":""}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">${html}</aside>`;
  const first=$("#overlay .sheet-body input:not([type=hidden]),#overlay .sheet-body select,#overlay .sheet-body textarea");
  (first||$("#overlay .sheet [data-close]"))?.focus({preventScroll:true});
}
// Slide the panel out and give focus back to whatever opened it.
function hideSheet(){
  const ov=$("#overlay"); if(!ov) return;
  S.sheet=null;
  ov.querySelector(".sheet")?.classList.add("closing"); ov.querySelector(".scrim")?.classList.add("closing");
  clearTimeout(S.sheetHideT);
  S.sheetHideT=setTimeout(()=>{ if(!S.sheet) ov.innerHTML=""; },180);
  const o=S.sheetOpener; S.sheetOpener=null;
  if(o&&o.isConnected) o.focus({preventScroll:true});
}
// Has the open panel been edited since it opened (or was last saved)?
function sheetSnapshot(){
  if(!S.sheet) return "";
  if(S.sheet.doc) return JSON.stringify(docBody(S.sheet.doc));
  const f=$("#rec-form"); return f?JSON.stringify(readForm(f)):"";
}
const sheetIsDirty=()=>!!S.sheet&&S.sheet.snap!=null&&sheetSnapshot()!==S.sheet.snap;
const markSheetClean=()=>{ if(S.sheet) S.sheet.snap=sheetSnapshot(); };

function metaStrip(rec){
  if(!rec.id) return "";
  return `<div class="meta-strip"><span>Added by <b>${esc(userName(rec.created_by))}</b> · ${fmtDateTime(rec.created_at)}</span>${rec.updated_at&&rec.updated_at!==rec.created_at?`<span>Last updated by <b>${esc(userName(rec.updated_by))}</b> · ${fmtDateTime(rec.updated_at)}</span>`:""}</div>`;
}
async function loadHistory(col,id){
  const box=$("#history"); if(!box) return;
  try{ const rows=await api("GET",`/api/activity/${col}/${id}`);
    if(!$("#history")) return;
    box.removeAttribute("aria-busy");
    box.innerHTML=rows.length?`<ul class="history">${rows.map(a=>`<li>${esc(a.summary)}<br><span class="cell-sub">${esc(userName(a.user_id))} · ${fmtDateTime(a.at)}</span></li>`).join("")}</ul>`:`<p class="hint">No history yet.</p>`;
  }catch(e){ box.innerHTML=`<p class="hint">History could not be loaded.</p>`; }
}
// Draw a record's panel (called by the router). Returns false if the record doesn't exist.
function showRecord(col,id,preset={}){
  if(col==="quotes"||col==="invoices") return openDocEditor(col,id,preset);
  const F=FORMS[col]; if(!F) return false;
  if(id&&!byId(col,id)){ hideSheet(); toast("That record no longer exists."); return false; }
  const rec=id?{...byId(col,id)}:{...preset};
  if(!id){ if(col==="leads"){ rec.stage??="New"; rec.owner_id??=S.me.id; } if(col==="projects") rec.status??="Planning"; if(col==="expenses"){ rec.date??=todayISO(); rec.paid_by??=S.me.id; rec.paid_from??="company"; } if(col==="settlements"){ rec.date??=todayISO(); } if(col==="tasks"){ rec.status??="To do"; rec.priority??="Medium"; } }
  S.sheet={col,id:id?Number(id):null};
  const canDelete=id&&(isAdmin()||rec.created_by===S.me.id);
  let extra="";
  if(col==="leads"&&id) extra+=`<button type="button" class="btn" data-act="convert-lead">${rec.client_id&&byId("clients",rec.client_id)?"View client":"Convert to client"}</button>`;
  openSheet(`<form id="rec-form" style="display:contents" novalidate><div class="sheet-head"><h2 id="sheet-title">${id?esc(rec.name||rec.title||rec.description||(col==="settlements"?`Settlement · ${money(rec.amount)}`:"")):"New "+F.title}</h2><button type="button" class="btn ghost" data-close aria-label="Close">✕</button></div>
  <div class="sheet-body">${metaStrip(rec)}<div class="form">${F.fields.map(f=>fieldHtml(f,rec)).join("")}</div>${col==="projects"?splitEditorHtml(rec):""}${id&&col!=="settlements"?linkedDocsHtml(col,id):""}${id?`<h3 class="sub-head">History</h3><div id="history" aria-busy="true"><div class="skel-lines"><i></i><i></i><i></i></div></div>`:""}</div>
  <div class="sheet-foot"><div class="grp">${canDelete?`<button type="button" class="btn danger" data-act="delete-rec">Delete</button>`:""}${extra}</div><div class="grp"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${id?"Save changes":"Create "+F.title}</button></div></div></form>`);
  markSheetClean(); paintSplitTotal();
  if(id) loadHistory(col,id);
  return true;
}
function readForm(form){
  const out={};
  for(const el of form.querySelectorAll("[name]")){
    const t=el.dataset.type;
    out[el.name]=(t==="client"||t==="project"||t==="person")?(el.value?Number(el.value):null):el.type==="number"?(el.value===""?null:num(el.value)):el.value.trim();
  }
  if(form.querySelector("[data-split]")) out.split=readSplit(form);
  return out;
}

/* ---------- quotation / invoice editor ---------- */
function openDocEditor(col,id,preset={}){
  const isQ=col==="quotes", s=S.settings, t=todayISO();
  let d;
  if(id){ const ex=byId(col,id); if(!ex){ hideSheet(); toast("That record no longer exists."); return false; } d=JSON.parse(JSON.stringify(ex)); }
  else d={number:nextNumber(col,isQ?(s.quotePrefix||"QT-"):(s.invoicePrefix||"INV-")),date:t,status:"Draft",
    [isQ?"valid_until":"due_date"]:addDays(t,num(isQ?(s.quoteDays??30):(s.paymentDays??14))),tax_rate:num(s.taxRate),discount:0,
    items:[{desc:"",qty:1,rate:0}],notes:s.terms||"",payments:[],ref:"",...preset};
  if(!d.items?.length) d.items=[{desc:"",qty:1,rate:0}];
  d.payments=d.payments||[];
  S.sheet={col,id:id?Number(id):null,doc:d,tab:"edit"};
  drawDocEditor();
  markSheetClean();
  return true;
}
const MD_PROMPT=`Write the body of a business quotation as Markdown. My quotation software adds the header (company logo and details, quotation number, date, validity, client name and address), the total, signature and footer by itself, so do NOT write any of those.

About my business: [what you sell, in 1-2 lines]
Client and their need: [client name, what they asked for]
Scope, prices and timeline: [deliverables, price breakdown, phases or dates]
Terms to include: [payment terms, validity, warranty, GST/taxes, anything else]
Tone: professional, clear, plain English.

Rules for the output:
- Return only the Markdown inside one code block, with no explanation before or after.
- Start directly with the content, not a title or letterhead. Do not write a signature, "From/To" lines, the date or a company address.
- Use only this syntax: "## Heading" and "### Subheading", **bold**, *italic*, "- " bullets, "1. " numbered lists, "---" divider, and pipe tables with a header row (use a table for pricing or a payment schedule).
- Do not use HTML, images, links, code blocks or nested lists.
- If any detail is missing, ask me before writing, otherwise use [placeholders].`;
function drawReceiptView(){
  const d=S.sheet.doc, pay=currentPayment(); if(!pay) return false;
  if(!$("#overlay .sheet")) openSheet("",true);
  const sheet=$("#overlay .sheet"); sheet.classList.add("wide");
  sheet.innerHTML=`<div class="sheet-head"><h2 id="sheet-title">Receipt <span class="mono">${esc(pay.receipt_no)}</span> <span class="cell-sub">for ${esc(d.number)}</span></h2><button type="button" class="btn ghost" data-close aria-label="Close">✕</button></div>
  <div class="sheet-body"><div class="receipt-bar"><button type="button" class="btn sm" data-act="close-receipt">← Back to ${esc(d.number)}</button><label class="check-line"><input type="checkbox" id="r-show-balance" ${pay.show_balance?"checked":""}> Show invoice total and balance due</label></div>
    <div class="receipt-view">${receiptPaper(d,pay)}</div></div>
  <div class="sheet-foot"><div class="grp"><button type="button" class="btn" data-act="copy-receipt" title="A short note to send along with the receipt">Copy message</button><button type="button" class="btn" data-act="download-doc">Download</button></div><div class="grp"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-act="print-doc">Print / PDF</button></div></div>`;
  $("#overlay [data-act='close-receipt']")?.focus({preventScroll:true});
  return true;
}
function drawDocEditor(){
  if(S.sheet.receipt&&drawReceiptView()) return;
  const {col,doc:d,id,tab}=S.sheet, isQ=col==="quotes", isNew=!id;
  const status=isQ?quoteStatus(d):invoiceStatus(d), md=isQ&&d.doc_mode==="markdown";
  let body;
  if(tab==="preview") body=docPaper(col,d);
  else body=`${metaStrip(d)}<div class="form">
    ${isQ?`<div class="field full"><label for="d-mode">Quotation format</label><select class="input" id="d-mode" data-d="doc_mode"><option value="">Standard — line items and totals</option><option value="markdown" ${md?"selected":""}>Custom document — write the body in Markdown</option></select><span class="hint">${md?"Your Markdown becomes the body. Header, client details, totals, signature and footer are still added automatically.":"Pick Custom document to paste a full proposal written in Markdown."}</span></div>`:""}
    <div class="field"><label for="d-number">${isQ?"Quotation":"Invoice"} number</label><input class="input mono" id="d-number" data-d="number" value="${esc(d.number)}"></div>
    <div class="field"><label for="d-client">Client <span class="req">*</span></label><select class="input" id="d-client" data-d="client_id" data-num><option value="">— Select client —</option>${S.data.clients.map(c=>`<option value="${c.id}" ${c.id===d.client_id?"selected":""}>${esc(c.company||c.name)}</option>`).join("")}</select></div>
    <div class="field"><label for="d-date">Date</label><input class="input" type="date" id="d-date" data-d="date" value="${esc(d.date)}"></div>
    <div class="field"><label for="d-due">${isQ?"Valid until":"Due date"}</label><input class="input" type="date" id="d-due" data-d="${isQ?"valid_until":"due_date"}" value="${esc(isQ?d.valid_until:d.due_date)}"></div>
    <div class="field"><label for="d-title">Subject</label><input class="input" id="d-title" data-d="title" value="${esc(d.title||"")}" placeholder="e.g. Website redesign"></div>
    <div class="field"><label for="d-ref">Reference</label><input class="input" id="d-ref" data-d="ref" value="${esc(d.ref||"")}" placeholder="Client PO or reference no."></div>
    <div class="field"><label for="d-project">Project</label><select class="input" id="d-project" data-d="project_id" data-num><option value="">— None —</option>${S.data.projects.filter(p=>!d.client_id||!p.client_id||p.client_id===d.client_id).map(p=>`<option value="${p.id}" ${p.id===d.project_id?"selected":""}>${esc(p.name)}</option>`).join("")}</select></div>
    <div class="field"><label for="d-status">Status</label><select class="input" id="d-status" data-d="status">${(isQ?QUOTE_STATUS:INVOICE_STATUS).map(x=>`<option ${x===d.status?"selected":""}>${x}</option>`).join("")}</select><span class="hint">Shown as ${pill(status)}${isQ?"":" — paid and overdue are worked out from payments and the due date."}</span></div>
  </div>
  ${md?`<h3 class="sub-head">Document body (Markdown)</h3>
  <div class="field"><textarea class="input" id="d-body" data-d="body" style="min-height:300px;font-family:var(--font-num);font-size:13px" placeholder="## Scope of work&#10;- Item one&#10;- Item two&#10;&#10;## Pricing&#10;| Item | Amount |&#10;|---|---|&#10;| Design | 50,000 |">${esc(d.body||"")}</textarea><span class="hint">Use the Preview tab to see it with your header and footer.</span></div>
  <details class="md-help"><summary>Write it with Claude</summary><div class="md-body"><span>Copy this prompt into Claude, fill in the bracketed parts, then paste Claude's Markdown above.</span><pre id="md-prompt">${esc(MD_PROMPT)}</pre><div><button type="button" class="btn sm" data-act="copy-md-prompt">Copy prompt</button></div><span class="cell-sub">Supported: <code>## Heading</code> <code>**bold**</code> <code>*italic*</code> <code>- bullet</code> <code>1. numbered</code> <code>| table |</code> <code>---</code></span></div></details>
  <div class="form" style="margin-top:12px"><div class="field"><label for="it-rate-0">Quoted amount (optional)</label><input class="input num" id="it-rate-0" type="number" step="any" data-it="0:rate" value="${esc(d.items[0]?.rate??0)}"><span class="hint">Shown as the total under your document. Leave 0 if the Markdown already states prices.</span></div></div>`:`  <h3 class="sub-head">Line items</h3>
  <div class="table-wrap"><table class="items"><thead><tr><th>Description</th>${savedLayout().showHsn?"<th>HSN/SAC</th>":""}<th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th><th></th></tr></thead><tbody>
  ${d.items.map((it,i)=>`<tr><td><input class="input" id="it-desc-${i}" data-it="${i}:desc" value="${esc(it.desc)}" placeholder="Item or service" aria-label="Description"></td>${savedLayout().showHsn?`<td><input class="input hsn" id="it-hsn-${i}" data-it="${i}:hsn" value="${esc(it.hsn||"")}" placeholder="e.g. 998314" aria-label="HSN/SAC code"></td>`:""}<td><input class="input qty num" id="it-qty-${i}" type="number" step="any" data-it="${i}:qty" value="${esc(it.qty)}" aria-label="Quantity"></td><td><input class="input rate num" id="it-rate-${i}" type="number" step="any" data-it="${i}:rate" value="${esc(it.rate)}" aria-label="Rate"></td><td class="r num" data-amt="${i}">${money(num(it.qty)*num(it.rate))}</td><td>${d.items.length>1?`<button type="button" class="btn ghost sm" data-del-item="${i}" aria-label="Remove line">✕</button>`:""}</td></tr>`).join("")}
  </tbody></table></div>
  <button type="button" class="btn sm" data-add-item style="margin-top:8px">+ Add line</button>`}
  <div class="totals" id="d-totals">${totalsHtml(d)}</div>
  <div class="form" style="margin-top:16px">
    <div class="field"><label for="d-discount">Discount (amount)</label><input class="input num" id="d-discount" type="number" step="any" data-d="discount" value="${esc(d.discount)}"></div>
    <div class="field"><label for="d-tax">Tax rate (%)</label><input class="input num" id="d-tax" type="number" step="any" data-d="tax_rate" value="${esc(d.tax_rate)}"></div>
    <div class="field full"><label for="d-notes">Notes & terms</label><textarea class="input" id="d-notes" data-d="notes">${esc(d.notes||"")}</textarea></div>
  </div>
  ${!isQ&&!isNew?paymentsHtml(d):""}${isNew?"":linkedDocsHtml(col,id)}`;
  const actions=[];
  if(!isNew){
    if(isAdmin()||d.created_by===S.me.id) actions.push(`<button type="button" class="btn danger" data-act="delete-doc">Delete</button>`);
    if(isQ&&!(d.invoice_id&&byId("invoices",d.invoice_id))) actions.push(`<button type="button" class="btn" data-act="quote-to-invoice">Convert to invoice</button>`);
    if(isQ&&d.invoice_id&&byId("invoices",d.invoice_id)) actions.push(`<button type="button" class="btn" data-open="invoices:${d.invoice_id}">View invoice</button>`);
    actions.push(`<button type="button" class="btn" data-act="print-doc">Print / PDF</button><button type="button" class="btn" data-act="download-doc">Download</button>`);
  }
  const PAY=["p-date","p-amount","p-method","p-ref","p-note","p-received-by"], keep={};
  if(!S.sheet.payReset) for(const id of PAY){ const el=document.getElementById(id); if(el) keep[id]=el.value; }
  const keepShow=!S.sheet.payReset&&$("#p-show-balance")?.checked;
  S.sheet.payReset=false;
  if(!$("#overlay .sheet")) openSheet("",true);
  const sheet=$("#overlay .sheet"); sheet.classList.add("wide");
  sheet.innerHTML=`<div class="sheet-head"><h2 id="sheet-title"><span class="mono">${esc(d.number)}</span> ${isNew?`<span class="cell-sub">new ${isQ?"quotation":"invoice"}</span>`:pill(status)}</h2><div class="toolbar"><div class="seg"><button type="button" data-tab="edit" aria-pressed="${tab==="edit"}">Edit</button><button type="button" data-tab="preview" aria-pressed="${tab==="preview"}">Preview</button></div><button type="button" class="btn ghost" data-close aria-label="Close">✕</button></div></div>
  <div class="sheet-body">${body}</div>
  <div class="sheet-foot"><div class="grp">${actions.join("")}</div><div class="grp"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn primary" data-act="save-doc">${isNew?"Create":"Save changes"}</button></div></div>`;
  for(const [id,v] of Object.entries(keep)){ const el=document.getElementById(id); if(el) el.value=v; }
  if(keepShow&&$("#p-show-balance")) $("#p-show-balance").checked=true;
}
function totalsHtml(d){
  const t=totals(d);
  return `<span>Subtotal</span><span class="num">${money(t.sub)}</span>${t.disc?`<span>Discount</span><span class="num">−${money(t.disc)}</span>`:""}${num(d.tax_rate)?`<span>Tax (${num(d.tax_rate)}%)</span><span class="num">${money(t.tax)}</span>`:""}<span class="grand">Total</span><span class="grand num">${money(t.total)}</span>${(d.payments||[]).length?`<span>Paid</span><span class="num">−${money(t.paid)}</span><span class="grand">Balance due</span><span class="grand num">${money(t.balance)}</span>`:""}`;
}
function paymentsHtml(d){
  const t=totals(d);
  return `<h3 class="sub-head">Payments</h3>
  ${d.payments.length?`<div class="table-wrap"><table class="items"><thead><tr><th>Receipt</th><th>Date</th><th>Received by</th><th>Method</th><th>Reference</th><th>Recorded by</th><th class="r">Amount</th><th></th></tr></thead><tbody>${d.payments.map((p,i)=>`<tr><td class="pay-rcpt">${esc(p.receipt_no||"—")}</td><td>${fmtDate(p.date)}</td><td>${esc(partyName(partyKey(p.received_by)))}</td><td>${esc(p.method)}</td><td>${esc(p.ref||"")}</td><td>${esc(userName(p.by))}</td><td class="r num">${money(p.amount)}</td><td style="white-space:nowrap"><button type="button" class="btn sm" data-receipt="${i}">Receipt</button> <button type="button" class="btn ghost sm" data-del-pay="${i}" aria-label="Remove payment">✕</button></td></tr>`).join("")}</tbody></table></div>`:`<p class="hint">No payments recorded.</p>`}
  ${t.balance>0?`<div class="form" style="margin-top:10px;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))"><div class="field"><label for="p-date">Date</label><input class="input" type="date" id="p-date" value="${todayISO()}"></div><div class="field"><label for="p-amount">Amount</label><input class="input num" type="number" step="any" id="p-amount" value="${t.balance.toFixed(2)}"></div><div class="field"><label for="p-method">Method</label><select class="input" id="p-method">${PAY_METHODS.map(m=>`<option>${m}</option>`).join("")}</select></div><div class="field"><label for="p-received-by">Received by</label><select class="input" id="p-received-by"><option value="company">${esc(fundLabel())}</option>${moneyPeople().map(u=>`<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select></div><div class="field"><label for="p-ref">Reference</label><input class="input" id="p-ref" placeholder="UTR, cheque or transaction no."></div><div class="field" style="grid-column:1/-1"><label for="p-note">Note on receipt</label><input class="input" id="p-note" placeholder="Optional, e.g. advance payment, cheque from HDFC Bank"></div><label class="check-line" style="grid-column:1/-1"><input type="checkbox" id="p-show-balance"> Show invoice total and balance due on the receipt</label></div><button type="button" class="btn sm" data-act="add-payment" style="margin-top:8px">Record payment</button>`:""}`;
}
// The company's saved document layout (Settings → Documents), or the unsaved draft while editing it.
const savedLayout = () => ({...DocTemplates.LAYOUT_DEFAULTS,...(S.settings.docLayout||{})});
function docModel(col,d){
  const isQ=col==="quotes", s=S.settings, c=byId("clients",d.client_id)||d._client||{};
  const items=(d.items||[]).filter(i=>i.desc||num(i.rate)).map(i=>({desc:i.desc,hsn:i.hsn||"",qty:num(i.qty),rate:num(i.rate),amount:num(i.qty)*num(i.rate)}));
  return { kind:isQ?"quotation":"invoice", number:d.number||"", date:fmtDate(d.date), secondDate:fmtDate(isQ?d.valid_until:d.due_date),
    ref:d.ref||"", subject:d.title||"", notes:d.notes||"", bank:s.bank||"", currency:cur(), money, brandColor:s.brandColor||"",
    seller:{name:s.companyName||"Your company",logo:s.logo,address:s.address,email:s.email,phone:s.phone,website:s.website,gstin:s.taxId},
    buyer:{name:c.company||c.name||"—",contact:c.name,address:c.address,gstin:c.tax_id},
    items, totals:{...totals(d),taxRate:num(d.tax_rate)},
    ...(isQ&&d.doc_mode==="markdown"?{body:d.body||""}:{}) };
}
// Receipt for one payment on an invoice: what was paid, and where the invoice stands after it.
function receiptModel(inv,pay){
  const base=docModel("invoices",inv), t=totals(inv), list=inv.payments||[], i=list.indexOf(pay);
  const before=list.slice(0,Math.max(i,0)).reduce((a,x)=>a+num(x.amount),0);
  return { receiptNo:pay.receipt_no||"—", date:fmtDate(pay.date), amount:num(pay.amount), method:pay.method||"", ref:pay.ref||"", note:pay.note||"", showBalance:pay.show_balance===true,
    currency:base.currency, money, brandColor:base.brandColor, seller:base.seller, buyer:base.buyer,
    invoice:{number:inv.number||"", date:fmtDate(inv.date), total:t.total, before, balance:t.total-before-num(pay.amount)} };
}
const receiptPaper=(inv,pay,layout)=>DocTemplates.renderReceipt(receiptModel(inv,pay),layout||savedLayout());
const currentPayment=()=>(S.sheet?.doc?.payments||[]).find(p=>p.receipt_no===S.sheet.receipt);
// a short note to paste into WhatsApp or email along with the PDF
function receiptMessage(){
  const pay=currentPayment(), r=receiptModel(S.sheet.doc,pay);
  return `Dear ${r.buyer.name},\n\nWe have received ${money(r.amount)}${r.method?` by ${r.method}`:""}${r.ref?` (ref. ${r.ref})`:""} on ${r.date} against invoice ${r.invoice.number}. Receipt no. ${r.receiptNo}.\n`+
    (!r.showBalance?"Thank you!":r.invoice.balance<=0.004?`Invoice ${r.invoice.number} is now paid in full. Thank you!`:`Balance due on ${r.invoice.number}: ${money(r.invoice.balance)}.`)+`\n\n${r.seller.name}`;
}
function docPaper(col,d,layout){ return DocTemplates.render(docModel(col,d),layout||savedLayout()); }
function setPageSize(layout,kind){
  let st=document.getElementById("page-size"); if(!st){ st=document.createElement("style"); st.id="page-size"; document.head.appendChild(st); }
  st.textContent=kind==="receipt"?`@page{size:${layout.receiptPaper==="A4"?"A4":"A5"};margin:8mm}`:`@page{size:${layout.paper==="Letter"?"letter":"A4"};margin:10mm}`;
}
function syncDocTotals(){
  const d=S.sheet.doc;
  d.items.forEach((it,i)=>{ const c=$(`[data-amt="${i}"]`); if(c) c.textContent=money(num(it.qty)*num(it.rate)); });
  const tt=$("#d-totals"); if(tt) tt.innerHTML=totalsHtml(d);
}
function docBody(d){
  const items=d.items.filter(i=>i.desc||num(i.rate)).map(i=>({desc:i.desc,...(i.hsn?{hsn:String(i.hsn).trim()}:{}),qty:num(i.qty),rate:num(i.rate)}));
  const out={number:d.number,client_id:d.client_id||null,project_id:d.project_id||null,title:d.title||"",ref:d.ref||"",date:d.date,status:d.status,items,
    discount:num(d.discount),tax_rate:num(d.tax_rate),notes:d.notes||""};
  if(d.valid_until!==undefined) out.valid_until=d.valid_until;
  if(d.valid_until!==undefined){ out.doc_mode=d.doc_mode||""; out.body=d.doc_mode==="markdown"?(d.body||""):""; }
  if(d.due_date!==undefined) out.due_date=d.due_date;
  if(d.payments) out.payments=d.payments;
  if(d.invoice_id) out.invoice_id=d.invoice_id;
  if(d.from_quote) out.from_quote=d.from_quote;
  out.total=totals(out).total;
  return out;
}

/* ---------- CSV ---------- */
function exportCsv(col){
  const defs={
    leads:[["Name","name"],["Company","company"],["Email","email"],["Phone","phone"],["Region","region"],["Reference","ref"],["Stage","stage"],["Source","source"],["Value","value"],["Owner",r=>r.owner_id?userName(r.owner_id):""],["Added by",r=>userName(r.created_by)],["Added on","created_at"],["Next follow-up","next_follow_up"],["Notes","notes"]],
    clients:[["Company","company"],["Contact","name"],["Email","email"],["Phone","phone"],["Region","region"],["Reference","ref"],["Address","address"],["Tax no.","tax_id"],["Website","website"],["Added by",r=>userName(r.created_by)]],
    expenses:[["Date","date"],["Description","description"],["Category","category"],["Amount","amount"],["Paid to","vendor"],["Payment method","payment_method"],["Paid from",r=>r.paid_from==="personal"?"Own pocket":"Company money"],["Paid by",r=>r.paid_by?userName(r.paid_by):""],["Project",r=>projectName(r.project_id)],["Notes","notes"],["Added by",r=>userName(r.created_by)]],
    settlements:[["Date","date"],["From",r=>partyName(partyKey(r.from_party))],["To",r=>partyName(partyKey(r.to_party))],["Amount","amount"],["Method","method"],["Note","note"]],
    projects:[["Project","name"],["Client",r=>clientName(r.client_id)],["Status","status"],["Region","region"],["Start","start_date"],["Due","due_date"],["Budget","budget"]],
    quotes:[["Number","number"],["Client",r=>clientName(r.client_id)],["Reference","ref"],["Date","date"],["Valid until","valid_until"],["Status",quoteStatus],["Total",r=>totals(r).total.toFixed(2)]],
    invoices:[["Number","number"],["Client",r=>clientName(r.client_id)],["Reference","ref"],["Date","date"],["Due","due_date"],["Status",invoiceStatus],["Total",r=>totals(r).total.toFixed(2)],["Paid",r=>totals(r).paid.toFixed(2)],["Balance",r=>totals(r).balance.toFixed(2)]]
  }[col];
  const q=v=>{ const s=String(v??""); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const csv="﻿"+[defs.map(d=>d[0]).join(","),...S.data[col].map(r=>defs.map(([,k])=>q(typeof k==="function"?k(r):r[k])).join(","))].join("\r\n");
  saveFile(`${col}-${todayISO()}.csv`,csv,"text/csv;charset=utf-8");
}

/* ---------- events ---------- */
const CLICKABLE="[data-doc-task],[data-notif],[data-link-remove],[data-receipt],[data-open-receipt],[data-go],[data-go-detail],[data-open],[data-act],[data-close],[data-mode],[data-tab],[data-stab],[data-add-item],[data-del-item],[data-del-pay],[data-user-role],[data-user-active],[data-user-delete],[data-user-reset],[data-tenant-open],[data-tenant-active],[data-tpl],[data-lkind]";
// Where a clickable page/record element leads, so it can open in a new tab like a link.
function targetUrl(el){
  if(el.dataset.openReceipt){ const [id,no]=el.dataset.openReceipt.split("|"); return urlFor({...currentRoute(),record:{col:"invoices",id:Number(id)},receipt:no}); }
  if(el.dataset.go) return pageUrl(el.dataset.go);
  if(el.dataset.goDetail){ const [v,id]=el.dataset.goDetail.split(":"); return pageUrl(v,Number(id)); }
  if(el.dataset.open){ const [c,id]=el.dataset.open.split(":"); return urlFor({...currentRoute(),record:{col:c,id:Number(id)}}); }
  return null;
}
document.addEventListener("click",e=>{
  const el=e.target.closest(CLICKABLE); if(!el) return;
  const url=targetUrl(el);
  if(url&&(e.metaKey||e.ctrlKey||e.shiftKey)){ if(el.tagName!=="A"){ e.preventDefault(); window.open(url,"_blank","noopener"); } return; }
  if(el.tagName==="A") e.preventDefault();
  const p=handleClick(e,el);
  if(el.tagName==="BUTTON") busyWhile(el,p);
});
// middle-click on a row or card opens it in a new tab
document.addEventListener("auxclick",e=>{
  if(e.button!==1) return; const el=e.target.closest(CLICKABLE); if(!el||el.tagName==="A") return;
  const url=targetUrl(el); if(url){ e.preventDefault(); window.open(url,"_blank","noopener"); }
});
async function handleClick(e,el){
  if(el.dataset.notif){ const [nid,did]=el.dataset.notif.split("|").map(Number); $("#notif-pop")?.remove();
    api("POST","/api/notifications/read",{ids:[nid]}).then(refreshUnread).catch(()=>{}); return navigate({view:"doc",param:did}); }
  if(el.dataset.linkRemove!=null){ const P=S.docPage; if(!P) return; const links=(P.doc.links||[]).filter((_,i)=>i!==+el.dataset.linkRemove); return saveDocField({links}); }
  if(el.dataset.docTask){ const [did,tid]=el.dataset.docTask.split("|"); const d=byId("docs",did), t=d?.tasks.find(x=>x.tid===tid); if(!t) return;
    t.done=true; el.closest("li")?.classList.add("done-row");
    try{ const row=await api("PATCH",`/api/docs/${did}/tasks/${encodeURIComponent(tid)}`,{done:true}); upsertDocMeta(row); toast("Task done"); }catch(err){ t.done=false; toast(err.message); }
    return render(); }
  if(el.dataset.openReceipt){ const [id,no]=el.dataset.openReceipt.split("|"); S.sheetOpener=el;
    return navigate({...currentRoute(),record:{col:"invoices",id:Number(id)},receipt:no}); }
  if(el.dataset.receipt!=null){ let p=S.sheet.doc.payments[+el.dataset.receipt]; if(!p) return;
    if(!p.receipt_no){ // a payment recorded before receipts existed: get it a number first
      if(sheetIsDirty()){ toast("Save your changes first, then open the receipt."); return; }
      const rec=await update("invoices",S.sheet.id,{payments:S.sheet.doc.payments,_activity:`Issued receipts for ${S.sheet.doc.number}`}); if(!rec) return;
      S.sheet.doc=JSON.parse(JSON.stringify(rec)); markSheetClean(); p=rec.payments[+el.dataset.receipt]; }
    return navigate({...currentRoute(),receipt:p.receipt_no}); }
  if(el.dataset.tabTo) return navigate({view:"settings",tab:el.dataset.tabTo});
  if(el.dataset.go) return go(el.dataset.go);
  if(el.dataset.goDetail){ const [v,id]=el.dataset.goDetail.split(":"); return go(v,Number(id)); }
  if(el.dataset.open){ const [c,id]=el.dataset.open.split(":"); return openRecord(c,Number(id)); }
  if(el.hasAttribute("data-close")) return closeSheetNav();
  if(el.dataset.mode){ const [k,m]=el.dataset.mode.split(":"); S.mode[k]=m; try{localStorage.setItem("crm.mode",JSON.stringify(S.mode));}catch(_){} return render(); }
  if(el.dataset.stab) return navigate({view:"settings",tab:el.dataset.stab});
  if(el.dataset.tab){ S.sheet.tab=el.dataset.tab; return drawDocEditor(); }
  if(el.hasAttribute("data-add-item")){ S.sheet.doc.items.push({desc:"",qty:1,rate:0}); drawDocEditor(); $(`#it-desc-${S.sheet.doc.items.length-1}`)?.focus(); return; }
  if(el.dataset.delItem){ S.sheet.doc.items.splice(+el.dataset.delItem,1); return drawDocEditor(); }
  if(el.dataset.delPay){ const d=S.sheet.doc; d.payments.splice(+el.dataset.delPay,1);
    const rec=await update("invoices",S.sheet.id,{...docBody(d),_activity:`Removed a payment from ${d.number}`}); if(rec){ toast("Payment removed"); S.sheet.doc=JSON.parse(JSON.stringify(rec)); S.sheet.payReset=true; drawDocEditor(); markSheetClean(); } return; }
  if(el.dataset.tpl){ layoutDraft().template=el.dataset.tpl;
    // the GST format reads best with its usual Indian defaults switched on
    if(el.dataset.tpl==="gst"){ Object.assign(layoutDraft(),{showHsn:true,showWords:true,taxDisplay:layoutDraft().taxDisplay==="single"?"cgst_sgst":layoutDraft().taxDisplay}); return render(); }
    return updateLayoutPreview(); }
  if(el.dataset.lkind){ S.layoutKind=el.dataset.lkind; return render(); }
  if(el.dataset.tenantOpen) return switchTenant(+el.dataset.tenantOpen);
  if(el.dataset.tenantActive){ const t=S.tenants.find(x=>x.id===+el.dataset.tenantActive);
    if(t.active&&!await confirmBox(`Disable ${t.name}?`,"Everyone in this company is signed out and can't sign in until you enable it again. Their data is kept.","Disable")) return;
    try{ await api("PUT","/api/admin/tenants/"+t.id,{active:!t.active}); await loadAdmin(); render(); toast(t.active?"Company disabled":"Company enabled"); }catch(err){ toast(err.message); } return; }
  if(el.dataset.userRole){ const u=S.allUsers.find(x=>x.id===+el.dataset.userRole); try{ await api("PUT","/api/admin/users/"+u.id,{role:u.role==="admin"?"member":"admin"}); await loadAll(); toast("Role updated"); }catch(err){ toast(err.message); } return; }
  if(el.dataset.userActive){ const u=S.allUsers.find(x=>x.id===+el.dataset.userActive);
    if(u.active&&!await confirmBox(`Disable ${u.name}?`,"They will be signed out and cannot sign in until you enable them again. Their records stay in the CRM.","Disable")) return;
    try{ await api("PUT","/api/admin/users/"+u.id,{active:!u.active}); await loadAll(); toast(u.active?"Account disabled":"Account enabled"); }catch(err){ toast(err.message); } return; }
  if(el.dataset.userDelete){ const u=S.allUsers.find(x=>x.id===+el.dataset.userDelete);
    if(!await confirmBox(`Delete ${u.name}?`,"The account is removed for good and can't be undone. Leads and other records they added stay, and anything assigned to them becomes unassigned. To keep the account but block sign-in, use Disable instead.","Delete")) return;
    try{ await api("DELETE","/api/admin/users/"+u.id); await loadAll(); toast("Account deleted"); }catch(err){ toast(err.message); } return; }
  if(el.dataset.userReset){ const u=S.allUsers.find(x=>x.id===+el.dataset.userReset); const pw=Array.from(crypto.getRandomValues(new Uint8Array(9)),b=>"abcdefghjkmnpqrstuvwxyz23456789"[b%31]).join("");
    if(!await confirmBox(`Reset ${u.name}'s password?`,`Their new password will be: ${pw}  Write it down and share it with them before confirming.`,"Reset password")) return;
    try{ await api("PUT","/api/admin/users/"+u.id,{password:pw}); toast("Password reset"); }catch(err){ toast(err.message); } return; }
  const a=el.dataset.act;
  if(a==="save-layout"){ try{ S.settings=await api("PUT","/api/settings",{docLayout:layoutDraft()}); S.layoutDraft=null; render(); toast("Layout saved. New and existing documents use it."); }catch(err){ toast(err.message); } return; }
  if(a==="reset-layout"){ S.layoutDraft={...DocTemplates.LAYOUT_DEFAULTS}; return render(); }
  if(a==="menu"){ const r=$("#rail"); r.classList.toggle("open"); el.setAttribute("aria-expanded",r.classList.contains("open")); return; }
  if(a==="copy-md-prompt"){ try{ await navigator.clipboard.writeText(MD_PROMPT); toast("Prompt copied"); }catch(e){ const p=$("#md-prompt"); if(p){ const r=document.createRange(); r.selectNodeContents(p); const s=getSelection(); s.removeAllRanges(); s.addRange(r); } toast("Select the prompt and copy it"); } return; }
  if(a==="new-doc"){ const [type,id]=(el.dataset.link||"").split(":");
    if(S.sheet&&sheetIsDirty()&&!await confirmDiscard()) return;
    return createDoc(type&&id?[{type,id:Number(id)}]:[]); }
  if(a==="bell") return openBell(el);
  if(a==="notif-all"){ await api("POST","/api/notifications/read",{}); $("#notif-pop")?.remove(); return refreshUnread(); }
  if(a==="doc-vis"){ const P=S.docPage, v=el.dataset.v; if(!P||P.doc.visibility===v) return;
    if(v==="private"&&!await confirmBox("Lock this doc to yourself?","Everyone else in the company will lose access straight away, including anyone tagged or assigned in it.","Lock it")) return;
    const row=await saveDocField({visibility:v}); if(row) toast(v==="shared"?"Shared with everyone in the company":"Locked: only you can see it now"); return; }
  if(a==="doc-link-add") return pickLink(el);
  if(a==="doc-delete"){ const P=S.docPage; if(!P) return;
    if(!await confirmBox(`Delete “${P.doc.title||"Untitled"}”?`,P.doc.visibility==="shared"?"This removes it for everyone in the company and cannot be undone.":"This cannot be undone.")) return;
    try{ await api("DELETE","/api/docs/"+P.id); S.data.docs=S.data.docs.filter(d=>d.id!==P.id); P.status="saved"; leaveDocPage(); toast("Doc deleted"); return navigate({view:"docs"},{replace:true,force:true}); }catch(err){ return toast(err.message); } }
  if(a==="doc-print"){ await flushDoc(); document.body.classList.add("printing-doc"); setTimeout(()=>{ window.print(); document.body.classList.remove("printing-doc"); },50); return; }
  if(a==="doc-theirs"){ const P=S.docPage; P.editor.commands.setContent(P.theirs.content,{emitUpdate:false}); P.doc={...P.doc,...P.theirs}; P.version=P.theirs.version; $("#doc-title").value=P.theirs.title||""; P.status="saved"; $("#doc-conflict").innerHTML=""; paintDocChrome(); return toast("Loaded the latest version"); }
  if(a==="doc-mine"){ const P=S.docPage; $("#doc-conflict").innerHTML=""; P.status="dirty"; await saveDoc({force:true}); return toast("Your version is saved"); }
  if(a==="new-settlement") return openRecord("settlements",null,{});
  if(a==="settle") return openRecord("settlements",null,{from_party:el.dataset.from,to_party:el.dataset.to,amount:num(el.dataset.amt)});
  if(a==="role-add"){ const R=rolesDraft(); R.splice(R.length-1,0,{key:"share"+Date.now().toString(36),label:"New share",pct:0,user_id:null}); return render(); }
  if(a==="role-remove"){ rolesDraft().splice(+el.dataset.i,1); return render(); }
  if(a==="reset-roles"){ S.rolesDraft=JSON.parse(JSON.stringify(DEFAULT_ROLES)); return render(); }
  if(a==="save-roles"){ try{ S.settings=await api("PUT","/api/settings",{moneyRoles:rolesDraft(),moneyKeeper:$("#m-keeper").value?Number($("#m-keeper").value):null}); S.rolesDraft=null; render(); toast("Money split saved"); }catch(err){ toast(err.message); } return; }
  if(a==="refresh"){ try{ await loadAll(); toast("Up to date"); }catch(err){ toast(err.message); } return; }
  if(a==="logout"){ try{ await api("POST","/api/logout"); }catch(_){} location.reload(); return; }
  if(a==="new-lead") return openRecord("leads");
  if(a==="new-client") return openRecord("clients");
  if(a==="new-expense") return openRecord("expenses",null,S.view==="project"?{project_id:S.param}:{});
  if(a==="new-project") return openRecord("projects",null,el.dataset.client?{client_id:Number(el.dataset.client)}:{});
  if(a==="new-task") return openRecord("tasks",null,{project_id:Number(el.dataset.project)||(S.view==="project"?S.param:null)});
  if(a==="new-quotes"||a==="new-invoices"){ const col=a.slice(4); if(!S.data.clients.length){ toast("Add a client first."); return openRecord("clients"); }
    return openRecord(col,null,{client_id:Number(el.dataset.client)||null,project_id:Number(el.dataset.project)||null}); }
  if(a&&a.startsWith("csv-")) return exportCsv(a.slice(4));
  if(a==="remove-logo"){ try{ S.settings=await api("PUT","/api/settings",{logo:""}); applyBrand(S.settings); render(); toast("Logo removed"); }catch(err){ toast(err.message); } return; }
  if(a==="delete-rec"){ const {col,id}=S.sheet; if(await confirmBox(`Delete this ${FORMS[col].title}?`,"This removes it for everyone and cannot be undone.")){ if(await remove(col,id)){ closeSheetNav({force:true}); toast("Deleted"); } } return; }
  if(a==="convert-lead"){ const lead=byId("leads",S.sheet.id);
    if(lead.client_id&&byId("clients",lead.client_id)) return navigate({view:"client",param:lead.client_id});
    const c=await create("clients",{name:lead.name,company:lead.company||"",email:lead.email||"",phone:lead.phone||"",region:lead.region||"",ref:lead.ref||"",notes:lead.notes||"",from_lead:lead.id});
    if(c){ await update("leads",lead.id,{stage:"Won",client_id:c.id,_activity:`Converted ${lead.name} to a client`}); toast("Client created and lead marked as won"); navigate({view:"client",param:c.id},{force:true}); } return; }
  if(a==="save-doc"){ const {col,id,doc}=S.sheet;
    if(!doc.client_id){ toast("Choose a client."); $("#d-client")?.focus(); return; }
    if(!doc.number){ toast("Enter a document number."); return; }
    const rec=id?await update(col,id,docBody(doc)):await create(col,docBody(doc));
    if(rec){ toast(id?"Saved":"Created"); S.sheet.id=rec.id; S.sheet.doc=JSON.parse(JSON.stringify(rec)); if(!S.sheet.doc.items.length) S.sheet.doc.items=[{desc:"",qty:1,rate:0}]; drawDocEditor(); markSheetClean();
      if(!id) navigate(currentRoute(),{replace:true,force:true}); } return; }
  if(a==="delete-doc"){ const {col,id}=S.sheet; if(await confirmBox(`Delete ${S.sheet.doc.number}?`,"This removes it for everyone and cannot be undone.")){ if(await remove(col,id)){ closeSheetNav({force:true}); toast("Deleted"); } } return; }
  if(a==="add-payment"){ const amt=num($("#p-amount").value); if(amt<=0){ toast("Enter a payment amount."); return; }
    const d=S.sheet.doc; d.payments=[...d.payments,{date:$("#p-date").value||todayISO(),amount:amt,method:$("#p-method").value,ref:$("#p-ref").value.trim(),note:($("#p-note")?.value||"").trim(),show_balance:!!$("#p-show-balance")?.checked,received_by:$("#p-received-by")?.value||"company",by:S.me.id}];
    if(d.status==="Draft") d.status="Sent";
    const rec=await update("invoices",S.sheet.id,{...docBody(d),_activity:`Recorded payment of ${money(amt)} on ${d.number}`});
    if(rec){ S.sheet.doc=JSON.parse(JSON.stringify(rec)); S.sheet.payReset=true; drawDocEditor(); markSheetClean();
      const no=rec.payments[rec.payments.length-1]?.receipt_no; toast(no?`Payment recorded · receipt ${no} ready to print`:"Payment recorded");
      if(no) navigate({...currentRoute(),receipt:no}); } return; }
  if(a==="quote-to-invoice"){ const q=S.sheet.doc, s=S.settings;
    const inv={number:nextNumber("invoices",s.invoicePrefix||"INV-"),client_id:q.client_id,project_id:q.project_id,title:q.title,ref:q.ref,date:todayISO(),due_date:addDays(todayISO(),num(s.paymentDays??14)),status:"Draft",items:q.items,discount:q.discount,tax_rate:q.tax_rate,notes:q.notes,payments:[],from_quote:S.sheet.id};
    const rec=await create("invoices",docBody(inv));
    if(rec){ await update("quotes",S.sheet.id,{status:"Accepted",invoice_id:rec.id,_activity:`Converted ${q.number} to invoice ${rec.number}`}); toast(`Invoice ${rec.number} created`); navigate({...currentRoute(),record:{col:"invoices",id:rec.id}},{replace:true,force:true}); } return; }
  if(a==="close-receipt"){ if(history.state?.receiptPushed) history.back(); else navigate({...currentRoute(),receipt:null},{replace:true}); return; }
  if(a==="copy-receipt"){ const t=receiptMessage(); try{ await navigator.clipboard.writeText(t); toast("Message copied. Paste it into WhatsApp or email."); }catch(_){ toast(t); } return; }
  if(a==="print-doc"&&S.sheet.receipt){ setPageSize(savedLayout(),"receipt"); document.body.classList.add("printing"); setTimeout(()=>{ window.print(); document.body.classList.remove("printing"); },50); return; }
  if(a==="print-doc"){ setPageSize(savedLayout()); S.sheet.tab="preview"; drawDocEditor(); document.body.classList.add("printing"); setTimeout(()=>{ window.print(); document.body.classList.remove("printing"); },50); return; }
  if(a==="download-doc"&&S.sheet.receipt){ const pay=currentPayment(), L=savedLayout();
    const css=await fetch("/app.css").then(r=>r.text()).catch(()=>"");
    const page=`<!doctype html><html><head><meta charset="utf-8"><title>${esc(pay.receipt_no)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700;800&family=Source+Serif+4:wght@300;400;600;700&display=swap"><style>${css}\nbody{background:#fff;padding:24px}.doc{margin:auto;border:0}@page{size:${L.receiptPaper==="A4"?"A4":"A5"};margin:8mm}@media print{body{padding:0}}</style></head><body>${receiptPaper(S.sheet.doc,pay)}</body></html>`;
    return saveFile(`${pay.receipt_no}.html`,page,"text/html"); }
  if(a==="download-doc"){ const {col,doc}=S.sheet;
    const css=await fetch("/app.css").then(r=>r.text()).catch(()=>"");
    const page=`<!doctype html><html><head><meta charset="utf-8"><title>${esc(doc.number)}</title><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;600;700;800&family=Source+Serif+4:wght@300;400;600;700&display=swap"><style>${css}\nbody{background:#fff;padding:24px}.doc{max-width:794px;margin:auto;border:0}@page{size:${savedLayout().paper==="Letter"?"letter":"A4"};margin:10mm}@media print{body{padding:0}}</style></head><body>${docPaper(col,doc)}</body></html>`;
    return saveFile(`${doc.number}.html`,page,"text/html"); }
}

// While an action talks to the server, its button shows a spinner and can't be pressed twice.
function busyWhile(btn,p){
  if(!p||typeof p.then!=="function") return;
  let done=false; btn.disabled=true;
  const t=setTimeout(()=>{ if(!done&&S.inflight>0){ btn.classList.add("is-busy"); btn.setAttribute("aria-busy","true"); } },120);
  const end=()=>{ done=true; clearTimeout(t); btn.disabled=false; btn.classList.remove("is-busy"); btn.removeAttribute("aria-busy"); };
  p.then(end,end);
}

function rolesInput(el){
  const r=rolesDraft()[+el.dataset.role]; if(!r) return;
  if(el.dataset.rf==="pct") r.pct=el.value===""?0:num(el.value); else if(el.dataset.rf==="user_id") r.user_id=el.value?Number(el.value):null; else r.label=el.value;
  const R=rolesDraft(), total=r2(R.reduce((a,x)=>a+num(x.pct),0)), ok=Math.abs(total-100)<0.01;
  $("#roles-total").innerHTML=ok?`<span class="settled">Total ${total}%</span>`:`<span class="owes">Total ${total}%. Must be 100%.</span>`;
  const b=$('[data-act="save-roles"]'); if(b) b.disabled=!ok;
}
document.addEventListener("input",e=>{ if(e.target.dataset?.role!=null) rolesInput(e.target); if(e.target.dataset?.splitKey) paintSplitTotal(); });
document.addEventListener("change",e=>{ if(e.target.dataset?.role!=null) rolesInput(e.target); if(e.target.dataset?.splitKey) paintSplitTotal(); });
function trackDirty(el){
  if(el.dataset.role!=null||el.id==="m-keeper") return; // the roles editor keeps its own draft
  if(el.dataset.l||el.dataset.lPick) return; // layout editor keeps its own draft
  if(el.id&&el.type!=="file"&&el.dataset.search==null&&!["tenant-switch","lead-region","task-filter","exp-month","exp-cat","doc-filter","doc-title","ed-block"].includes(el.id)&&$("#main")?.contains(el)) S.dirty[el.id]=el.value;
}
function clearDirty(form){ for(const el of form.elements) delete S.dirty[el.id]; }
function layoutInput(el){
  const L=layoutDraft();
  if(el.dataset.lPick){ L[el.dataset.lPick]=el.value; const t=document.getElementById("L-"+el.dataset.lPick); if(t) t.value=el.value; }
  else if(el.type==="checkbox") L[el.dataset.l]=el.checked;
  else L[el.dataset.l]=el.value;
  if(el.dataset.l==="accent"&&!/^#[0-9a-f]{6}$/i.test(el.value)&&el.value!=="") return; // wait for a full hex value
  updateLayoutPreview();
}
document.addEventListener("input",e=>{
  const el=e.target;
  if(el.dataset.l||el.dataset.lPick) return layoutInput(el);
  trackDirty(el);
  if(el.id==="doc-title"&&S.docPage){ const P=S.docPage; fitTitle(); clearTimeout(P.titleT); P.status="dirty"; paintDocChrome();
    P.titleT=setTimeout(async()=>{ const row=await saveDocField({title:el.value}); if(row){ P.status=P.saving?"saving":"saved"; paintDocChrome(); document.title=`${row.title||"Untitled doc"} · ${S.settings.companyName||"Company"} CRM`; } },600); return; }
  if(el.dataset.search!=null){ S.q[el.dataset.search]=el.value; return render(); }
  if(el.dataset.d&&S.sheet?.doc){ S.sheet.doc[el.dataset.d]=el.hasAttribute("data-num")?(Number(el.value)||null):el.value; if(["discount","tax_rate"].includes(el.dataset.d)) syncDocTotals(); return; }
  if(el.dataset.it&&S.sheet?.doc){ const [i,k]=el.dataset.it.split(":"); S.sheet.doc.items[+i][k]=el.value; return syncDocTotals(); }
  if(el.id==="s-brandColor-pick"){ $("#s-brandColor").value=el.value; trackDirty($("#s-brandColor")); }
});
document.addEventListener("change",async e=>{
  const el=e.target;
  if(el.dataset.l||el.dataset.lPick) return layoutInput(el);
  trackDirty(el);
  if(el.id==="task-filter"){ S.taskFilter=el.value; return render(); }
  if(el.id==="lead-region"){ S.leadRegion=el.value; return render(); }
  if(el.id==="exp-month"){ S.expMonth=el.value; return render(); }
  if(el.id==="doc-filter"){ S.docFilter=el.value; return render(); }
  if(el.id==="exp-cat"){ S.expCategory=el.value; return render(); }
  if(el.id==="tenant-switch") return switchTenant(+el.value);
  if(el.id==="r-show-balance"&&S.sheet?.doc){
    const pay=currentPayment(); if(!pay) return;
    if(sheetIsDirty()){ el.checked=!el.checked; toast("Save your invoice changes first."); return; }
    const payments=S.sheet.doc.payments.map(p=>p===pay?{...p,show_balance:el.checked}:p);
    el.disabled=true;
    const rec=await update("invoices",S.sheet.id,{payments,_activity:`${el.checked?"Showed":"Hid"} balance on receipt ${pay.receipt_no}`});
    if(rec){ S.sheet.doc=JSON.parse(JSON.stringify(rec)); markSheetClean(); drawDocEditor(); toast(el.checked?"Balance due now shows on this receipt":"Balance due hidden on this receipt"); }
    else el.checked=!el.checked;
    el.disabled=false; return;
  }
  if(el.dataset.d==="doc_mode"&&S.sheet?.doc){ const d=S.sheet.doc;
    if(el.value==="markdown"){ d._items=d.items; d.items=[{desc:"Quoted amount",qty:1,rate:d._items.length>1||d._items[0]?.desc?totals({items:d._items}).sub:num(d._items[0]?.rate)}]; }
    else if(d._items){ d.items=d._items; delete d._items; }
    drawDocEditor(); }
  if(el.dataset.d==="client_id"&&S.sheet?.doc){ S.sheet.doc.client_id=Number(el.value)||null; drawDocEditor(); }
  if(el.id==="s-logo-file"&&el.files[0]){
    const f=el.files[0]; if(f.size>1_000_000){ toast("Use an image under 1 MB."); el.value=""; return; }
    const dataUrl=await new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); });
    try{ S.settings=await api("PUT","/api/settings",{logo:dataUrl}); applyBrand(S.settings); render(); toast("Logo updated"); }catch(err){ toast(err.message); }
  }
});
document.addEventListener("keydown",e=>{
  if(S.modal||!S.sheet) return;
  if(e.key==="Escape"){ e.preventDefault(); return closeSheetNav(); }
  const sh=$("#overlay .sheet"); if(sh) trapFocus(e,sh);
});

document.addEventListener("submit",e=>{
  e.preventDefault();
  const btn=e.submitter||e.target.querySelector('[type="submit"]');
  const p=handleSubmit(e); if(btn) busyWhile(btn,p);
});
async function handleSubmit(e){
  const form=e.target;
  if(form.id==="rec-form"){
    const {col,id}=S.sheet; const vals=readForm(form);
    const req=FORMS[col].fields.find(f=>f[3]?.req&&!vals[f[0]]); if(req){ toast(`${req[1]} is required.`); $("#f-"+req[0])?.focus(); return; }
    if(col==="projects"&&$("#split-total")?.dataset.ok==="false"){ toast("The money split must total 100%."); return; }
    const rec=id?await update(col,id,vals):await create(col,vals);
    if(rec){ closeSheetNav({force:true}); toast(id?"Saved":"Created"); }
  }
  if(form.hasAttribute("data-settings-form")){
    const body={};
    for(const el of form.querySelectorAll("input[id^=s-],textarea[id^=s-]")){
      const k=el.id.slice(2); if(k.endsWith("-file")||k.endsWith("-pick")) continue;
      body[k]=["regions","leadSources","expenseCategories"].includes(k)?el.value.split("\n").map(x=>x.trim()).filter(Boolean):el.type==="number"?num(el.value):el.value.trim();
    }
    if("currency" in body){ body.currency=body.currency.toUpperCase(); try{ new Intl.NumberFormat(undefined,{style:"currency",currency:body.currency}); }catch(_){ toast(`"${body.currency}" is not a currency code. Use 3 letters, such as USD or LKR.`); return; } }
    try{ S.settings=await api("PUT","/api/settings",body); clearDirty(form); applyBrand(S.settings); render(); toast("Settings saved"); }catch(err){ toast(err.message); }
  }
  if(form.id==="new-user-form"){
    try{ await api("POST","/api/admin/users",{name:$("#u-name").value,email:$("#u-email").value,password:$("#u-pass").value,role:$("#u-role").value,tenant_id:+$("#u-tenant").value}); clearDirty(form); await loadAll(); toast("Account created"); }catch(err){ toast(err.message); }
  }
  if(form.id==="new-tenant-form"){
    try{ await api("POST","/api/admin/tenants",{name:$("#t-name").value}); clearDirty(form); await loadAdmin(); render(); toast("Company added"); }catch(err){ toast(err.message); }
  }
  if(form.id==="account-form"){
    const body={name:$("#m-name").value}; if($("#m-new").value){ body.password=$("#m-new").value; body.currentPassword=$("#m-cur").value; }
    try{ await api("PUT","/api/me",body); clearDirty(form); await loadAll(); toast("Account saved"); }catch(err){ toast(err.message); }
  }
}

async function switchTenant(id){
  if(sheetIsDirty()&&!await confirmDiscard()){ render(); return; }
  try{ await api("POST","/api/admin/switch",{tenant_id:id}); S.layoutDraft=null; S.rolesDraft=null; S.leadRegion=""; await loadAll();
    await navigate({view:S.view==="settings"?"settings":"overview",tab:S.settingsTab},{force:true}); toast(`Now working in ${S.tenant?.name||"that company"}`); }
  catch(err){ toast(err.message); }
}

/* doc editor toolbar: keep the text selection while clicking buttons */
document.addEventListener("mousedown",e=>{ if(e.target.closest("#ed-toolbar [data-ed]")) e.preventDefault(); });
document.addEventListener("click",e=>{ const b=e.target.closest("#ed-toolbar [data-ed]"); if(b) runEd(b.dataset.ed,b); });
document.addEventListener("change",e=>{
  if(e.target.id!=="ed-block"||!S.docPage?.editor) return;
  const v=e.target.value, c=S.docPage.editor.chain().focus();
  (v==="p"?c.setParagraph():c.setHeading({level:Number(v.slice(1))})).run();
});
// Enter in the title moves into the doc
document.addEventListener("keydown",e=>{ if(e.target.id==="doc-title"&&e.key==="Enter"){ e.preventDefault(); const ed=S.docPage?.editor; if(ed){ ed.commands.setTextSelection(1); ed.view.focus(); } } });

/* drag & drop on boards */
let dragId=null;
document.addEventListener("dragstart",e=>{ const c=e.target.closest?.("[data-drag]"); if(!c) return; dragId=Number(c.dataset.drag); e.dataTransfer.effectAllowed="move"; try{e.dataTransfer.setData("text/plain",String(dragId));}catch(_){} });
document.addEventListener("dragover",e=>{ const col=e.target.closest?.("[data-drop]"); if(!col||!dragId) return; e.preventDefault(); document.querySelectorAll(".col.drop").forEach(x=>x!==col&&x.classList.remove("drop")); col.classList.add("drop"); });
document.addEventListener("dragleave",e=>{ const col=e.target.closest?.("[data-drop]"); if(col&&!col.contains(e.relatedTarget)) col.classList.remove("drop"); });
document.addEventListener("drop",async e=>{
  const col=e.target.closest?.("[data-drop]"); if(!col||!dragId) return; e.preventDefault(); col.classList.remove("drop");
  const [c,field,val]=col.dataset.drop.split(":"); const rec=byId(c,dragId); dragId=null;
  if(!rec||rec[field]===val) return;
  const before=rec[field]; rec[field]=val; render();
  if(!await update(c,rec.id,{[field]:val})){ rec[field]=before; render(); }
});
document.addEventListener("dragend",()=>{ dragId=null; document.querySelectorAll(".col.drop").forEach(x=>x.classList.remove("drop")); });

/* ---------- docs ----------
 * /docs lists the docs this person can see; /docs/<id> opens one in the editor.
 * Locked docs are visible only to their creator; shared docs to everyone in the company.
 * The editor (public/vendor/editor.js, Tiptap) loads the first time a doc is opened.
 * Changes save automatically a moment after typing stops. */
const LINK_TYPES={leads:"Lead",clients:"Client",projects:"Project",tasks:"Task",quotes:"Quotation",invoices:"Invoice",expenses:"Expense"};
const linkLabel=l=>{ const r=byId(l.type,l.id); if(!r) return `${LINK_TYPES[l.type]} (removed)`;
  return `${LINK_TYPES[l.type]} · ${r.number||r.company||r.name||r.title||r.description||"#"+r.id}`; };
const linkTarget=l=>["clients","projects"].includes(l.type)?{go:`${l.type==="clients"?"client":"project"}:${l.id}`}:{open:`${l.type}:${l.id}`};
const ago=iso=>{ if(!iso) return ""; const s=(Date.now()-new Date(iso))/1000;
  if(s<60) return "just now"; if(s<3600) return Math.floor(s/60)+" min ago"; if(s<86400) return Math.floor(s/3600)+" h ago";
  if(s<7*86400) return Math.floor(s/86400)+" d ago"; return fmtDate(iso); };
const visPill=d=>d.visibility==="shared"?`<span class="pill info" title="Everyone in the company can read and edit">Shared</span>`:`<span class="pill" title="Only you can see this doc">🔒 Locked</span>`;
const myDocTasks=()=>S.data.docs.flatMap(d=>(d.tasks||[]).filter(t=>t.assignee===S.me.id&&!t.done&&t.tid).map(t=>({...t,doc:d})))
  .sort((a,b)=>(a.due||"9999").localeCompare(b.due||"9999"));
const docsLinkedTo=(type,id)=>S.data.docs.filter(d=>(d.links||[]).some(l=>l.type===type&&l.id===Number(id)));
const upsertDocMeta=row=>{ const meta={...row}; delete meta.content; const i=S.data.docs.findIndex(x=>x.id===row.id); if(i>=0) S.data.docs[i]=meta; else S.data.docs.unshift(meta); };

let editorLib=null;
function loadEditorLib(){
  if(window.CRMEditor) return Promise.resolve();
  return editorLib??=new Promise((res,rej)=>{ const s=document.createElement("script"); s.src="/vendor/editor.js"; s.onload=res; s.onerror=()=>{ editorLib=null; rej(new Error("The editor didn't load. Check your connection and try again.")); }; document.head.appendChild(s); });
}

function viewDocsList(){
  const f=S.docFilter||"all", q=S.q.docs, me=S.me.id;
  const filters=[["all","All docs"],["shared","Shared with company"],["locked","Locked (only me)"],["mine","Created by me"],["mentions","Mentioning me"],["tasks","With my tasks"]];
  const rows=S.data.docs.filter(d=>matches({t:d.title,e:d.excerpt,l:(d.links||[]).map(linkLabel)},q)&&(
    f==="all"||(f==="shared"&&d.visibility==="shared")||(f==="locked"&&d.visibility!=="shared")||(f==="mine"&&d.created_by===me)||
    (f==="mentions"&&(d.mentions||[]).includes(me))||(f==="tasks"&&(d.tasks||[]).some(t=>t.assignee===me&&!t.done))));
  let h=head("Docs","Notes, plans and checklists. Locked docs are visible only to you; shared docs to everyone in the company.",
    `${searchBox("docs")}<select class="input inline" id="doc-filter" aria-label="Show">${filters.map(([k,l])=>`<option value="${k}" ${k===f?"selected":""}>${l}</option>`).join("")}</select>${addBtn("New doc","new-doc")}`);
  if(!S.data.docs.length) return h+`<div class="panel">${emptyState("No docs yet","Write meeting notes, project plans and checklists. Add tasks for people, tag colleagues with @, and link a doc to any client, project, quotation or invoice.","Write your first doc","new-doc")}</div>`;
  if(!rows.length) return h+`<div class="panel">${emptyState("No docs match","Try another filter or search.")}</div>`;
  return h+`<div class="panel table-wrap"><table class="docs-table"><thead><tr><th>Doc</th><th>Access</th><th>Linked to</th><th class="r">Tasks</th><th>Updated</th></tr></thead><tbody>${rows.map(d=>{
    const open=(d.tasks||[]).filter(t=>!t.done).length, all=(d.tasks||[]).length, links=d.links||[];
    return `<tr data-go-detail="doc:${d.id}"><td><div class="cell-main">${esc(d.title||"Untitled")}</div>${d.excerpt?`<div class="cell-sub doc-excerpt">${esc(d.excerpt)}</div>`:""}</td><td>${visPill(d)}</td>
      <td>${links.slice(0,2).map(l=>`<span class="tag">${esc(linkLabel(l))}</span>`).join(" ")}${links.length>2?` <span class="cell-sub">+${links.length-2}</span>`:""}${links.length?"":"—"}</td>
      <td class="r num">${all?`${all-open}/${all} done`:"—"}</td><td><div>${esc(userName(d.updated_by))}</div><div class="cell-sub">${ago(d.updated_at)}</div></td></tr>`; }).join("")}</tbody></table></div>`;
}

// The doc page. Once the editor is on screen, redraws leave it alone (see doRender) and only the
// surrounding details (save status, links, access) are refreshed.
function viewDocPage(){
  const P=S.docPage;
  if(!P||P.id!==S.param||!P.doc) return `<div class="doc-page" aria-busy="true">${P?.error?`<div class="panel load-error" role="alert"><strong>${esc(P.error)}</strong><a class="btn" href="/docs" data-go="docs">← All docs</a></div>`:`<div class="doc-top"><span class="skel" style="width:90px;height:28px"></span></div><span class="skel" style="width:60%;height:40px;margin:18px 0"></span><div class="skel-lines"><i></i><i></i><i></i><i></i></div>`}</div>`;
  return `<div class="doc-page">
    <div class="doc-top"><a class="btn ghost sm" href="/docs" data-go="docs">← Docs</a><span class="doc-status" id="doc-status" aria-live="polite"></span><span class="doc-top-actions" id="doc-actions"></span></div>
    <div id="doc-conflict"></div>
    <textarea id="doc-title" class="doc-title" rows="1" placeholder="Untitled" aria-label="Title" maxlength="200">${esc(P.doc.title)}</textarea>
    <div class="doc-meta" id="doc-meta"></div>
    <div class="ed-toolbar" id="ed-toolbar" role="toolbar" aria-label="Formatting"></div>
    <div class="ed-surface" id="ed-surface"></div>
  </div>`;
}
const canChangeAccess=d=>d.created_by===S.me.id;
const canDeleteDoc=d=>d.created_by===S.me.id||(d.visibility==="shared"&&isAdmin());
function paintDocChrome(){
  const P=S.docPage; if(!P?.doc||!$("#doc-meta")) return;
  const d=P.doc;
  const st=$("#doc-status");
  if(st) st.innerHTML=P.status==="saving"?`<span class="spin-dot"></span>Saving…`:P.status==="dirty"?"Unsaved changes":P.status==="error"?`<span class="bad">Couldn't save. Retrying…</span>`:P.status==="conflict"?`<span class="bad">Not saved: see below</span>`:`Saved${P.savedAt?" · "+ago(P.savedAt):""}`;
  $("#doc-actions").innerHTML=`${canChangeAccess(d)?`<div class="seg" role="group" aria-label="Who can see this doc"><button type="button" data-act="doc-vis" data-v="private" aria-pressed="${d.visibility!=="shared"}">🔒 Locked to me</button><button type="button" data-act="doc-vis" data-v="shared" aria-pressed="${d.visibility==="shared"}">Shared with company</button></div>`:visPill(d)}
    <button type="button" class="btn sm" data-act="doc-print">Print / PDF</button>${canDeleteDoc(d)?`<button type="button" class="btn sm danger" data-act="doc-delete">Delete</button>`:""}`;
  const people=d.visibility==="shared"?"":`<span class="doc-locked-note">Only you can see this doc. People you tag or assign won't see it until you share it.</span>`;
  $("#doc-meta").innerHTML=`<span class="cell-sub">Created by ${esc(userName(d.created_by))} · ${fmtDate(d.created_at)}${d.updated_by?` · edited by ${esc(userName(d.updated_by))} ${ago(d.updated_at)}`:""}</span>
    <div class="doc-links">${(d.links||[]).map((l,i)=>{ const t=linkTarget(l); return `<span class="link-chip"><a href="${t.go?pageUrl(...t.go.split(":").map((x,j)=>j?Number(x):x)):urlFor({...currentRoute(),record:{col:l.type,id:l.id}})}" ${t.go?`data-go-detail="${t.go}"`:`data-open="${t.open}"`}>${esc(linkLabel(l))}</a><button type="button" data-link-remove="${i}" aria-label="Remove link">×</button></span>`; }).join("")}
    <button type="button" class="btn sm ghost" data-act="doc-link-add">+ Link to a record</button></div>${people}`;
}
function docToolbar(){
  const B=(cmd,label,icon,title)=>`<button type="button" data-ed="${cmd}" title="${title||label}" aria-label="${title||label}">${icon}</button>`;
  return `<select id="ed-block" aria-label="Text style"><option value="p">Text</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option></select>
    <span class="ed-sep"></span>${B("bold","Bold","<b>B</b>","Bold (Ctrl+B)")}${B("italic","Italic","<i>I</i>","Italic (Ctrl+I)")}${B("underline","Underline","<u>U</u>","Underline (Ctrl+U)")}${B("strike","Strikethrough","<s>S</s>")}${B("highlight","Highlight",'<span class="ed-hl">H</span>')}${B("code","Inline code","&lt;/&gt;")}${B("link","Link","🔗")}
    <span class="ed-sep"></span>${B("bullet","Bulleted list","•≡")}${B("ordered","Numbered list","1≡")}${B("task","Task list","☑ Task")}${B("quote","Quote","❝")}${B("codeblock","Code block","{ }")}${B("hr","Divider","―")}${B("table","Table","▦")}
    <span class="ed-sep"></span>${B("date","Insert date","📅 Date")}${B("mention","Mention someone","@ Tag")}
    <span class="ed-sep"></span>${B("undo","Undo","↶","Undo (Ctrl+Z)")}${B("redo","Redo","↷","Redo (Ctrl+Shift+Z)")}
    <span class="ed-table-tools" hidden><span class="ed-sep"></span>${B("rowAfter","Add row","+ Row")}${B("colAfter","Add column","+ Col")}${B("rowDel","Delete row","− Row")}${B("colDel","Delete column","− Col")}${B("tableDel","Delete table","✕ Table")}</span>`;
}
function syncToolbar(){
  const ed=S.docPage?.editor, tb=$("#ed-toolbar"); if(!ed||!tb) return;
  const on={bold:"bold",italic:"italic",underline:"underline",strike:"strike",highlight:"highlight",code:"code",link:"link",bullet:"bulletList",ordered:"orderedList",task:"taskList",quote:"blockquote",codeblock:"codeBlock"};
  tb.querySelectorAll("[data-ed]").forEach(b=>{ const k=on[b.dataset.ed]; if(k) b.setAttribute("aria-pressed",String(ed.isActive(k))); });
  $("#ed-block").value=ed.isActive("heading",{level:1})?"h1":ed.isActive("heading",{level:2})?"h2":ed.isActive("heading",{level:3})?"h3":"p";
  tb.querySelector('[data-ed="undo"]').disabled=!ed.can().undo(); tb.querySelector('[data-ed="redo"]').disabled=!ed.can().redo();
  tb.querySelector(".ed-table-tools").hidden=!ed.isActive("table");
}
function runEd(cmd,btn){
  const ed=S.docPage?.editor; if(!ed) return; const c=ed.chain().focus();
  const map={bold:()=>c.toggleBold(),italic:()=>c.toggleItalic(),underline:()=>c.toggleUnderline(),strike:()=>c.toggleStrike(),highlight:()=>c.toggleHighlight(),code:()=>c.toggleCode(),
    bullet:()=>c.toggleBulletList(),ordered:()=>c.toggleOrderedList(),task:()=>c.toggleTaskList(),quote:()=>c.toggleBlockquote(),codeblock:()=>c.toggleCodeBlock(),hr:()=>c.setHorizontalRule(),
    table:()=>c.insertTable({rows:3,cols:3,withHeaderRow:true}),date:()=>c.insertDate(todayISO()),mention:()=>c.insertContent("@"),undo:()=>c.undo(),redo:()=>c.redo(),
    rowAfter:()=>c.addRowAfter(),colAfter:()=>c.addColumnAfter(),rowDel:()=>c.deleteRow(),colDel:()=>c.deleteColumn(),tableDel:()=>c.deleteTable()};
  if(cmd==="link") return linkPrompt(btn);
  map[cmd]?.().run(); syncToolbar();
}
function linkPrompt(btn){
  const ed=S.docPage.editor, cur=ed.getAttributes("link").href||"";
  CRMEditor.closePop();
  const el=document.createElement("div"); el.className="ed-pop ed-linkpop";
  el.innerHTML=`<label for="ed-link-url">Link address</label><input id="ed-link-url" type="url" placeholder="https://…" value="${esc(cur)}"><div class="ed-date-row">${cur?'<button type="button" data-x>Remove link</button>':"<span></span>"}<button type="button" class="primary" data-ok>Apply</button></div>`;
  document.body.appendChild(el); const r=btn.getBoundingClientRect(); el.style.left=Math.min(r.left,innerWidth-300)+"px"; el.style.top=(r.bottom+6)+"px";
  const input=el.querySelector("input"); setTimeout(()=>input.focus(),0);
  const done=()=>{ el.remove(); document.removeEventListener("mousedown",outside); };
  const apply=()=>{ let v=input.value.trim(); if(v&&!/^(https?:\/\/|mailto:|tel:)/i.test(v)) v="https://"+v;
    if(!v) ed.chain().focus().extendMarkRange("link").unsetLink().run(); else ed.chain().focus().extendMarkRange("link").setLink({href:v}).run(); done(); };
  const outside=e=>{ if(!el.contains(e.target)) done(); };
  setTimeout(()=>document.addEventListener("mousedown",outside),0);
  el.addEventListener("click",e=>{ if(e.target.closest("[data-ok]")) apply(); if(e.target.closest("[data-x]")){ ed.chain().focus().extendMarkRange("link").unsetLink().run(); done(); } });
  input.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); apply(); } if(e.key==="Escape"){ done(); ed.commands.focus(); } });
}

// Called by the router when /docs/<id> is shown.
async function enterDocPage(id){
  if(S.docPage?.id===id&&(S.docPage.doc||S.docPage.loading)) return;
  leaveDocPage();
  const P=S.docPage={id,loading:true,status:"saved"};
  try{
    const [doc]=await Promise.all([api("GET","/api/docs/"+id),loadEditorLib()]);
    if(S.docPage!==P) return;
    P.doc=doc; P.version=doc.version; P.loading=false; upsertDocMeta(doc);
    doRender(); mountEditor();
  }catch(e){ if(S.docPage!==P) return; P.loading=false; P.error=/locked|exist/i.test(e.message)?e.message:"This doc didn't load. "+e.message; doRender(); }
}
function mountEditor(){
  const P=S.docPage, host=$("#ed-surface"); if(!P?.doc||!host) return;
  $("#ed-toolbar").innerHTML=docToolbar();
  P.editor=CRMEditor.create({ element:host, content:P.doc.content, users:()=>S.users, me:S.me.id,
    onChange:()=>{ P.status="dirty"; paintDocChrome(); clearTimeout(P.saveT); P.saveT=setTimeout(()=>saveDoc(),900); } });
  P.editor.on("selectionUpdate",syncToolbar); P.editor.on("transaction",syncToolbar);
  P.mounted=true; paintDocChrome(); syncToolbar(); fitTitle();
  if(!P.doc.title) $("#doc-title")?.focus(); else P.editor.commands.focus("start");
}
const fitTitle=()=>{ const t=$("#doc-title"); if(t){ t.style.height="auto"; t.style.height=t.scrollHeight+"px"; } };
// Save the editor's content. Only one save runs at a time; edits made meanwhile are saved right after.
async function saveDoc({force=false,keepalive=false}={}){
  const P=S.docPage; if(!P?.editor||P.status==="conflict"&&!force) return;
  clearTimeout(P.saveT);
  if(P.saving){ P.again=true; return P.saving; }
  const content=P.editor.getJSON();
  P.status="saving"; paintDocChrome();
  P.saving=(async()=>{
    try{
      const body=JSON.stringify({content,base_version:P.version,...(force?{force:true}:{})});
      if(keepalive){ fetch("/api/docs/"+P.id,{method:"PUT",headers:{"Content-Type":"application/json"},body,keepalive:true,credentials:"same-origin"}); return; }
      const res=await fetch("/api/docs/"+P.id,{method:"PUT",headers:{"Content-Type":"application/json"},body,credentials:"same-origin"});
      const data=await res.json().catch(()=>null);
      if(S.docPage!==P) return;
      if(res.status===409){ P.status="conflict"; P.theirs=data.doc; showConflict(); return; }
      if(!res.ok) throw new Error(data?.error||"Save failed");
      P.version=data.version; P.doc={...P.doc,...data}; upsertDocMeta(data); P.savedAt=new Date().toISOString();
      P.status=P.again||P.status==="dirty"?"dirty":"saved";
    }catch(e){ if(S.docPage!==P) return; P.status="error"; P.saveT=setTimeout(()=>saveDoc(),5000); }
    finally{ P.saving=null; paintDocChrome(); if(P.again&&S.docPage===P){ P.again=false; saveDoc(); } }
  })();
  return P.saving;
}
function showConflict(){
  const P=S.docPage, box=$("#doc-conflict"); if(!box) return;
  box.innerHTML=`<div class="doc-conflict" role="alert"><div><strong>${esc(userName(P.theirs?.updated_by))} changed this doc while you were editing.</strong> Your latest changes are not saved yet. Choose which version to keep.</div>
    <div class="toolbar"><button type="button" class="btn" data-act="doc-theirs">Load their version</button><button type="button" class="btn primary" data-act="doc-mine">Keep mine (replace theirs)</button></div></div>`;
  paintDocChrome();
}
// Leaving the page: save anything pending, then let the editor go.
async function flushDoc(){ const P=S.docPage; if(P?.editor&&["dirty","error"].includes(P.status)) await saveDoc(); else if(P?.saving) await P.saving; }
function leaveDocPage(){ const P=S.docPage; if(!P) return; clearTimeout(P.saveT); clearTimeout(P.titleT); P.editor?.destroy(); window.CRMEditor?.closePop(); S.docPage=null; }
async function saveDocField(body){
  const P=S.docPage; if(!P) return;
  try{ const row=await api("PUT","/api/docs/"+P.id,body); if(S.docPage!==P) return; P.doc={...P.doc,...row,content:P.doc.content}; P.version=row.version; upsertDocMeta(row); P.savedAt=new Date().toISOString(); paintDocChrome(); return row; }
  catch(e){ toast(e.message); }
}
async function createDoc(links=[]){
  try{ const row=await api("POST","/api/docs",{title:"",links,visibility:"private"}); upsertDocMeta(row); await navigate({view:"doc",param:row.id},{force:true}); }
  catch(e){ toast(e.message); }
}
function pickLink(btn){
  const P=S.docPage, have=new Set((P.doc.links||[]).map(l=>l.type+l.id));
  const items=Object.keys(LINK_TYPES).flatMap(type=>S.data[type].map(r=>({type,id:r.id,label:linkLabel({type,id:r.id})}))).filter(i=>!have.has(i.type+i.id));
  new CRMEditor.ListPop({items,search:true,placeholder:"Search clients, projects, invoices…",rect:btn.getBoundingClientRect(),emptyText:"Nothing to link",
    renderItem:it=>`<span>${esc(it.label)}</span>`,
    onPick:it=>{ CRMEditor.closePop(); saveDocField({links:[...(P.doc.links||[]),{type:it.type,id:it.id}]}); }});
}
// Docs section for a record panel or page.
function linkedDocsHtml(type,id){
  const list=docsLinkedTo(type,id);
  return `<h3 class="sub-head">Docs</h3>${list.length?`<ul class="list-plain linked-docs">${list.map(d=>`<li data-go-detail="doc:${d.id}"><span><span class="cell-main">${esc(d.title||"Untitled")}</span>${d.excerpt?`<br><span class="cell-sub">${esc(d.excerpt.slice(0,90))}</span>`:""}</span><span class="meta">${visPill(d)}</span></li>`).join("")}</ul>`:`<p class="hint">No docs linked yet.</p>`}
    <button type="button" class="btn sm" data-act="new-doc" data-link="${type}:${id}">+ New linked doc</button>`;
}
function myTasksPanel(){
  const tasks=myDocTasks(), t=todayISO();
  return `<section class="panel"><h2>Assigned to me in docs</h2>${tasks.length?`<ul class="list-plain my-tasks">${tasks.slice(0,10).map(x=>`<li><label class="check-line"><input type="checkbox" data-doc-task="${x.doc.id}|${esc(x.tid)}" aria-label="Mark done"></label><span class="grow" data-go-detail="doc:${x.doc.id}"><span class="cell-main">${esc(x.text||"Untitled task")}</span><br><span class="cell-sub">${esc(x.doc.title||"Untitled")}</span></span><span class="meta" style="${x.due&&x.due<t?"color:var(--bad)":""}">${x.due?(x.due<t?"Overdue · ":"")+fmtDate(x.due):""}</span></li>`).join("")}</ul>`:`<div class="empty">Nothing assigned to you in docs.</div>`}</section>`;
}

/* notifications (the bell) */
async function refreshUnread(){ try{ const r=await api("GET","/api/notifications"); S.notifs=r.items; S.unread=r.unread; paintBell(); }catch(e){} }
function paintBell(){ const b=$("#bell-count"); if(b){ b.textContent=S.unread>9?"9+":String(S.unread||""); b.hidden=!S.unread; } $("#bell")?.setAttribute("aria-label",`Notifications${S.unread?` (${S.unread} unread)`:""}`); }
async function openBell(btn){
  CRMEditor?.closePop?.();
  const old=$("#notif-pop"); if(old){ old.remove(); return; }
  await refreshUnread();
  const el=document.createElement("div"); el.id="notif-pop"; el.className="notif-pop"; el.setAttribute("role","dialog"); el.setAttribute("aria-label","Notifications");
  const items=S.notifs||[];
  el.innerHTML=`<div class="notif-head"><b>Notifications</b>${S.unread?`<button type="button" class="btn ghost sm" data-act="notif-all">Mark all read</button>`:""}</div>${items.length?`<ul>${items.map(n=>`<li class="${n.read_at?"":"unread"}" data-notif="${n.id}|${n.doc_id}"><span class="ed-av">${esc((userName(n.actor_id)||"?").split(/\s+/).map(w=>w[0]).join("").slice(0,2).toUpperCase())}</span><span><b>${esc(userName(n.actor_id))}</b> ${n.kind==="task"?`assigned you <b>“${esc(n.text||"a task")}”</b> in`:"mentioned you in"} <b>${esc(n.doc_title||"Untitled")}</b><br><span class="cell-sub">${ago(n.created_at)}</span></span></li>`).join("")}</ul>`:`<div class="empty">You're all caught up.</div>`}`;
  document.body.appendChild(el);
  const r=btn.getBoundingClientRect(); el.style.top=(r.bottom+8)+"px"; el.style.left=Math.max(8,Math.min(r.left,innerWidth-el.offsetWidth-8))+"px";
  const outside=e=>{ if(!el.contains(e.target)&&!btn.contains(e.target)){ el.remove(); document.removeEventListener("mousedown",outside); } };
  setTimeout(()=>document.addEventListener("mousedown",outside),0);
}
setInterval(()=>{ if(S.ready&&document.visibilityState==="visible") refreshUnread(); },60000);

/* ---------- money: who earns what, who holds it, who owes whom ----------
 * Every payment received on an invoice is divided by the split (Settings → Money; a project can change
 * people or percentages). Each payment records who took the money: the company fund or a person.
 * Expenses come out of the company's share; one paid from someone's own pocket is owed back to them.
 * Settlements record money handed from one party to another.
 * For each party: position = cash they hold − what they are entitled to.
 *   above zero → they hold money that belongs to others (they owe);  below zero → they are owed. */
const DEFAULT_ROLES=[{key:"partner1",label:"Partner 1",pct:10,user_id:null},{key:"partner2",label:"Partner 2",pct:10,user_id:null},{key:"partner3",label:"Partner 3",pct:10,user_id:null},
  {key:"developer",label:"Developer",pct:20,user_id:null},{key:"lead",label:"Lead",pct:10,user_id:null},{key:"company",label:"Company",pct:40,company:true}];
const moneyRoles=()=>(S.settings.moneyRoles?.length?S.settings.moneyRoles:DEFAULT_ROLES);
const keeperId=()=>S.settings.moneyKeeper||null;
const partyKey=v=>v==null||v===""||v==="company"?"company":"u"+Number(v);
const partyValue=k=>k==="company"?"company":k.slice(1);
const fundLabel=()=>`Company fund${keeperId()?` (kept by ${userName(keeperId())})`:""}`;
const partyName=k=>k==="company"?fundLabel():userName(Number(k.slice(1)));
const r2=x=>Math.round((x+Number.EPSILON)*100)/100;
// The split that applies to a project: company defaults, then the project's own changes.
// The Lead share goes to the project lead unless the project names someone else.
function projectSplit(p){
  const ov=new Map((p?.split||[]).map(o=>[o.key,o]));
  return moneyRoles().map(r=>{ const o=ov.get(r.key)||{};
    const user=r.company?null:(o.user_id||(r.key==="lead"&&p?.owner_id?p.owner_id:null)||r.user_id||null);
    return {...r,pct:o.pct!=null?num(o.pct):num(r.pct),user_id:user,changed:o.pct!=null||!!o.user_id}; });
}
const splitTotal=split=>r2(split.reduce((a,r)=>a+num(r.pct),0));
// people a share can go to: active members of this company (and the super admin)
const moneyPeople=()=>S.users.filter(u=>u.active!==false);
function ledger(){
  const parties=new Map(), byProject=new Map();
  const P=k=>{ if(!parties.has(k)) parties.set(k,{key:k,earned:0,borne:0,received:0,spent:0,sent:0,got:0}); return parties.get(k); };
  const shareTo=r=>r.company||!r.user_id||!S.users.some(u=>u.id===r.user_id)?"company":"u"+r.user_id; // unassigned shares stay with the company
  P("company");
  for(const inv of S.data.invoices){
    if(inv.status==="Void") continue;
    const proj=byId("projects",inv.project_id), split=projectSplit(proj), pk=proj?proj.id:0;
    const row=byProject.get(pk)||{project:proj,received:0,shares:new Map(),split}; byProject.set(pk,row);
    for(const pay of inv.payments||[]){
      const amt=num(pay.amount); if(!amt) continue;
      const who=partyKey(pay.received_by); P(who).received+=amt; row.received+=amt;
      for(const r of split){ const v=amt*num(r.pct)/100, k=shareTo(r); P(k).earned+=v; row.shares.set(r.key,(row.shares.get(r.key)||0)+v); }
    }
  }
  for(const e of S.data.expenses){
    const amt=num(e.amount); if(!amt) continue;
    P("company").borne+=amt;
    const payer=e.paid_from==="personal"&&e.paid_by?partyKey(e.paid_by):"company";
    P(payer).spent+=amt;
  }
  for(const s of S.data.settlements||[]){ const amt=num(s.amount); if(!amt) continue; P(partyKey(s.from_party)).sent+=amt; P(partyKey(s.to_party)).got+=amt; }
  for(const p of parties.values()){
    p.held=r2(p.received-p.spent-p.sent+p.got); p.entitled=r2(p.earned-p.borne); p.position=r2(p.held-p.entitled);
  }
  // fewest transfers: whoever holds others' money pays whoever is owed
  const owe=[...parties.values()].filter(p=>p.position>0.009).map(p=>({k:p.key,v:p.position})).sort((a,b)=>b.v-a.v);
  const owed=[...parties.values()].filter(p=>p.position<-0.009).map(p=>({k:p.key,v:-p.position})).sort((a,b)=>b.v-a.v);
  const transfers=[]; let i=0,j=0;
  while(i<owe.length&&j<owed.length){ const v=r2(Math.min(owe[i].v,owed[j].v)); if(v>0.009) transfers.push({from:owe[i].k,to:owed[j].k,amount:v});
    owe[i].v=r2(owe[i].v-v); owed[j].v=r2(owed[j].v-v); if(owe[i].v<=0.009) i++; if(owed[j].v<=0.009) j++; }
  const list=[...parties.values()].sort((a,b)=>(a.key==="company"?-1:b.key==="company"?1:partyName(a.key).localeCompare(partyName(b.key))));
  return {parties:list,company:parties.get("company"),transfers,byProject:[...byProject.values()].sort((a,b)=>b.received-a.received)};
}
const positionText=p=>p.position>0.009?`<span class="owes">Owes ${money(p.position)}</span>`:p.position<-0.009?`<span class="owed">Is owed ${money(-p.position)}</span>`:`<span class="settled">Settled</span>`;

function viewMoney(){
  const L=ledger(), c=L.company, roles=moneyRoles();
  const received=L.parties.reduce((a,p)=>a+p.received,0), spent=c.borne;
  let h=head("Money",`How money received is divided, who holds it, and who owes whom. Split: ${roles.map(r=>`${esc(r.label)} ${num(r.pct)}%`).join(" · ")}${isAdmin()?` · <a href="/settings/money" data-go="settings" data-tab-to="money">Change</a>`:""}`,
    `<button class="btn" data-act="csv-settlements">Export settlements</button>${addBtn("Record settlement","new-settlement")}`);
  const unassigned=L.byProject.filter(r=>r.received>0&&r.split.some(x=>!x.company&&!x.user_id));
  if(unassigned.length) h+=`<div class="money-warn" role="note"><b>Some shares have no person yet</b>, so they are counted with the company for now: ${unassigned.map(r=>`${r.project?`<a href="/projects/${r.project.id}" data-go-detail="project:${r.project.id}">${esc(r.project.name)}</a>`:"invoices without a project"} (${r.split.filter(x=>!x.company&&!x.user_id).map(x=>esc(x.label)).join(", ")})`).join("; ")}. ${isAdmin()?"Set them in Settings → Money or on each project.":""}</div>`;
  h+=`<div class="kpis">
    <div class="panel kpi"><div class="label">Received from clients</div><div class="value">${money(received)}</div><div class="sub">All payments on invoices</div></div>
    <div class="panel kpi"><div class="label">Company fund on hand</div><div class="value">${money(c.held)}</div><div class="sub">${keeperId()?"Kept by "+esc(userName(keeperId())):isAdmin()?`<a href="/settings/money" data-go="settings" data-tab-to="money">Choose who keeps it</a>`:"No keeper set"}</div></div>
    <div class="panel kpi"><div class="label">Company's share</div><div class="value">${money(c.entitled)}</div><div class="sub">${money(c.earned)} earned − ${money(spent)} expenses</div></div>
    <div class="panel kpi"><div class="label">Still to settle</div><div class="value">${money(L.transfers.reduce((a,t)=>a+t.amount,0))}</div><div class="sub">${L.transfers.length?`${L.transfers.length} transfer${L.transfers.length===1?"":"s"} below`:"Everyone is settled"}</div></div>
  </div><div class="grid2">`;
  h+=`<section class="panel"><h2>Who owes whom</h2>${L.transfers.length?`<ul class="list-plain transfers">${L.transfers.map(t=>`<li><span><b>${esc(partyName(t.from))}</b> <span class="arrow">→</span> <b>${esc(partyName(t.to))}</b><br><span class="cell-sub">${t.to==="company"?"hand over the company's money":t.from==="company"?"pay out their share from the fund":"pass on what's due"}</span></span><span class="meta"><span class="num amt">${money(t.amount)}</span><button type="button" class="btn sm" data-act="settle" data-from="${partyValue(t.from)}" data-to="${partyValue(t.to)}" data-amt="${t.amount}">Record</button></span></li>`).join("")}</ul>`:`<div class="empty">Everyone is settled up.</div>`}</section>`;
  h+=`<section class="panel"><h2>How the fund moved</h2><div class="fund-flow">${[["Received into the fund",c.received],["Received from others",c.got],["Expenses paid from the fund",-c.spent],["Paid out to people",-c.sent]].map(([k,v])=>`<div><span>${k}</span><span class="num ${v<0?"neg":""}">${v<0?"−":""}${money(Math.abs(v))}</span></div>`).join("")}<div class="tot"><span>On hand</span><span class="num">${money(c.held)}</span></div></div></section></div>`;
  h+=`<h3 class="sub-head">Each person's position</h3><div class="panel table-wrap"><table class="money-table"><thead><tr><th>Who</th><th>Position</th><th class="r">Holds now</th><th class="r">Share earned</th><th class="r">Expenses borne</th><th class="r">Took from clients</th><th class="r">Spent for company</th><th class="r">Handed over</th><th class="r">Received</th></tr></thead><tbody>${L.parties.map(p=>`<tr><td class="cell-main">${esc(partyName(p.key))}</td><td>${positionText(p)}</td><td class="r num">${money(p.held)}</td><td class="r num">${money(p.earned)}</td><td class="r num">${p.borne?"−"+money(p.borne):"—"}</td><td class="r num">${p.received?money(p.received):"—"}</td><td class="r num">${p.spent?money(p.spent):"—"}</td><td class="r num">${p.sent?money(p.sent):"—"}</td><td class="r num">${p.got?money(p.got):"—"}</td></tr>`).join("")}</tbody></table></div>
  <p class="hint money-explain"><b>Position</b> = what someone holds now − what they're entitled to (their share, minus expenses for the company). "Owes" means they hold money that belongs to others; "Is owed" means others hold their money. Expenses paid from someone's own pocket are owed back to them.</p>`;
  const projRows=L.byProject.filter(r=>r.received>0);
  h+=`<h3 class="sub-head">By project</h3>${projRows.length?`<div class="panel table-wrap"><table class="money-table"><thead><tr><th>Project</th><th class="r">Received</th>${roles.map(r=>`<th class="r">${esc(r.label)}</th>`).join("")}</tr></thead><tbody>${projRows.map(r=>`<tr ${r.project?`data-go-detail="project:${r.project.id}"`:""}><td class="cell-main">${r.project?esc(r.project.name):'<span class="cell-sub">No project</span>'}</td><td class="r num">${money(r.received)}</td>${r.split.map(x=>`<td class="r"><div class="num">${money(r.shares.get(x.key)||0)}</div><div class="cell-sub">${num(x.pct)}% · ${x.company?"Company":x.user_id?esc(userName(x.user_id)):'<span class="unset">not set</span>'}</div></td>`).join("")}</tr>`).join("")}</tbody></table></div>`:`<div class="panel"><div class="empty">No payments received yet. Record payments on invoices to see the split.</div></div>`}`;
  const st=[...(S.data.settlements||[])].sort((a,b)=>(b.date||"").localeCompare(a.date||"")||b.id-a.id);
  h+=`<h3 class="sub-head">Settlements</h3>${st.length?`<div class="panel table-wrap"><table><thead><tr><th>Date</th><th>From</th><th>To</th><th>Method</th><th>Note</th><th class="r">Amount</th></tr></thead><tbody>${st.map(s=>`<tr data-open="settlements:${s.id}"><td>${fmtDate(s.date)}</td><td>${esc(partyName(partyKey(s.from_party)))}</td><td>${esc(partyName(partyKey(s.to_party)))}</td><td>${esc(s.method||"—")}</td><td>${esc(s.note||"")}</td><td class="r num">${money(s.amount)}</td></tr>`).join("")}</tbody></table></div>`:`<div class="panel"><div class="empty">No settlements yet. When someone hands money to the company fund or pays out a share, record it here.</div></div>`}`;
  return h;
}

// a project's split: who gets which share (editable by administrators)
function splitEditorHtml(rec){
  const split=projectSplit(rec), can=isAdmin(), ppl=moneyPeople();
  const ov=new Map((rec.split||[]).map(o=>[o.key,o]));
  return `<h3 class="sub-head">Money split</h3><div class="split-edit" data-split>
    <p class="hint">${can?"Change who gets each share, or the percentage, for this project only. Empty means the company default.":"Set by administrators."} The Lead share goes to the project lead unless you choose someone else.</p>
    <table class="items"><thead><tr><th>Share</th><th>Person</th><th class="r">%</th></tr></thead><tbody>${split.map(r=>{ const o=ov.get(r.key)||{};
      return `<tr><td>${esc(r.label)}</td><td>${r.company?`<span class="cell-sub">${esc(fundLabel())}</span>`:`<select class="input" data-split-key="${esc(r.key)}" data-split-f="user" ${can?"":"disabled"} aria-label="${esc(r.label)}"><option value="">Default${(()=>{ const d=r.key==="lead"&&rec.owner_id?rec.owner_id:moneyRoles().find(x=>x.key===r.key)?.user_id; return d?` (${esc(userName(d))})`:" (not set)"; })()}</option>${ppl.map(u=>`<option value="${u.id}" ${o.user_id===u.id?"selected":""}>${esc(u.name)}</option>`).join("")}</select>`}</td>
      <td class="r"><input class="input num pct" type="number" min="0" max="100" step="0.5" data-split-key="${esc(r.key)}" data-split-f="pct" value="${o.pct!=null?esc(o.pct):""}" placeholder="${num(moneyRoles().find(x=>x.key===r.key)?.pct)}" ${can?"":"disabled"} aria-label="${esc(r.label)} percentage"></td></tr>`; }).join("")}</tbody></table>
    <div class="split-total" id="split-total"></div></div>`;
}
function readSplit(form){
  const by=new Map();
  form.querySelectorAll("[data-split-key]").forEach(el=>{ const k=el.dataset.splitKey, o=by.get(k)||{key:k}; if(el.dataset.splitF==="user"&&el.value) o.user_id=Number(el.value); if(el.dataset.splitF==="pct"&&el.value!=="") o.pct=num(el.value); by.set(k,o); });
  return [...by.values()].filter(o=>o.user_id||o.pct!=null);
}
function paintSplitTotal(){
  const box=$("#split-total"), form=$("#rec-form"); if(!box||!form) return;
  const ov=new Map(readSplit(form).map(o=>[o.key,o])), total=r2(moneyRoles().reduce((a,r)=>a+(ov.get(r.key)?.pct??num(r.pct)),0));
  box.innerHTML=Math.abs(total-100)<0.01?`<span class="settled">Total ${total}%</span>`:`<span class="owes">Total ${total}%. Make it 100% before saving.</span>`;
  box.dataset.ok=String(Math.abs(total-100)<0.01);
}
// split + amounts on the project page
function projectMoneyPanel(p){
  const split=projectSplit(p), got=S.data.invoices.filter(i=>i.project_id===p.id&&i.status!=="Void").reduce((a,i)=>a+(i.payments||[]).reduce((s,x)=>s+num(x.amount),0),0);
  return `<section class="panel"><h2>Money split</h2><div class="split-view">${split.map(r=>`<div><span>${esc(r.label)} <span class="cell-sub">${num(r.pct)}%</span></span><span>${r.company?"Company":r.user_id?esc(userName(r.user_id)):'<span class="unset">not set</span>'}</span><span class="num">${money(got*num(r.pct)/100)}</span></div>`).join("")}<div class="tot"><span>Received so far</span><span></span><span class="num">${money(got)}</span></div></div>
    ${isAdmin()?`<div style="padding:0 18px 16px"><button type="button" class="btn sm" data-open="projects:${p.id}">Change split</button> <a class="btn sm ghost" href="/money" data-go="money">Open Money</a></div>`:""}</section>`;
}

// Settings → Money: the default split and who keeps the company fund
const rolesDraft=()=>(S.rolesDraft??=JSON.parse(JSON.stringify(moneyRoles())));
function moneySettingsHtml(){
  const R=rolesDraft(), total=r2(R.reduce((a,r)=>a+num(r.pct),0)), ok=Math.abs(total-100)<0.01, ppl=moneyPeople();
  return `<div class="panel" style="padding:18px;max-width:860px">
    <h3 class="sub-head" style="margin-top:0">How money received is divided</h3>
    <p class="hint">Every payment received on an invoice is split by these percentages. They must total 100%. People set here are the default for every project; each project can change them. Leave Developer and Lead empty to choose them per project (Lead defaults to the project lead).</p>
    <table class="items roles-table"><thead><tr><th>Share</th><th>Default person</th><th class="r">%</th><th></th></tr></thead><tbody>${R.map((r,i)=>`<tr>
      <td><input class="input" data-role="${i}" data-rf="label" value="${esc(r.label)}" aria-label="Share name" maxlength="40"></td>
      <td>${r.company?`<span class="cell-sub">Company fund</span>`:`<select class="input" data-role="${i}" data-rf="user_id" aria-label="Default person"><option value="">Choose per project</option>${ppl.map(u=>`<option value="${u.id}" ${r.user_id===u.id?"selected":""}>${esc(u.name)}</option>`).join("")}</select>`}</td>
      <td class="r"><input class="input num pct" type="number" min="0" max="100" step="0.5" data-role="${i}" data-rf="pct" value="${esc(r.pct)}" aria-label="Percentage"></td>
      <td>${r.company?"":`<button type="button" class="btn ghost sm" data-act="role-remove" data-i="${i}" aria-label="Remove share">✕</button>`}</td></tr>`).join("")}</tbody></table>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px"><button type="button" class="btn sm" data-act="role-add">+ Add share</button><span id="roles-total">${ok?`<span class="settled">Total ${total}%</span>`:`<span class="owes">Total ${total}%. Must be 100%.</span>`}</span></div>
    <h3 class="sub-head">Company fund</h3>
    <div class="field" style="max-width:360px"><label for="m-keeper">Kept by</label><select class="input" id="m-keeper"><option value="">Not set</option>${ppl.map(u=>`<option value="${u.id}" ${S.settings.moneyKeeper===u.id?"selected":""}>${esc(u.name)}</option>`).join("")}</select><span class="hint">The person who looks after the company's money. Payments marked "Company fund" are with them.</span></div>
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn primary" data-act="save-roles" ${ok?"":"disabled"}>Save</button><button type="button" class="btn" data-act="reset-roles">Back to 10 / 10 / 10 / 20 / 10 / 40</button></div>
  </div>`;
}

start();
})();
