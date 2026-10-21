# Samvay360 CRM

A CRM for managing leads, clients, projects, tasks, quotations and invoices. It's styled to match samvay360.com, built to run on **Vercel**, and stores its data in **Postgres**.

- **Leads:** pipeline board and table. Each lead has a **region**, **reference**, source, value, owner and follow-up date, and records **who added it** and when. You can filter by region, and convert a lead to a client in one click.
- **Clients:** contact, region, reference and GSTIN. Each client page lists their projects, quotations, invoices and outstanding balance.
- **Projects and tasks:** status, budgets, deadlines, assignees, and a task board you can drag cards across.
- **Quotations and invoices:** line items, discount, GST/tax and automatic numbering. Quotations convert to invoices. You can record partial payments, and invoices are marked overdue automatically. Print or save as PDF, or download as HTML.
- **History:** every record shows who added it, who last changed it, and a full change history. The overview shows recent activity.
- **Multi-tenant:** each company is a tenant. Every user, record, setting and history entry has a `tenant_id`, and all reads and writes are limited to the signed-in user's tenant. Quotation and invoice numbers are unique within a tenant.
- **Accounts:** there is one **super admin**, created on first run. Only the super admin can add companies (tenants) and create, disable or reset user accounts, in Settings → Accounts. The super admin can switch between tenants from the sidebar. Tenant **administrators** manage their own company's settings. **Members** add and edit records. Only administrators or the person who added a record can delete it.
- **Settings:** company details, logo, brand colour, regions and lead sources, currency, and quotation/invoice prefixes.
- **Export:** CSV export for leads, clients, projects, quotations and invoices.

## Deploy to Vercel

1. Push this folder to a GitHub repository.
2. In Vercel, choose **Add New → Project**, import the repository and keep the default settings. `vercel.json` already sets things up.
3. In the project, open **Storage → Create Database → Neon (Postgres)**, create it and connect it to the project. This adds the `DATABASE_URL` environment variable for you.
4. **Redeploy** so the new variable takes effect: open Deployments, then ⋯ on the latest one, then Redeploy.
5. Open your site. On first visit you create the **super admin** account and the first company. The app creates its tables automatically. Then add companies and users in Settings → Accounts.

Any other Postgres works too, for example Supabase or your own server. Set `DATABASE_URL` in **Settings → Environment Variables**. For Neon or Supabase, use the *pooled* connection string.

## Run locally

Requires Node.js 22 or newer and a Postgres database (local, or a Neon branch).

```bash
cp .env.example .env        # then put your connection string in DATABASE_URL
npm install
npm run dev                 # http://localhost:3000
```

`npm start` runs it without file watching. The app also runs on any Node host or in Docker (`docker build -t crm . && docker run -p 3000:3000 -e DATABASE_URL=… crm`).

## Backups

All data lives in Postgres. Neon keeps point-in-time history on its plans. You can also take your own copy with `pg_dump "$DATABASE_URL" > backup.sql`.

## Project layout

```
app.js           API, sign-in, tenancy, database schema (shared by Vercel and local runs)
server.js        local entry point (app.listen)
api/index.js     Vercel serverless entry point
vercel.json      serves public/ as static files and routes /api/* to the function
public/          the interface: index.html, app.js, app.css (no build step)
```

To add a field to a record, add it to `ENTITIES` in `app.js`; the column is created automatically on the next request after deploy. Then add it to `FORMS` in `public/app.js`.
