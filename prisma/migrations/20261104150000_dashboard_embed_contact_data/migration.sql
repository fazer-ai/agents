-- An embed link's "show contact data" (docs/dashboards.md, "Embed links"): whether a read through the
-- link carries the contact's name, phone and e-mail. Off for every link, the existing ones included.
ALTER TABLE "dashboard_embed_links" ADD COLUMN "show_contact_data" BOOLEAN NOT NULL DEFAULT false;
