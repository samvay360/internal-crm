// One-off import of the legacy leads sheet into the leads table.
//   DATABASE_URL=... node scripts/import-leads.js            # dry run, prints what would be added
//   DATABASE_URL=... node scripts/import-leads.js --apply    # writes (TENANT_ID=n if there is more than one company)
// Start the app once first so the tables exist (see migrate() in app.js).
const { Pool } = require("pg");

const IN = "+91 ";
// name, company, phone, ref (who referred / source), service (industry), region, stage, notes
const LEADS = [
  { name: "Bhagirath bhai", phone: IN + "90992 27982", ref: "24 Carat Appt.", service: "Nut-bolt Factory", region: "Rajkot",
    stage: "New", notes: "Ask after 14th October for any requirements.\nSheet status: No Action" },
  { name: "Tulesh Sir Charvik", phone: IN + "99799 22330", ref: "Bhavin Sir", service: "Hardware Industry",
    stage: "New", notes: "Sheet status: Contact Pending" },
  { name: "No Name", company: "Shree Ram Krishna Aluminium Extrusion", ref: "Varni", region: "Rajkot",
    stage: "New", notes: "Sheet status: Contact Pending" },
  { name: "Green Age Packaging", phone: IN + "8080228541, " + IN + "7385353419", ref: "Alu Bharat", service: "Packaging",
    region: "Pune", stage: "New", notes: "Trading, supply in Pune" },
  { name: "Shiv Metals", phone: IN + "9898178871", ref: "Alu Bharat", service: "Extrusion", notes: "Contact: Kalpesh Patel" },
  { name: "Rajbai Hardware", phone: IN + "7600890370", ref: "Alu Bharat", service: "Hardware Industry", region: "Banaskantha",
    stage: "Contacted", notes: "Contact: Rahul Panchal\nDemo video sent. Ahmedabad shop planned (December)." },
  { name: "Sumex Aluminium Extrusion", phone: IN + "7995004477", ref: "Alu Bharat", service: "Extrusion, started in fabrication",
    region: "Telangana", notes: "Contact: Rameshwar (sales manager)" },
  { name: "Manish Gothi Aluminium", phone: IN + "98241 57453", ref: "Alu Bharat", service: "Window Fabrication", region: "Palanpur",
    stage: "Contacted", notes: "Will start in 6 months.\nDemo video sent." },
  { name: "Khodiyar Aluminium", phone: IN + "9687113738", ref: "Alu Bharat", service: "Window Fabrication",
    stage: "Contacted", notes: "Demo video sent." },
  { name: "Vishwakarma Aluminium", phone: IN + "9935669740, WhatsApp " + IN + "9919626093", ref: "Alu Bharat",
    service: "Window Fabrication", region: "Varanasi", notes: "No call received." },
  { name: "AL Raza Aluminium", phone: IN + "9662239592, " + IN + "9558522429", ref: "Alu Bharat", service: "Window Fabrication",
    region: "Idar, Himmatnagar", stage: "Qualified",
    notes: "Contacts: Abbasali (9662239592), Aabidali (9558522429).\nInterested, but discuss after Diwali (end of November)." },
  { name: "KPR Fabrication", phone: IN + "9645434294, " + IN + "9061599090", ref: "Alu Bharat", service: "Window Fabrication",
    region: "Vaikathur, Valanchery" },
  { name: "Janik Aluminium", phone: IN + "9309412012", ref: "Alu Bharat", service: "Window Fabrication", region: "Bakrol, Ahmedabad",
    notes: "Contact: Ganesh Suthar\nUsing other software, but call." },
  { name: "Hetal Vora", phone: "+971 56 127 1206", ref: "Dilip Solanki", service: "Parts Management Program for their clients",
    region: "UAE" },
  { name: "Lions Tapes", region: "India", notes: "Contact: Dev Mehta" },
  { name: "Alu360 (resell)", region: "India", ref: "Sp Buildcon", notes: "Contact: Nikunj Patel" },
];

(async () => {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("Set DATABASE_URL.");
  const apply = process.argv.includes("--apply");
  const pool = new Pool({ connectionString: url,
    ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } });
  try {
    const tenants = (await pool.query("SELECT id, name FROM tenants ORDER BY id")).rows;
    const tenant = process.env.TENANT_ID ? tenants.find(t => t.id === Number(process.env.TENANT_ID)) : tenants.length === 1 ? tenants[0] : null;
    if (!tenant) throw new Error("Set TENANT_ID to one of: " + tenants.map(t => `${t.id}=${t.name}`).join(", "));
    const user = (await pool.query("SELECT id FROM users WHERE tenant_id = $1 AND active ORDER BY (role = 'admin') DESC, id LIMIT 1", [tenant.id])).rows[0];
    console.log(`${apply ? "Importing" : "Dry run:"} ${LEADS.length} leads into "${tenant.name}"`);
    const at = new Date().toISOString();
    let added = 0, skipped = 0;
    for (const l of LEADS) {
      const dup = await pool.query("SELECT 1 FROM leads WHERE tenant_id = $1 AND lower(name) = lower($2)", [tenant.id, l.name]);
      if (dup.rows.length) { skipped++; console.log("  skip (exists):", l.name); continue; }
      console.log("  add:", l.name);
      if (!apply) continue;
      const r = (await pool.query(
        `INSERT INTO leads (name, company, phone, region, ref, stage, service, notes, owner_id, tenant_id, created_by, created_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11,$9,$11) RETURNING id`,
        [l.name, l.company || null, l.phone || null, l.region || null, l.ref || null, l.stage || "New", l.service || null,
         l.notes || null, user?.id ?? null, tenant.id, at])).rows[0];
      await pool.query("INSERT INTO activity (entity, entity_id, action, summary, user_id, at, tenant_id) VALUES ('leads',$1,'created',$2,$3,$4,$5)",
        [r.id, `Imported lead ${l.name}`, user?.id ?? null, at, tenant.id]);
      added++;
    }
    console.log(apply ? `Done: ${added} added, ${skipped} skipped.` : `Re-run with --apply to write ${LEADS.length - skipped} leads.`);
  } finally { await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
