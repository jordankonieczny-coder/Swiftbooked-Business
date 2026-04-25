import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id                   SERIAL PRIMARY KEY,
      twilio_number        VARCHAR(20)  UNIQUE NOT NULL,
      business_name        VARCHAR(100) NOT NULL,
      trade                VARCHAR(50)  DEFAULT 'trades',
      hours                VARCHAR(200) DEFAULT 'Mon–Fri 8am–5pm, Sat 9am–1pm',
      service_area         VARCHAR(200) DEFAULT 'Edmonton and surrounding area',
      callout_fee          VARCHAR(100),
      job1                 VARCHAR(200),
      job2                 VARCHAR(200),
      faq                  TEXT,
      owner_name           VARCHAR(100),
      owner_email          VARCHAR(100),
      owner_phone          VARCHAR(20),
      plan                 VARCHAR(20)  DEFAULT 'essential',
      active               BOOLEAN      DEFAULT true,
      created_at           TIMESTAMP    DEFAULT NOW(),
      google_refresh_token TEXT,
      password_hash        TEXT
    );
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS password_hash TEXT;

    CREATE TABLE IF NOT EXISTS leads (
      id             SERIAL PRIMARY KEY,
      client_id      INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      customer_phone VARCHAR(20) NOT NULL,
      messages       JSONB       DEFAULT '[]',
      status         VARCHAR(20) DEFAULT 'active',
      booking_id     VARCHAR(20),
      created_at     TIMESTAMP   DEFAULT NOW(),
      updated_at     TIMESTAMP   DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS leads_client_id_idx ON leads(client_id);
    CREATE INDEX IF NOT EXISTS leads_customer_phone_idx ON leads(customer_phone);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS widget_key VARCHAR(20) UNIQUE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(50);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS setup_token VARCHAR(64) UNIQUE;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS setup_token_expires TIMESTAMP;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS setup_completed BOOLEAN DEFAULT false;
    ALTER TABLE clients ALTER COLUMN twilio_number DROP NOT NULL;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS calendly_url VARCHAR(255);
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT false;
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS zapier_webhook_url TEXT;
  `);
  console.log("[DB] tables ready");
}

// ── Clients ───────────────────────────────────────────────────────────────────

export async function getClientByNumber(twilioNumber) {
  const { rows } = await pool.query(
    "SELECT * FROM clients WHERE twilio_number = $1 AND active = true",
    [twilioNumber]
  );
  return rows[0] || null;
}

export async function getAllClients() {
  const { rows } = await pool.query("SELECT * FROM clients ORDER BY created_at DESC");
  return rows;
}

export async function createClient(data) {
  const { rows } = await pool.query(
    `INSERT INTO clients
      (twilio_number, business_name, trade, hours, service_area,
       callout_fee, job1, job2, faq, owner_name, owner_email, owner_phone, plan)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      data.twilio_number, data.business_name, data.trade || "trades",
      data.hours, data.service_area, data.callout_fee || null,
      data.job1 || null, data.job2 || null, data.faq || null,
      data.owner_name || null, data.owner_email || null,
      data.owner_phone || null, data.plan || "essential",
    ]
  );
  return rows[0];
}

export async function updateClient(id, data) {
  const { rows } = await pool.query(
    `UPDATE clients SET
       twilio_number=$1, business_name=$2, trade=$3, hours=$4, service_area=$5,
       callout_fee=$6, job1=$7, job2=$8, faq=$9, owner_name=$10,
       owner_email=$11, owner_phone=$12, plan=$13, active=$14, calendly_url=$15
     WHERE id=$16 RETURNING *`,
    [
      data.twilio_number, data.business_name, data.trade, data.hours,
      data.service_area, data.callout_fee || null, data.job1 || null,
      data.job2 || null, data.faq || null, data.owner_name || null,
      data.owner_email || null, data.owner_phone || null,
      data.plan, data.active ?? true, data.calendly_url || null, id,
    ]
  );
  return rows[0];
}

export async function deleteClient(id) {
  await pool.query("DELETE FROM clients WHERE id = $1", [id]);
}

export async function saveCalendarToken(clientId, refreshToken) {
  const { rows } = await pool.query(
    "UPDATE clients SET google_refresh_token = $1 WHERE id = $2 RETURNING *",
    [refreshToken, clientId]
  );
  return rows[0];
}

export async function getClientByEmail(email) {
  const { rows } = await pool.query(
    "SELECT * FROM clients WHERE owner_email = $1 LIMIT 1",
    [email]
  );
  return rows[0] || null;
}

export async function setClientPassword(clientId, passwordHash) {
  await pool.query("UPDATE clients SET password_hash = $1 WHERE id = $2", [passwordHash, clientId]);
}

export async function createPartialClient(data) {
  const { rows } = await pool.query(
    `INSERT INTO clients
      (business_name, trade, owner_name, owner_email, owner_phone, plan, stripe_customer_id, active, is_demo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8)
     RETURNING *`,
    [
      data.business_name, data.trade || "trades",
      data.owner_name || null, data.owner_email || null,
      data.owner_phone || null, data.plan || "essential",
      data.stripe_customer_id || null,
      data.is_demo || false,
    ]
  );
  return rows[0];
}

export async function setSetupToken(clientId, token, expires) {
  await pool.query(
    "UPDATE clients SET setup_token=$1, setup_token_expires=$2 WHERE id=$3",
    [token, expires, clientId]
  );
}

export async function getClientBySetupToken(token) {
  const { rows } = await pool.query(
    "SELECT * FROM clients WHERE setup_token=$1 AND setup_token_expires > NOW()",
    [token]
  );
  return rows[0] || null;
}

export async function completeSetup(clientId, data, passwordHash) {
  const { rows } = await pool.query(
    `UPDATE clients SET
       trade=$1, hours=$2, service_area=$3, callout_fee=$4,
       job1=$5, job2=$6, faq=$7, owner_phone=$8,
       password_hash=$9, setup_completed=true,
       setup_token=NULL, setup_token_expires=NULL,
       calendly_url=$10
     WHERE id=$11 RETURNING *`,
    [
      data.trade, data.hours, data.service_area, data.callout_fee || null,
      data.job1 || null, data.job2 || null, data.faq || null,
      data.owner_phone || null, passwordHash,
      data.calendly_url || null, clientId,
    ]
  );
  return rows[0];
}

export async function setStripeCustomerId(clientId, stripeCustomerId) {
  await pool.query(
    "UPDATE clients SET stripe_customer_id = $1 WHERE id = $2",
    [stripeCustomerId, clientId]
  );
}

export async function deactivateClientByStripeId(stripeCustomerId) {
  const { rows } = await pool.query(
    "UPDATE clients SET active = false WHERE stripe_customer_id = $1 RETURNING *",
    [stripeCustomerId]
  );
  return rows[0] || null;
}

export async function getClientByWidgetKey(key) {
  const { rows } = await pool.query(
    "SELECT * FROM clients WHERE widget_key = $1 AND active = true",
    [key]
  );
  return rows[0] || null;
}

export async function activateClientWithNumber(clientId, twilioNumber) {
  const { rows } = await pool.query(
    "UPDATE clients SET twilio_number=$1, active=true WHERE id=$2 RETURNING *",
    [twilioNumber, clientId]
  );
  return rows[0];
}

export async function setWidgetKey(clientId, key) {
  const { rows } = await pool.query(
    "UPDATE clients SET widget_key = $1 WHERE id = $2 RETURNING *",
    [key, clientId]
  );
  return rows[0];
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export async function upsertLead(clientId, customerPhone, messages, status, bookingId) {
  const existing = await pool.query(
    "SELECT id FROM leads WHERE client_id = $1 AND customer_phone = $2 ORDER BY created_at DESC LIMIT 1",
    [clientId, customerPhone]
  );

  if (existing.rows.length) {
    const { rows } = await pool.query(
      `UPDATE leads SET messages=$1, status=$2, booking_id=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [JSON.stringify(messages), status, bookingId || null, existing.rows[0].id]
    );
    return rows[0];
  } else {
    const { rows } = await pool.query(
      `INSERT INTO leads (client_id, customer_phone, messages, status, booking_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [clientId, customerPhone, JSON.stringify(messages), status, bookingId || null]
    );
    return rows[0];
  }
}

export async function getAllLeads() {
  const { rows } = await pool.query(`
    SELECT l.*, c.business_name, c.trade
    FROM leads l
    LEFT JOIN clients c ON l.client_id = c.id
    ORDER BY l.updated_at DESC
  `);
  return rows;
}

export async function getLeadsByClient(clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM leads WHERE client_id = $1 ORDER BY updated_at DESC`,
    [clientId]
  );
  return rows;
}
